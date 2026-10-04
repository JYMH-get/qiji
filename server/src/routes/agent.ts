import { logCreditDisplay } from '../logCreditDisplay.ts';
import { registerUsageReportRoutes } from './usageReports.ts';
import { registerCodeCleanupRoutes } from './codeCleanup.ts';
import { routeLogLabel } from '../routeLogDisplay.ts';
import { accessModes } from "../autoRouting.ts";
import { agentLinesView, saveAgentBusinessLine } from '../agentLines.ts';
import { registerAgentPortalSettings } from '../agentPortalSettings.ts';
/**
 * 渠道商门户：/agent（页面）+ /agent-api/*（账密会话鉴权）。
 *
 * 线路定价：源站决定该商进货价，门户设置名下用户售价与可用线路。
 * 免费签发兑换码；生成时同时扣用户售价及渠道商成本，失败分别退款。
 * 全部 API 按会话 agentId 隔离。页面与日志不暴露真实上游模型、协议或密钥。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
	verifyAgentLogin, createAgentSession, agentBySession, dropAgentSession,
	changeAgentCredits, getAgent, applyAgentFeatureGate,
	regenerateAgentNodeKey,
	agentSessionReadOnly,
	type Agent,
} from "../store/agents.ts";
import {
	usersByAgent, getUser, updateUser, deleteUser, dailySpentToday, type User,
	createUser, bindAccount, validateAccount, setUserPassword, genAccessKey, activeMembershipOf, applyMembershipGrant, revokeMembership,
	activeTeamCredits,
} from "../store/users.ts";
import { codesByAgent, getCode, createCodes, deleteCode, pruneInvalidCodes } from "../store/redeemCodes.ts";
import { settle } from '../store/credits.ts';
import { listLogs, getLog, exportLogs, logFacets, logSummary, logCostFor, logCodeIssue, type LogEntry, type LogMeta, type LogCostView } from "../store/logs.ts";
import { buildDownloadManifest, downloadManifestSummary, parseDownloadQuery } from "../store/assetExport.ts";
import { listTemplatesByAgent, listSharedPlatformTemplatesForAgent, getTemplateDef, createTemplate, updateTemplate, deleteTemplate } from "../store/templates.ts";
import { listPresets, listPresetsByAgent, getPresetDef, createPreset, updatePreset, deletePreset, type PresetDef } from '../store/presets.ts';
import { getMembershipPlan, setMembershipPlan, listMembershipCards, createMembershipCards, deleteMembershipCard } from '../store/membership.ts';
import {
	getLibrary as getSharedLibrary, listLibrariesByAudience, createLibrary as createSharedLibrary,
	updateLibrary as updateSharedLibrary, deleteLibrary as deleteSharedLibrary, libraryCounts,
	listFolders as listSharedFolders, getFolder as getSharedFolder, listFolderAssets as listSharedFolderAssets,
} from "../store/sharedLibs.ts";
import { getAsset } from "../store/assets.ts";
import { listTeams, effectiveTeamLimit, teamPaymentSource } from "../store/teams.ts";

declare module "fastify" {
	interface FastifyRequest {
		agent?: Agent;
	}
}

const here = dirname(fileURLToPath(import.meta.url));
const AGENT_HTML = join(here, "..", "agent", "index.html");

function bearer(req: FastifyRequest): string | undefined {
	const m = (req.headers.authorization ?? "").match(/^Bearer\s+(.+)$/i);
	return m?.[1]?.trim();
}

/** 「已注册」判定（P2b 全新语义）：注册体系下用户皆有账号；lastSeenAt 兜底登录留痕 */
const isActivated = (u: User): boolean => !!(u.account || u.lastSeenAt);

async function requireAgent(req: FastifyRequest, reply: FastifyReply): Promise<void> {
	const token = bearer(req);
	const agent = token ? agentBySession(token) : undefined;
	if (!agent) {
		await reply.code(401).send({ error: { message: "渠道商会话无效或已过期，请重新登录" } });
		return;
	}
	req.agent = agent;
	if (token && agentSessionReadOnly(token) && !['GET', 'HEAD'].includes(req.method) && req.url.split('?')[0] !== '/agent-api/logout') {
		await reply.code(403).send({ error: { message: '当前为源站查看会话，不能修改渠道商数据' } });
	}
}

/** 汇总一段时间窗内、指定用户集的每日消耗与请求量（渠道商统计用；成功才计消耗）。
 *  消耗口径（第220轮）：生成请求＝**名下用户实扣**（统一定价实时扣用户，logCostFor agent
 *  视角对无链记录取 cost）；发码划转/作废退回/渠道节点池扣（带 agentCosts）＝本商积分池那份。 */
function scopedDailyStats(userIds: string[], days: number, view: LogCostView) {
	const buckets: { date: string; requests: number; success: number; failed: number; credits: number }[] = [];
	const idx = new Map<string, number>();
	const base = Date.now();
	for (let i = days - 1; i >= 0; i--) {
		const date = new Date(base - i * 86400000).toISOString().slice(0, 10);
		idx.set(date, buckets.length);
		buckets.push({ date, requests: 0, success: 0, failed: 0, credits: 0 });
	}
	const from = base - days * 86400000;
	const { items } = listLogs({ userIds, ...(view.kind === 'agent' ? { owners: [view.agentId] } : {}), from, limit: 100000, offset: 0 });
	for (const l of items) {
		const d = (l.startedAt || "").slice(0, 10);
		const i = idx.get(d);
		if (i == null) continue;
		const b = buckets[i];
		b.requests++;
		if (l.status === "success") { b.success++; b.credits += logCostFor(l, view) || 0; }
		else if (l.status === "failed") { b.failed++; if(l.localExecution && l.localRefundOnFailure === false) b.credits += logCostFor(l, view) || 0; }
	}
	return buckets;
}

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
	// 门户页面（公开加载，页面内账密登录换 token）
	app.get("/agent", async (_req, reply) => {
		let html = readFileSync(AGENT_HTML, "utf8").replace('</body>', `<script>${readFileSync(new URL('../admin/agent-lines.js', import.meta.url), 'utf8')}</script><script>${readFileSync(new URL('../agent/portal-ui.js', import.meta.url), 'utf8')}</script></body>`);
		html = html.replace('</body>', `<script>${readFileSync(new URL('../admin/usage-reports.js', import.meta.url), 'utf8')}</script></body>`);
		return reply.header('Cache-Control', 'no-store').header("Content-Type", "text/html; charset=utf-8").send(html);
	});

	// 登录（公开）
	app.post("/agent-api/login", async (req, reply) => {
		const { account, password } = (req.body ?? {}) as { account?: string; password?: string };
		const r = verifyAgentLogin(account || "", password || "");
		if (!r.ok || !r.agent) return reply.code(401).send({ error: { message: r.error || "登录失败" } });
		const token = createAgentSession(r.agent.id);
		return { token, agent: { id: r.agent.id, name: r.agent.name, account: r.agent.account, credits: r.agent.credits } };
	});

	await app.register(async (api) => {
		api.addHook("preHandler", requireAgent);
		registerUsageReportRoutes(api, true);
		registerCodeCleanupRoutes(api, true);
		registerAgentPortalSettings(api);

		api.post("/agent-api/logout", async (req) => { const t = bearer(req); if (t) dropAgentSession(t); return { ok: true }; });

		// 门户概览：余额 + 名下统计
		api.get("/agent-api/me", async (req) => {
			const a = req.agent!;
			const us = usersByAgent(a.id);
			const cs = codesByAgent(a.id);
			return {
				id: a.id, name: a.name, account: a.account, credits: a.credits,
				readOnly: agentSessionReadOnly(bearer(req) ?? ''),
				balanceWarning: a.balanceWarningEnabled === true && a.credits <= (a.balanceWarningThreshold ?? 0),
				// P2b：渠道商邀请码——用户注册时填它即归属本商（替代激活码获客）
				inviteCode: a.inviteCode,
				userCount: us.length,
				activatedCount: us.filter(isActivated).length,
				todayActive: us.filter((u) => u.lastSeenAt && Date.now() - new Date(u.lastSeenAt).getTime() < 86400000).length,
				todaySpent: us.reduce((s, u) => s + dailySpentToday(u), 0),
				totalSpent: us.reduce((s, u) => s + (u.totalSpent || 0), 0),
				redeemCount: cs.length,
				redeemUsed: cs.filter((c) => c.used).length,
				// 第121轮：整商模式硬闸——门户按它隐藏被禁模式的开关
				features: applyAgentFeatureGate(a.id),
				// 第136轮：动态模式注册表（id/name）——门户用户管理的模式 chips/开关/签发勾选与源站同步
				modes: accessModes().map((m) => ({ id: m.id, name: m.name })),
			};
		});

		// ── 渠道节点密钥（P3 独立部署）：商自助查看/生成/重置 ank- 对接密钥 ──
		api.get("/agent-api/node-key", async (req) => ({ nodeKey: agentSessionReadOnly(bearer(req) ?? '') ? null : req.agent!.nodeKey ?? null }));
		api.post("/agent-api/node-key/regenerate", async (req, reply) => {
			const a = regenerateAgentNodeKey(req.agent!.id);
			if (!a) return reply.code(404).send({ error: { message: "渠道商不存在" } });
			return { ok: true, nodeKey: a.nodeKey };
		});

		// ── 名下用户 ──
		const own = (req: FastifyRequest, id: string): User | undefined => {
			const u = getUser(id);
			return u && u.agentId === req.agent!.id ? u : undefined;
		};
		const userView = (req: FastifyRequest, u: User) => {
			const { passwordHash, passwordSalt, accessKey, transferHistory, ...safe } = u;
			return { ...safe, ...(agentSessionReadOnly(bearer(req) ?? '') ? {} : { accessKey }), dailySpent: dailySpentToday(u), hasAccount: !!u.account };
		};
		const setCredits = (req: FastifyRequest, u: User, amount: number) => settle({
			reason: 'agent-user-credits', ref: `agent:${req.agent!.id}:${u.id}`, payerId: u.id, statsUserId: '', userAmount: -amount, agents: [],
		});
		api.get("/agent-api/users", async (req) => ({
			items: usersByAgent(req.agent!.id).map(u => userView(req, u)),
		}));
		api.get('/agent-api/users/:id', async (req, reply) => {
			const u = own(req, (req.params as { id: string }).id);
			return u ? userView(req, u) : reply.code(404).send({ error: { message: '用户不存在或不属于你' } });
		});
		api.post('/agent-api/users', async (req, reply) => {
			const b = (req.body ?? {}) as Record<string, unknown>;
			if (Object.keys(b).some(k => !['account', 'password', 'name', 'note', 'enabled', 'credits'].includes(k))) return reply.code(400).send({ error: { message: '不支持的用户字段' } });
			const account = typeof b.account === 'string' ? b.account.trim().toLowerCase() : '';
			if (account) {
				const valid = validateAccount(account);
				if (!valid.ok) return reply.code(400).send({ error: { message: valid.error } });
				if (typeof b.password !== 'string' || b.password.trim().length < 6 || b.password.length > 200) return reply.code(400).send({ error: { message: '密码需 6–200 位' } });
			}
			if (b.name !== undefined && typeof b.name !== 'string' || b.note !== undefined && typeof b.note !== 'string' || b.enabled !== undefined && typeof b.enabled !== 'boolean') return reply.code(400).send({ error: { message: '用户字段无效' } });
			const credits = b.credits ?? 0;
			if (typeof credits !== 'number' || !Number.isFinite(credits) || credits < 0 || credits > 1e12) return reply.code(400).send({ error: { message: '积分无效' } });
			const u = createUser({ name: (b.name as string | undefined)?.slice(0, 100), note: (b.note as string | undefined)?.slice(0, 2000), enabled: b.enabled as boolean | undefined, agentId: req.agent!.id, credits: 0 });
			if (account) bindAccount(u, account, b.password as string, b.name as string | undefined);
			if (credits) setCredits(req, u, credits);
			return userView(req, u);
		});
		api.post('/agent-api/users/:id/credits', async (req, reply) => {
			const u = own(req, (req.params as { id: string }).id);
			if (!u) return reply.code(404).send({ error: { message: '用户不存在或不属于你' } });
			const delta = (req.body as { delta?: unknown } | undefined)?.delta;
			if (typeof delta !== 'number' || !Number.isFinite(delta) || Math.abs(delta) > 1e12 || u.credits + delta < 0) return reply.code(400).send({ error: { message: '积分增减无效或超过当前余额' } });
			const result = setCredits(req, u, delta);
			if (!result.ok) return reply.code(400).send({ error: { message: result.error } });
			return { ok: true, credits: u.credits, balance: u.credits };
		});
		for (const action of ['reset-key', 'regenerate-key']) api.post(`/agent-api/users/:id/${action}`, async (req, reply) => {
			const u = own(req, (req.params as { id: string }).id);
			if (!u) return reply.code(404).send({ error: { message: '用户不存在或不属于你' } });
			return userView(req, updateUser(u.id, { accessKey: genAccessKey(), devices: [] })!);
		});
		api.post('/agent-api/users/:id/reset-password', async (req, reply) => {
			const u = own(req, (req.params as { id: string }).id);
			if (!u) return reply.code(404).send({ error: { message: '用户不存在或不属于你' } });
			if (!u.account) return reply.code(400).send({ error: { message: '该用户尚未绑定账号' } });
			const password = (req.body as { password?: unknown } | undefined)?.password;
			if (typeof password !== 'string' || password.length > 200) return reply.code(400).send({ error: { message: '密码无效' } });
			const result = setUserPassword(u, password);
			if (!result.ok) return reply.code(400).send({ error: { message: result.error } });
			return { ok: true };
		});
		api.post('/agent-api/users/:id/unbind-account', async (req, reply) => {
			const u = own(req, (req.params as { id: string }).id);
			if (!u) return reply.code(404).send({ error: { message: '用户不存在或不属于你' } });
			return userView(req, updateUser(u.id, { account: undefined, passwordSalt: undefined, passwordHash: undefined })!);
		});
		// Same user-management operations as the source, confined to the authenticated merchant's own customers.
		api.put("/agent-api/users/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			const user = own(req, id);
			if (!user) return reply.code(404).send({ error: { message: "用户不存在或不属于你" } });
			const b = (req.body ?? {}) as Record<string, unknown>;
			const fields = ['name', 'note', 'enabled', 'features', 'account', 'deviceLimit', 'favQuotaBytes', 'credits'];
			if (Object.keys(b).some(k => !fields.includes(k))) return reply.code(400).send({ error: { message: '不支持的用户字段' } });
			const patch: Record<string, unknown> = {};
			for (const k of ['name', 'note']) if (b[k] !== undefined) {
				if (typeof b[k] !== 'string' || b[k].length > (k === 'name' ? 100 : 2000)) return reply.code(400).send({ error: { message: '名称或备注格式无效' } });
				patch[k] = b[k];
			}
			if (b.enabled !== undefined) {
				if (typeof b.enabled !== 'boolean') return reply.code(400).send({ error: { message: '启用状态无效' } });
				patch.enabled = b.enabled;
			}
			for (const k of ['deviceLimit', 'favQuotaBytes']) if (b[k] !== undefined) {
				const value = b[k];
				if (value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > (k === 'deviceLimit' ? 1000 : 1e15))) return reply.code(400).send({ error: { message: '额度格式无效' } });
				patch[k] = value === null ? undefined : value;
			}
			if (b.account !== undefined) {
				if (typeof b.account !== 'string') return reply.code(400).send({ error: { message: '账号格式无效' } });
				const valid = validateAccount(b.account, id);
				if (!valid.ok) return reply.code(400).send({ error: { message: valid.error } });
				patch.account = b.account.trim().toLowerCase();
			}
			if (b.features !== undefined) {
				if (!b.features || typeof b.features !== 'object' || Array.isArray(b.features)) return reply.code(400).send({ error: { message: '功能开关无效' } });
				const f = b.features as Record<string, unknown>;
				const keys = ['dualMode', 'assetMode', 'canvasMode', 'editorMode', 'libtv', 'dreamina', 'comfyui', 'modes'];
				if (Object.keys(f).some(k => !keys.includes(k) || k !== 'modes' && typeof f[k] !== 'boolean') || f.modes !== undefined && (!f.modes || typeof f.modes !== 'object' || Array.isArray(f.modes) || Object.values(f.modes).some(v => typeof v !== 'boolean'))) return reply.code(400).send({ error: { message: '功能开关无效' } });
				patch.features = { ...user.features, ...f };
			}
			// 第130轮：门户改 features 未带 modes 时，沿用用户既有动态视频模式门禁，避免整体替换把源站设的 modes 清空
			if (patch.features && typeof patch.features === "object" && (patch.features as Record<string, unknown>).modes === undefined) {
				const cur = getUser(id)?.features?.modes;
				if (cur) (patch.features as Record<string, unknown>).modes = cur;
			}
			if (b.credits !== undefined) {
				if (typeof b.credits !== 'number' || !Number.isFinite(b.credits) || b.credits < 0 || b.credits > 1e12) return reply.code(400).send({ error: { message: '积分无效' } });
				const result = setCredits(req, user, b.credits - user.credits);
				if (!result.ok) return reply.code(400).send({ error: { message: result.error } });
			}
			return userView(req, updateUser(id, patch as Partial<User>)!);
		});
		// 删除名下用户：先按 agentId 校验归属；对范围外目标统一返回 404，避免泄露用户存在性。
		api.delete("/agent-api/users/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			if (!own(req, id)) return reply.code(404).send({ error: { message: "用户不存在或不属于你" } });
			if (!deleteUser(id)) return reply.code(404).send({ error: { message: "用户不存在或不属于你" } });
			return { ok: true };
		});
		// 批量操作名下用户：启停、模式开关、删除。每个 id 都单独做归属校验。
		api.post("/agent-api/users/batch-op", async (req, reply) => {
			const b = (req.body ?? {}) as { ids?: string[]; op?: string; modeId?: string; feature?: string; value?: boolean };
			const ids = Array.isArray(b.ids) ? b.ids.filter((x) => typeof x === "string") : [];
			if (!ids.length) return reply.code(400).send({ error: { message: "缺少用户 ids" } });
			if (!b.op) return reply.code(400).send({ error: { message: "缺少操作 op" } });
			if (!['enable', 'disable', 'delete', 'setFeature', 'setMode', 'unbind-devices'].includes(b.op)) return reply.code(400).send({ error: { message: '不支持的操作' } });
			if (b.op === 'setFeature' && !['dualMode', 'assetMode', 'canvasMode', 'editorMode', 'libtv', 'dreamina', 'comfyui'].includes(b.feature ?? '')) return reply.code(400).send({ error: { message: '不支持的功能开关' } });
			let affected = 0, skipped = 0;
			for (const id of ids) {
				const u = own(req, id);
				if (!u) { skipped++; continue; }
				switch (b.op) {
					case "enable": if (updateUser(id, { enabled: true })) affected++; break;
					case "disable": if (updateUser(id, { enabled: false })) affected++; break;
					case "delete": if (deleteUser(id)) affected++; break;
					case 'unbind-devices': if (updateUser(id, { devices: [] })) affected++; break;
					case "setFeature": { // 批量开关固定模式（assetMode/canvasMode/editorMode/libtv/dreamina/comfyui）
						if (!b.feature) break;
						const f: Record<string, unknown> = { dualMode: true, assetMode: true, canvasMode: true, editorMode: true, libtv: true, dreamina: true, comfyui: true, ...(u.features ?? {}) };
						f[b.feature] = b.value !== false;
						if (updateUser(id, { features: f as User["features"] })) affected++;
						break;
					}
					case "setMode": { // 批量开关动态模式（modes 注册表）
						if (!b.modeId) break;
						const f: User["features"] = { ...(u.features ?? {}), modes: { ...(u.features?.modes ?? {}), [b.modeId]: b.value !== false } };
						if (updateUser(id, { features: f })) affected++;
						break;
					}
					default: break;
				}
			}
			return { ok: true, affected, skipped };
		});
		// （P2b 移除：批量签发激活码 / 作废 / 解绑 / 重置激活码——激活码机制整体退役，
		//   获客改走**渠道商邀请码**（用户注册时填码即归属本商）、发积分走兑换码（面额实扣））

		// 免费签发兑换码；用户核销时充入面额，生成时再结算成本。旧码保留签发实扣退款依据。
		api.get("/agent-api/redeem-codes", async (req) => ({ items: codesByAgent(req.agent!.id) }));
		api.post("/agent-api/redeem-codes", async (req, reply) => {
			const a = req.agent!;
			const b = (req.body ?? {}) as { count?: number; credits?: number; expiresAt?: string; note?: string };
			const count = Math.max(1, Math.min(500, Math.floor(Number(b.count) || 1)));
			const credits = Number(b.credits);
			if (credits <= 0) return reply.code(400).send({ error: { message: "面额需 > 0" } });
			if (!Number.isSafeInteger(credits) || credits > 1e9) return reply.code(400).send({ error: { message: '面额超出范围' } });
			const items = createCodes({ count, credits, expiresAt: b.expiresAt, note: b.note, agentId: a.id, agentDebit: 0, prefix: a.redeemCodePrefix });
			logCodeIssue({
				agentId: a.id, agentName: a.name, tierLabel: `兑换码×${count}`, cost: 0,
				summary: { action: "签发兑换码", count, faceCredits: credits, transfer: 0 },
			});
			return { items, spent: 0, balance: getAgent(a.id)?.credits ?? 0 };
		});
		// 作废未使用兑换码：只退签发时实际支付的金额，新码为 0。
		api.delete("/agent-api/redeem-codes/:code", async (req, reply) => {
			const a = req.agent!;
			const { code } = req.params as { code: string };
			const rec = getCode(code);
			if (!rec || rec.agentId !== a.id) return reply.code(404).send({ error: { message: "兑换码不存在或不属于你" } });
			if (rec.used) return reply.code(400).send({ error: { message: "该兑换码已被使用，不能作废" } });
			deleteCode(code);
			const refund = Math.max(0, Math.floor(rec.agentDebit ?? rec.credits ?? 0));
			if (refund > 0) {
				changeAgentCredits(a.id, refund);
				logCodeIssue({
					agentId: a.id, agentName: a.name, tierLabel: "兑换码作废退回", cost: -refund,
					agentCosts: [{ id: a.id, cost: -refund }],
					summary: { action: "作废兑换码", refund },
				});
			}
			return { ok: true, refund, balance: getAgent(a.id)?.credits ?? 0 };
		});
		api.post('/agent-api/redeem-codes/prune', async req => {
			const result = pruneInvalidCodes(Date.now(), { agentId: req.agent!.id });
			for (const refund of result.agentRefunds) if (refund.credits > 0) {
				changeAgentCredits(req.agent!.id, refund.credits);
				logCodeIssue({ agentId: req.agent!.id, agentName: req.agent!.name, tierLabel: '过期兑换码退回', cost: -refund.credits, agentCosts: [{ id: req.agent!.id, cost: -refund.credits }] });
			}
			return result;
		});

		// ── 名下团队（只读；团队码 P1 起**仅源站签发**，门户签发端点已删除）──
		api.get("/agent-api/teams", async (req) => {
			const a = req.agent!;
			const mine = new Set(usersByAgent(a.id).map((u) => u.id));
			const items = listTeams().filter((t) => mine.has(t.leaderId) || t.memberIds.some(id => mine.has(id))).map((t) => {
				const leader = getUser(t.leaderId);
				const members = t.memberIds.map((id) => getUser(id)).filter((u): u is User => !!u);
				return {
					id: t.id, name: t.name, creditMode: t.creditMode, createdAt: t.createdAt,
					leader: leader ? { id: leader.id, name: leader.name || leader.account || "（未注册）", ...(mine.has(leader.id) ? { account: leader.account, credits: leader.credits } : {}) } : null,
					memberCount: members.length + (leader ? 1 : 0),
					effectiveLimit: effectiveTeamLimit(t),
					poolCredits: leader && mine.has(leader.id) ? leader.credits : null,
					allocatedCredits: members.reduce((s, u) => s + activeTeamCredits(u.id, t.id), 0),
					memberCredits: members.filter(u => mine.has(u.id)).reduce((s, u) => s + u.credits, 0),
					members: [leader, ...members].filter((u): u is User => !!u).map(u => ({ id: u.id, name: u.name || u.account || '用户', own: mine.has(u.id), paymentSource: teamPaymentSource(t, u.id), teamCredits: activeTeamCredits(u.id, t.id), ...(mine.has(u.id) ? { account: u.account, personalCredits: u.credits } : {}) })),
					sharedLibName: t.sharedLibId ? getSharedLibrary(t.sharedLibId)?.name : undefined,
				};
			});
			return { items };
		});

		// 已取消扩容卡，旧端点明确拒绝，禁止旧门户继续签发。
		api.get('/agent-api/storage-codes', async (_req, reply) => reply.code(410).send({ error: { message: '扩容卡已取消' } }));
		api.post('/agent-api/storage-codes', async (_req, reply) => reply.code(410).send({ error: { message: '扩容卡已取消' } }));
		api.delete('/agent-api/storage-codes/:code', async (_req, reply) => reply.code(410).send({ error: { message: '扩容卡已取消' } }));

		// ── 名下统计（daily=本商自身积分变动口径：发码划转/作废退回；生成请求不再扣商）──
		api.get("/agent-api/stats", async (req) => {
			const a = req.agent!;
			const us = usersByAgent(a.id);
			const days = Math.max(7, Math.min(90, Math.floor(Number((req.query as any).days) || 14)));
			const daily = scopedDailyStats(us.map((u) => u.id), days, { kind: "agent", agentId: a.id });
			const cs = codesByAgent(a.id);
			return {
				generatedAt: new Date().toISOString(),
				windowDays: days,
				credits: a.credits,
				userCount: us.length,
				activatedCount: us.filter(isActivated).length,
				todaySpent: us.reduce((s, u) => s + dailySpentToday(u), 0),
				totalSpent: us.reduce((s, u) => s + (u.totalSpent || 0), 0),
				redeemCount: cs.length,
				redeemUsed: cs.filter((c) => c.used).length,
				daily,
			};
		});

		// ── 模型（P1 统一定价：只读列表——价格恒为平台价，不可定价；可改显示名 + 本商启停）──
		// 只投影计费相关字段（不含协议/渠道/上游真名/密钥等接入信息），模型本身不可增删改。
		// 第110轮：只列平台对本渠道商开放（shareScope/分组）的模型——未开放的连只读也看不到；
		// 本商自己停用的模型仍显示（可再启用）。hidden 手续费模型也列出（用户按次扣手续费，商需知情）。
		api.get('/agent-api/models', async req => ({ items: agentLinesView(req.agent!.id, 'retail').rows }));
		api.get('/agent-api/lines', async (req, reply) => {
			reply.header('Cache-Control', 'no-store');
			return agentLinesView(req.agent!.id, 'retail');
		});
		api.put('/agent-api/lines/:lineId', async (req, reply) => {
			try { return saveAgentBusinessLine(req.agent!.id, (req.params as { lineId: string }).lineId, 'retail', req.body); }
			catch (e) { return reply.code((e as { statusCode?: number }).statusCode ?? 400).send({ error: { message: (e as Error).message } }); }
		});
		// 兼容旧页面入口也只允许操作公开线路，不再下发或修改上游模型。
		api.put('/agent-api/models/:id/label', async (req, reply) => {
			const row = agentLinesView(req.agent!.id, 'retail').rows.find(r => r.id === (req.params as { id: string }).id);
			if (!row) return reply.code(404).send({ error: { message: '线路不存在' } });
			try { return saveAgentBusinessLine(req.agent!.id, row.id, 'retail', { revision: row.revision, label: ((req.body ?? {}) as { label?: string }).label ?? '' }); }
			catch (error) { return reply.code(400).send({ error: { message: (error as Error).message } }); }
		});
		api.put('/agent-api/models/:id/access', async (req, reply) => {
			const row = agentLinesView(req.agent!.id, 'retail').rows.find(r => r.id === (req.params as { id: string }).id);
			if (!row) return reply.code(404).send({ error: { message: '线路不存在' } });
			try { return saveAgentBusinessLine(req.agent!.id, row.id, 'retail', { revision: row.revision, enabled: !((req.body ?? {}) as { blocked?: boolean }).blocked }); }
			catch (error) { return reply.code(400).send({ error: { message: (error as Error).message } }); }
		});

		// ── 自营提示词模板（每个渠道商管自己的；仅本 agent 可见/增删改；随 catalog 下发给其名下用户）──
		api.get("/agent-api/templates", async (req) => ({ items: listTemplatesByAgent(req.agent!.id) }));
		// 官方创作模板仅元信息；输出格式正文可见、只读。
		api.get("/agent-api/shared-templates", async (req) => ({
			items: listSharedPlatformTemplatesForAgent(req.agent!.id).map((t) => ({
				id: t.id, name: t.name, capability: t.capability, purpose: t.purpose, category: t.category,
				isDefault: t.isDefault, enabled: t.enabled, order: t.order,
				publicNote: t.publicNote,
				readonly: true, bodyHidden: !t.id.startsWith('output.'),
				...(t.id.startsWith('output.') ? { body: t.body, variables: t.variables } : {}),
			})),
		}));
		api.get('/agent-api/presets', async req => ({ items: [...listPresets(), ...listPresetsByAgent(req.agent!.id)].map(p => {
			const target = p.category === '预设方案' ? 'image' : p.category === '视频预设方案' ? 'video' : p.category === '画风' ? 'style' : 'other';
			const visible = !!p.agentId || target === 'image' || target === 'video';
			return { id: p.id, name: p.name, publicNote: p.publicNote, category: p.category, target, agentId: p.agentId, enabled: p.enabled, order: p.order, readonly: !p.agentId, bodyHidden: !visible,
				...(visible ? { body: p.body, images: p.images, position: p.position, group: p.group, autoAttach: p.autoAttach } : {}) };
		}) }));
		const presetPatch = (body: unknown): Partial<PresetDef> => {
			if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('预设内容无效');
			const b = body as Record<string, unknown>;
			const allowed = ['id', 'name', 'category', 'target', 'body', 'images', 'position', 'group', 'autoAttach', 'enabled', 'order'];
			if (Object.keys(b).some(k => !allowed.includes(k))) throw new Error('不支持的预设字段');
			const patch = { ...b } as Record<string, unknown>;
			delete patch.id; delete patch.target;
			if (b.target !== undefined) {
				const categories: Record<string, string> = { image: '预设方案', video: '视频预设方案', style: '画风', other: '其他' };
				if (!categories[String(b.target)]) throw new Error('预设分类无效');
				patch.category = categories[String(b.target)];
			}
			for (const key of ['name', 'category', 'body', 'group']) if (patch[key] !== undefined && (typeof patch[key] !== 'string' || (patch[key] as string).length > (key === 'body' ? 200000 : 100))) throw new Error('预设文字格式无效');
			if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw new Error('启用状态无效');
			if (patch.order !== undefined && (typeof patch.order !== 'number' || !Number.isFinite(patch.order))) throw new Error('排序无效');
			if (patch.images !== undefined && (!Array.isArray(patch.images) || patch.images.length > 20 || patch.images.some(x => typeof x !== 'string' || x.length > 2000000))) throw new Error('预设图片无效');
			return patch as Partial<PresetDef>;
		};
		api.post('/agent-api/presets', async (req, reply) => {
			try {
				const patch = presetPatch(req.body), rawId = String((req.body as { id?: unknown }).id ?? '').trim();
				if (!rawId || rawId.length > 120 || !patch.name?.trim()) throw new Error('缺少预设 ID 或名称');
				const prefix = `ag-${req.agent!.id.replace(/^ag_/, '')}-`, id = rawId.startsWith(prefix) ? rawId : prefix + rawId;
				if (getPresetDef(id)) return reply.code(409).send({ error: { message: '预设 ID 已存在' } });
				return createPreset({ ...patch, id, name: patch.name.trim(), agentId: req.agent!.id });
			} catch (error) { return reply.code(400).send({ error: { message: (error as Error).message } }); }
		});
		api.put('/agent-api/presets/:id', async (req, reply) => {
			const id = (req.params as { id: string }).id, preset = getPresetDef(id);
			if (!preset || preset.agentId !== req.agent!.id) return reply.code(404).send({ error: { message: '预设不存在或不可编辑' } });
			try { return updatePreset(id, presetPatch(req.body)); }
			catch (error) { return reply.code(400).send({ error: { message: (error as Error).message } }); }
		});
		api.delete('/agent-api/presets/:id', async (req, reply) => {
			const id = (req.params as { id: string }).id, preset = getPresetDef(id);
			if (!preset || preset.agentId !== req.agent!.id) return reply.code(404).send({ error: { message: '预设不存在或不可编辑' } });
			deletePreset(id);
			return { ok: true };
		});
		api.post("/agent-api/templates", async (req, reply) => {
			const b = (req.body ?? {}) as Partial<import("../store/templates.ts").TemplateDef>;
			if (!b.id || !b.name || !b.capability) return reply.code(400).send({ error: { message: "缺少 id/name/capability" } });
			// id 命名空间隔离：强制加渠道商前缀，避免与平台/他人模板 id 撞车（撞车会被 upsert 覆盖）
			const prefix = "ag-" + req.agent!.id.replace(/^ag_/, "") + "-";
			const id = String(b.id).startsWith(prefix) ? String(b.id) : prefix + String(b.id).trim();
			if (getTemplateDef(id)) return reply.code(409).send({ error: { message: "模板 id 已存在" } });
			const { agentId, ...rest } = b;
			return createTemplate({ ...rest, id, agentId: req.agent!.id } as any);
		});
		const ownTpl = (req: FastifyRequest, id: string) => { const t = getTemplateDef(id); return t && t.agentId === req.agent!.id ? t : undefined; };
		api.put("/agent-api/templates/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			if (!ownTpl(req, id)) return reply.code(404).send({ error: { message: "模板不存在或不属于你" } });
			const { agentId, id: _i, ...rest } = (req.body ?? {}) as Record<string, unknown>; // 不许改归属/id
			return updateTemplate(id, rest as any)!;
		});
		api.delete("/agent-api/templates/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			if (!ownTpl(req, id)) return reply.code(404).send({ error: { message: "模板不存在或不属于你" } });
			deleteTemplate(id);
			return { ok: true };
		});

		// 会员共用同一制度实现，方案、卡与权益按签发方隔离。
		api.get('/agent-api/membership', async req => {
			const members = usersByAgent(req.agent!.id).flatMap(u => {
				const membership = activeMembershipOf(u);
				return membership ? [{ id: u.id, name: u.name, account: u.account, credits: u.credits, membership, ...membership }] : [];
			});
			const cards = listMembershipCards(req.agent!.id);
			return { plan: getMembershipPlan(req.agent!.id), items: members, members, cards: cards.slice(0, 300), stats: { members: members.length, cardsTotal: cards.length, cardsUsed: cards.filter(c => c.usedBy).length } };
		});
		api.put('/agent-api/membership/plan', async req => ({ ok: true, plan: setMembershipPlan((req.body ?? {}) as Record<string, unknown>, req.agent!.id) }));
		api.post('/agent-api/membership/cards', async req => {
			const b = (req.body ?? {}) as { count?: number; note?: string };
			return { items: createMembershipCards(Number(b.count) || 1, b.note, req.agent!.id) };
		});
		api.delete('/agent-api/membership/cards/:code', async (req, reply) => {
			const result = deleteMembershipCard((req.params as { code: string }).code, req.agent!.id);
			if (!result.ok) return reply.code(400).send({ error: { message: result.error } });
			return { ok: true };
		});
		api.post('/agent-api/membership/grant', async (req, reply) => {
			const u = own(req, String((req.body as { userId?: unknown } | undefined)?.userId ?? ''));
			if (!u) return reply.code(404).send({ error: { message: '用户不存在或不属于你' } });
			const plan = getMembershipPlan(req.agent!.id);
			const membership = applyMembershipGrant(u.id, { planName: plan.name, days: plan.days, discountPercent: plan.discountPercent });
			if (plan.credits > 0) setCredits(req, u, plan.credits);
			return { ok: true, membership, added: plan.credits };
		});
		api.delete('/agent-api/membership/members/:userId', async (req, reply) => {
			const u = own(req, (req.params as { userId: string }).userId);
			if (!u || !revokeMembership(u.id)) return reply.code(404).send({ error: { message: '用户不存在或非会员' } });
			return { ok: true };
		});

		// ── 共享素材库（第120轮）：本商自营（ownerAudience=本商 id），名下用户凭密码加入后可增文件夹/素材 ──
		const requireSharedLib = (req: FastifyRequest, reply: FastifyReply): boolean => {
			if (req.agent!.allowSharedLib === false) {
				void reply.code(403).send({ error: { message: "共享素材库未对你开放，请联系管理员" } });
				return false;
			}
			return true;
		};
		const ownLib = (req: FastifyRequest, id: string) => {
			const l = getSharedLibrary(id);
			return l && l.ownerAudience === req.agent!.id ? l : undefined;
		};
		const sharedLibView = (l: { id: string; name: string; enabled: boolean; createdAt: string }) => ({
			id: l.id, name: l.name, enabled: l.enabled, createdAt: l.createdAt, ...libraryCounts(l.id),
		});
		api.get("/agent-api/shared-libs", async (req, reply) => {
			if (!requireSharedLib(req, reply)) return;
			return { items: listLibrariesByAudience(req.agent!.id).map(sharedLibView) };
		});
		api.post("/agent-api/shared-libs", async (req, reply) => {
			if (!requireSharedLib(req, reply)) return;
			const { name, password } = (req.body ?? {}) as { name?: string; password?: string };
			const r = createSharedLibrary({ name, password, ownerAudience: req.agent!.id });
			if (!r.ok) return reply.code(400).send({ error: { message: r.error } });
			return { ok: true, library: sharedLibView(r.library) };
		});
		api.put("/agent-api/shared-libs/:id", async (req, reply) => {
			if (!requireSharedLib(req, reply)) return;
			const l = ownLib(req, (req.params as { id: string }).id);
			if (!l) return reply.code(404).send({ error: { message: "共享库不存在或不属于你" } });
			const { name, password, enabled } = (req.body ?? {}) as { name?: string; password?: string; enabled?: boolean };
			const r = updateSharedLibrary(l.id, { name, password, enabled });
			if (!r.ok) return reply.code(400).send({ error: { message: r.error } });
			return { ok: true, library: sharedLibView(r.library) };
		});
		api.delete("/agent-api/shared-libs/:id", async (req, reply) => {
			if (!requireSharedLib(req, reply)) return;
			const l = ownLib(req, (req.params as { id: string }).id);
			if (!l) return reply.code(404).send({ error: { message: "共享库不存在或不属于你" } });
			deleteSharedLibrary(l.id);
			return { ok: true };
		});
		// 详情（只读预览，仅本商的库）：文件夹列表 + 按文件夹取素材记录——预览直连 OSS 直链，不代理不落盘
		api.get("/agent-api/shared-libs/:id/folders", async (req, reply) => {
			if (!requireSharedLib(req, reply)) return;
			const l = ownLib(req, (req.params as { id: string }).id);
			if (!l) return reply.code(404).send({ error: { message: "共享库不存在或不属于你" } });
			return { items: listSharedFolders(l.id).map((f) => ({ id: f.id, name: f.name, count: f.count, by: f.by, createdAt: f.createdAt })) };
		});
		api.get("/agent-api/shared-folders/:id/assets", async (req, reply) => {
			if (!requireSharedLib(req, reply)) return;
			const folder = getSharedFolder((req.params as { id: string }).id);
			const l = folder ? ownLib(req, folder.libraryId) : undefined;
			if (!folder || !l) return reply.code(404).send({ error: { message: "文件夹不存在或不属于你的共享库" } });
			return {
				items: listSharedFolderAssets(folder.id).map((a) => ({
					id: a.id, assetId: a.assetId,
					url: (a.assetId && getAsset(a.assetId)?.url) || a.url,
					name: a.name, mime: a.mime, by: a.by, createdAt: a.createdAt,
				})),
			};
		});

		// ── 请求记录（P1 拍平后范围=本商归属；第220轮消耗口径改「名下用户实扣」）──
		//  - 范围 = ownerId 落笔固化 ∈ [本商]（第198轮语义不变，链拍平后只剩本商一级）；
		//  - userCost 为用户售价实扣，cost 为本商进货实扣；两侧汇总独立，失败不计消耗。
		//  - agentCosts 数组绝不下发，详情仅开放 ①②段（③④上游报文不可见）。
		const myCostView = (req: FastifyRequest): LogCostView => ({ kind: "agent", agentId: req.agent!.id });
		/** 门户日志投影：消耗=本商实扣；剥掉 agentCosts（保密） */
		const agentLogView = (l: LogMeta, view: LogCostView) => {
			const { agentCosts, userWallet, ...rest } = l;
            const credit = logCreditDisplay(l);
            const cost = logCostFor(l, view) ?? 0;
            return { ...rest, modelLabel: routeLogLabel(l, 'user'), creditUserName: credit.creditUserName,
                creditSourceLabel: credit.creditSourceLabel, userCost: l.cost, cost, creditChain: [
                credit.creditChain[0],
                { kind: 'agent', label: '本商成本', amount: cost, domain: '本渠道商' },
            ] };
		};
		api.get("/agent-api/logs/facets", async (req) => {
			const g = logFacets({ owners: [req.agent!.id] });
			return { users: g.users, purposes: g.purposes, models: g.models };
		});
		api.get("/agent-api/logs/summary", async (req) => {
			const q = req.query as Record<string, string | undefined>;
			const num = (v?: string) => (v != null && v !== "" ? Number(v) : undefined);
			const status = q.status === "success" || q.status === "failed" || q.status === "running" ? q.status : undefined;
			const filter: Parameters<typeof logSummary>[0] = { owners: [req.agent!.id], from: num(q.from), to: num(q.to), userName: q.user || undefined, purpose: q.purpose || undefined, model: q.model || undefined, status };
			return { ...logSummary(filter, myCostView(req)), userCredits: logSummary(filter, { kind: 'user' }).credits };
		});
		api.get("/agent-api/logs/export", async (req) => {
			const q = req.query as Record<string, string | undefined>;
			const num = (v?: string) => (v != null && v !== "" ? Number(v) : undefined);
			const status = q.status === "success" || q.status === "failed" || q.status === "running" ? q.status : undefined;
			return { items: exportLogs({ owners: [req.agent!.id], from: num(q.from), to: num(q.to), userName: q.user || undefined, purpose: q.purpose || undefined, model: q.model || undefined, status }, myCostView(req), l => ({ creditUserName: logCreditDisplay(l).creditUserName, creditSourceLabel: logCreditDisplay(l).creditSourceLabel, model: routeLogLabel(l, 'user') || l.model || '' })) };
		});
		// 批量下载清单（第232轮）：范围恒为本商归属（owners 强制覆盖，不受查询串影响）；
		// 单用户视图可另传 ?userId= 收窄（与 logs 同语义：范围外 userId 天然空集）。
		api.get("/agent-api/downloads/manifest", async (req) => {
			const q = req.query as Record<string, string | undefined>;
			return buildDownloadManifest({
				...parseDownloadQuery(q),
				storages: undefined,
				owners: [req.agent!.id],
				...(q.userId ? { userIds: [q.userId] } : {}),
			});
		});
		api.get("/agent-api/downloads/summary", async (req) => {
			const q = req.query as Record<string, string | undefined>;
			return downloadManifestSummary({
				...parseDownloadQuery(q),
				storages: undefined,
				owners: [req.agent!.id],
				...(q.userId ? { userIds: [q.userId] } : {}),
			});
		});
		api.get("/agent-api/logs", async (req) => {
			const q = req.query as Record<string, string | undefined>;
			// 单用户视图（第121轮）：owners 定归属范围 + userIds 收窄（AND）——范围外 userId 天然空集不泄露；
			// 单用户视图下开码日志（无 userId）被 userIds 过滤天然排除。
			const singleUser = !!q.userId;
			const num = (v?: string) => (v != null && v !== "" ? Number(v) : undefined);
			const status = q.status === "success" || q.status === "failed" || q.status === "running" ? q.status : undefined;
			const view = myCostView(req);
			const r = listLogs({ owners: [req.agent!.id], userIds: singleUser ? [q.userId!] : undefined, limit: num(q.limit) ?? 50, offset: num(q.offset) ?? 0, from: num(q.from), to: num(q.to), userName: q.user || undefined, purpose: q.purpose || undefined, model: q.model || undefined, status });
			return { total: r.total, items: r.items.map((l) => agentLogView(l, view)) };
		});
		api.get("/agent-api/logs/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			const log = getLog(id);
			// 归属（落笔固化）=本商才可看；无归属（平台直属/查无归属的存量）一律 404
			if (!log || log.ownerId !== req.agent!.id) return reply.code(404).send({ error: { message: "记录不存在" } });
			// 只返回 ①②段（用户请求 / 返回结果）；上游报文与 agentCosts 对渠道商隐藏
			const { upstreamRequest, upstreamResponse, routing, agentCosts, userWallet, ...safe } = log as LogEntry & Record<string, unknown>;
			return { ...safe, ...agentLogView(safe as LogMeta, myCostView(req)), cost: logCostFor(log, myCostView(req)) ?? 0,
				creditUserName: logCreditDisplay(log).creditUserName, creditSourceLabel: logCreditDisplay(log).creditSourceLabel, creditChain: agentLogView(log, myCostView(req)).creditChain };
		});
	});
}
