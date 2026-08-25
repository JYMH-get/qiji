/**
 * 渠道商门户：/agent（页面）+ /agent-api/*（账密会话鉴权）。
 *
 * P1 经济模型翻转（2026-08 商业化改造，方案见 docs/商业化改造方案.md，⚠ 勿回退旧模式）：
 *  - **统一定价**：模型价格恒为源站平台价，门户不再有任何定价能力（售价/结算价/签发价/默认下级价全删）；
 *  - **预购积分池 + 分发实扣**：渠道商积分由源站分发（买积分）；给名下用户发积分
 *    （兑换码/激活码的**面额**）时按 面额×数量 从本商积分池真实划转，作废未用原路退回；
 *  - **签发免费**：开码积分退役，激活码/扩容卡签发不再收「开码费」；团队码改**仅源站签发**（门户端点删除）；
 *  - **层级拍平**：下游渠道商体系退役（sub-agents 全组端点删除），所有渠道商平级由源站管理。
 * 所有数据仍强制按 agentId 隔离：只能看/管自己名下的用户、自己签发的码、名下用户的请求记录。
 * 模型只读可见（可改显示名 + 本商启停），不可编辑模型与价格。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
	verifyAgentLogin, createAgentSession, agentBySession, dropAgentSession,
	changeAgentCredits, getAgent, applyAgentFeatureGate, setAgentModelLabel, setAgentModelAccess,
	regenerateAgentNodeKey,
	type Agent,
} from "../store/agents.ts";
import { listEnabledModels, getModelDef, modelVisibleToAgent, type ModelDef } from "../store/models.ts";
import { getChannel } from "../store/channels.ts";
import { listModes, modeName } from "../store/modes.ts";
import {
	usersByAgent, getUser, updateUser, dailySpentToday, type User,
} from "../store/users.ts";
import { codesByAgent, getCode, createCodes, deleteCode } from "../store/redeemCodes.ts";
import { listLogs, getLog, exportLogs, logFacets, logSummary, logCostFor, logCodeIssue, type LogEntry, type LogMeta, type LogCostView } from "../store/logs.ts";
import { buildDownloadManifest, downloadManifestSummary, parseDownloadQuery } from "../store/assetExport.ts";
import { listTemplatesByAgent, listSharedPlatformTemplatesForAgent, getTemplateDef, createTemplate, updateTemplate, deleteTemplate } from "../store/templates.ts";
import {
	getLibrary as getSharedLibrary, listLibrariesByAudience, createLibrary as createSharedLibrary,
	updateLibrary as updateSharedLibrary, deleteLibrary as deleteSharedLibrary, libraryCounts,
	listFolders as listSharedFolders, getFolder as getSharedFolder, listFolderAssets as listSharedFolderAssets,
} from "../store/sharedLibs.ts";
import { getAsset } from "../store/assets.ts";
import { listTeams, effectiveTeamLimit } from "../store/teams.ts";
import { getStorageCodeSpec } from "../store/settings.ts";
import { listStorageCodesByAgent, getStorageCode, createStorageCodes, deleteStorageCode } from "../store/storageCodes.ts";

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
	const { items } = listLogs({ userIds, from, limit: 100000, offset: 0 });
	for (const l of items) {
		const d = (l.startedAt || "").slice(0, 10);
		const i = idx.get(d);
		if (i == null) continue;
		const b = buckets[i];
		b.requests++;
		if (l.status === "success") { b.success++; b.credits += logCostFor(l, view) || 0; }
		else if (l.status === "failed") b.failed++;
	}
	return buckets;
}

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
	// 门户页面（公开加载，页面内账密登录换 token）
	app.get("/agent", async (_req, reply) => {
		const html = readFileSync(AGENT_HTML, "utf8");
		return reply.header("Content-Type", "text/html; charset=utf-8").send(html);
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

		api.post("/agent-api/logout", async (req) => { const t = bearer(req); if (t) dropAgentSession(t); return { ok: true }; });

		// 门户概览：余额 + 名下统计
		api.get("/agent-api/me", async (req) => {
			const a = req.agent!;
			const us = usersByAgent(a.id);
			const cs = codesByAgent(a.id);
			return {
				id: a.id, name: a.name, account: a.account, credits: a.credits,
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
				modes: listModes().map((m) => ({ id: m.id, name: m.name })),
			};
		});

		// ── 渠道节点密钥（P3 独立部署）：商自助查看/生成/重置 ank- 对接密钥 ──
		api.get("/agent-api/node-key", async (req) => ({ nodeKey: req.agent!.nodeKey ?? null }));
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
		api.get("/agent-api/users", async (req) => ({
			items: usersByAgent(req.agent!.id).map((u) => ({ ...u, dailySpent: dailySpentToday(u), totalSpent: u.totalSpent || 0 })),
		}));
		// 仅允许改有限字段（名/备注/启停/可用模式）——不许改积分（积分是发码时划转的）
		api.put("/agent-api/users/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			if (!own(req, id)) return reply.code(404).send({ error: { message: "用户不存在或不属于你" } });
			const b = (req.body ?? {}) as Record<string, unknown>;
			const patch: Record<string, unknown> = {};
			for (const k of ["name", "note", "enabled", "features"]) if (b[k] !== undefined) patch[k] = b[k];
			// 第130轮：门户改 features 未带 modes 时，沿用用户既有动态视频模式门禁，避免整体替换把源站设的 modes 清空
			if (patch.features && typeof patch.features === "object" && (patch.features as Record<string, unknown>).modes === undefined) {
				const cur = getUser(id)?.features?.modes;
				if (cur) (patch.features as Record<string, unknown>).modes = cur;
			}
			return updateUser(id, patch as any)!;
		});
		// 批量操作名下用户（P2b 全新语义：启停 + 模式开关；删除/解绑/作废随激活码机制整体移除——
		// 用户是自助注册的真实账号，由源站管理端删除）
		api.post("/agent-api/users/batch-op", async (req, reply) => {
			const b = (req.body ?? {}) as { ids?: string[]; op?: string; modeId?: string; feature?: string; value?: boolean };
			const ids = Array.isArray(b.ids) ? b.ids.filter((x) => typeof x === "string") : [];
			if (!ids.length) return reply.code(400).send({ error: { message: "缺少用户 ids" } });
			if (!b.op) return reply.code(400).send({ error: { message: "缺少操作 op" } });
			let affected = 0, skipped = 0;
			for (const id of ids) {
				const u = own(req, id);
				if (!u) { skipped++; continue; }
				switch (b.op) {
					case "enable": if (updateUser(id, { enabled: true })) affected++; break;
					case "disable": if (updateUser(id, { enabled: false })) affected++; break;
					case "setFeature": { // 批量开关固定模式（assetMode/canvasMode/editorMode/libtv/dreamina/comfyui）
						if (!b.feature) break;
						const f: Record<string, unknown> = { assetMode: true, canvasMode: true, editorMode: true, libtv: true, dreamina: true, comfyui: true, ...(u.features ?? {}) };
						f[b.feature] = b.value !== false;
						if (f.assetMode === false && f.canvasMode === false && f.editorMode === false) { skipped++; break; } // 资产+画布+实时剪辑不能全关
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

		// ── 名下兑换码（P1 分发实扣，⚠ 勿回退「签发不扣」）：签发=面额×数量 从本商积分池划转，
		// 作废未用原路退回；用户核销时把面额充入其余额（grantCredits，既有语义不变）──
		api.get("/agent-api/redeem-codes", async (req) => ({ items: codesByAgent(req.agent!.id) }));
		api.post("/agent-api/redeem-codes", async (req, reply) => {
			const a = req.agent!;
			const b = (req.body ?? {}) as { count?: number; credits?: number; expiresAt?: string; note?: string };
			const count = Math.max(1, Math.min(500, Math.floor(Number(b.count) || 1)));
			const credits = Math.max(1, Math.floor(Number(b.credits) || 0));
			if (credits <= 0) return reply.code(400).send({ error: { message: "面额需 > 0" } });
			const total = credits * count;
			const r = changeAgentCredits(a.id, -total);
			if (!r.ok) {
				return reply.code(402).send({ error: { message: `积分不足：生成 ${count} 枚面额 ${credits} 的兑换码需划转 ${total}，当前余额 ${a.credits}` } });
			}
			const items = createCodes({ count, credits, expiresAt: b.expiresAt, note: b.note, agentId: a.id });
			logCodeIssue({
				agentId: a.id, agentName: a.name, tierLabel: `兑换码×${count}`, cost: total,
				agentCosts: [{ id: a.id, cost: total }],
				summary: { action: "签发兑换码", count, faceCredits: credits, transfer: total },
			});
			return { items, spent: total, balance: getAgent(a.id)?.credits ?? 0 };
		});
		// 作废未使用兑换码：面额退回本商积分池（P1；已使用不可作废）
		api.delete("/agent-api/redeem-codes/:code", async (req, reply) => {
			const a = req.agent!;
			const { code } = req.params as { code: string };
			const rec = getCode(code);
			if (!rec || rec.agentId !== a.id) return reply.code(404).send({ error: { message: "兑换码不存在或不属于你" } });
			if (rec.used) return reply.code(400).send({ error: { message: "该兑换码已被使用，不能作废" } });
			deleteCode(code);
			const refund = Math.max(0, Math.floor(rec.credits || 0));
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

		// ── 名下团队（只读；团队码 P1 起**仅源站签发**，门户签发端点已删除）──
		api.get("/agent-api/teams", async (req) => {
			const a = req.agent!;
			const mine = new Set(usersByAgent(a.id).map((u) => u.id));
			const items = listTeams().filter((t) => mine.has(t.leaderId)).map((t) => {
				const leader = getUser(t.leaderId);
				const members = t.memberIds.map((id) => getUser(id)).filter((u): u is User => !!u);
				return {
					id: t.id, name: t.name, creditMode: t.creditMode, createdAt: t.createdAt,
					leader: leader ? { id: leader.id, name: leader.name || leader.account || "（未注册）", account: leader.account, credits: leader.credits } : null,
					memberCount: members.length + (leader ? 1 : 0),
					effectiveLimit: effectiveTeamLimit(t),
					poolCredits: leader?.credits ?? 0,
					memberCredits: members.reduce((s, u) => s + (u.credits || 0), 0),
					sharedLibName: t.sharedLibId ? getSharedLibrary(t.sharedLibId)?.name : undefined,
				};
			});
			return { items };
		});

		// ── 扩容卡（P1 商业化改造：签发**免费**——开码积分退役；规格由源站统一配置、冻结进卡）──
		api.get("/agent-api/storage-codes", async (req) => {
			const a = req.agent!;
			return {
				items: listStorageCodesByAgent(a.id),
				specs: { user: getStorageCodeSpec("user"), team: getStorageCodeSpec("team") },
			};
		});
		api.post("/agent-api/storage-codes", async (req) => {
			const a = req.agent!;
			const b = (req.body ?? {}) as { count?: number; note?: string; target?: string };
			const target: "user" | "team" = b.target === "team" ? "team" : "user";
			const count = Math.max(1, Math.min(200, Math.floor(Number(b.count) || 1)));
			const spec = getStorageCodeSpec(target);
			// 免费签发也留痕（cost=0）：门户/源站请求记录可审计签发行为
			logCodeIssue({
				agentId: a.id, agentName: a.name, tierLabel: `扩容卡（${target === "team" ? "团队" : "个人"}）×${count}`, cost: 0,
				summary: { action: "生成扩容卡", target, count, bytes: spec.bytes, days: spec.days },
			});
			// ⚠ 规格冻结进卡（bytes/days）——事后管理端调档不改变已签发的卡
			const items = createStorageCodes(count, target, { bytes: spec.bytes, days: spec.days }, { note: b.note, agentId: a.id });
			return { items };
		});
		api.delete("/agent-api/storage-codes/:code", async (req, reply) => {
			const { code } = req.params as { code: string };
			const rec = getStorageCode(code);
			if (!rec || rec.agentId !== req.agent!.id) return reply.code(404).send({ error: { message: "扩容卡不存在或不属于你" } });
			const r = deleteStorageCode(code);
			if (!r.ok) return reply.code(400).send({ error: { message: r.error } });
			return { ok: true };
		});

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
		const modelFromAbove = (m: ModelDef | undefined, a: Agent): m is ModelDef => !!m && modelVisibleToAgent(m, a.id);
		api.get("/agent-api/models", async (req) => {
			const a = req.agent!;
			return {
				items: listEnabledModels().filter((m) => modelFromAbove(m, a)).map((m) => ({
					id: m.id,
					label: m.label,
					// 第138轮：模型显示名改名——myLabel=本商自设（对名下用户 catalog 生效；空=平台名）
					myLabel: a.modelLabels?.[m.id],
					capability: m.capability,
					hidden: !!m.hidden,
					// 第140轮：本商自己的停用态（hidden 恒不可停）+ 渠道信息（门户按渠道分组用，仅名称）
					myBlocked: !m.hidden && (a.blockedModels ?? []).includes(m.id),
					channelId: m.channelId,
					channelName: m.channelId ? (getChannel(m.channelId)?.name || m.channelId) : undefined,
					modeId: m.modeId,
					modeName: m.modeId ? modeName(m.modeId) : undefined,
					// 平台统一价（只读展示）
					cost: m.cost,
					costField: m.costField,
					costPerUnit: m.costPerUnit,
					costRules: (m.routes ?? []).map((r) => ({ when: r.when, cost: r.cost, costPerUnit: r.costPerUnit })),
				})),
			};
		});
		// 第138轮：改模型显示名（只影响名下用户 catalog 的 label 与门户展示；空=清除回退平台名）。
		// bump pricingVersion → 用户客户端 ≤30s 热更新名字；计费/协议/模型 id 一概不变。
		api.put("/agent-api/models/:id/label", async (req, reply) => {
			const { id } = req.params as { id: string };
			const m = getModelDef(id);
			if (!modelFromAbove(m, req.agent!)) return reply.code(404).send({ error: { message: "模型不存在" } });
			const r = setAgentModelLabel(req.agent!.id, id, ((req.body ?? {}) as { label?: string | null }).label ?? null);
			if (!r.ok) return reply.code(400).send({ error: { message: r.error || "保存失败" } });
			return { ok: true, myLabel: r.label };
		});
		// 第140轮：渠道商启用/禁用自己权限范围内的模型——写**自己的** blockedModels；
		// 名下用户 catalog 隐藏 + generate/batch 403；解禁即恢复。bump pricingVersion → 用户端 ≤30s 热更。
		api.put("/agent-api/models/:id/access", async (req, reply) => {
			const { id } = req.params as { id: string };
			const m = getModelDef(id);
			if (!modelFromAbove(m, req.agent!)) return reply.code(404).send({ error: { message: "模型不存在" } });
			if (m.hidden) return reply.code(400).send({ error: { message: "内部计费模型不可禁用（会打断你名下用户的手续费扣费）" } });
			const blocked = !!((req.body ?? {}) as { blocked?: boolean }).blocked;
			const r = setAgentModelAccess(req.agent!.id, id, blocked);
			if (!r.ok) return reply.code(400).send({ error: { message: r.error || "保存失败" } });
			return { ok: true, blocked };
		});

		// ── 自营提示词模板（每个渠道商管自己的；仅本 agent 可见/增删改；随 catalog 下发给其名下用户）──
		api.get("/agent-api/templates", async (req) => ({ items: listTemplatesByAgent(req.agent!.id) }));
		// 平台开放给本渠道商的模板（只读展示；正文由平台维护、不下发给渠道商，仅列元信息）
		api.get("/agent-api/shared-templates", async (req) => ({
			items: listSharedPlatformTemplatesForAgent(req.agent!.id).map((t) => ({
				id: t.id, name: t.name, capability: t.capability, purpose: t.purpose, category: t.category,
				isDefault: t.isDefault, enabled: t.enabled, order: t.order,
			})),
		}));
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
		//  - 「消耗」= 用户请求显示该用户实扣（统一定价实时扣用户）；发码划转/作废退回/
		//    渠道节点池扣（带 agentCosts）显示本商积分池那份——渠道商可统计名下用户消耗；
		//  - agentCosts 数组绝不下发，详情仅开放 ①②段（③④上游报文不可见）。
		const myCostView = (req: FastifyRequest): LogCostView => ({ kind: "agent", agentId: req.agent!.id });
		/** 门户日志投影：消耗=本商实扣；剥掉 agentCosts（保密） */
		const agentLogView = (l: LogMeta, view: LogCostView) => {
			const { agentCosts, ...rest } = l;
			return { ...rest, cost: logCostFor(l, view) };
		};
		api.get("/agent-api/logs/facets", async (req) => {
			const g = logFacets({ owners: [req.agent!.id] });
			return { users: g.users, purposes: g.purposes, models: g.models };
		});
		api.get("/agent-api/logs/summary", async (req) => {
			const q = req.query as Record<string, string | undefined>;
			const num = (v?: string) => (v != null && v !== "" ? Number(v) : undefined);
			const status = q.status === "success" || q.status === "failed" || q.status === "running" ? q.status : undefined;
			return logSummary({ owners: [req.agent!.id], from: num(q.from), to: num(q.to), userName: q.user || undefined, purpose: q.purpose || undefined, model: q.model || undefined, status }, myCostView(req));
		});
		api.get("/agent-api/logs/export", async (req) => {
			const q = req.query as Record<string, string | undefined>;
			const num = (v?: string) => (v != null && v !== "" ? Number(v) : undefined);
			const status = q.status === "success" || q.status === "failed" || q.status === "running" ? q.status : undefined;
			return { items: exportLogs({ owners: [req.agent!.id], from: num(q.from), to: num(q.to), userName: q.user || undefined, purpose: q.purpose || undefined, model: q.model || undefined, status }, myCostView(req)) };
		});
		// 批量下载清单（第232轮）：范围恒为本商归属（owners 强制覆盖，不受查询串影响）；
		// 单用户视图可另传 ?userId= 收窄（与 logs 同语义：范围外 userId 天然空集）。
		api.get("/agent-api/downloads/manifest", async (req) => {
			const q = req.query as Record<string, string | undefined>;
			return buildDownloadManifest({
				...parseDownloadQuery(q),
				owners: [req.agent!.id],
				...(q.userId ? { userIds: [q.userId] } : {}),
			});
		});
		api.get("/agent-api/downloads/summary", async (req) => {
			const q = req.query as Record<string, string | undefined>;
			return downloadManifestSummary({
				...parseDownloadQuery(q),
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
			const { upstreamRequest, upstreamResponse, agentCosts, ...safe } = log as LogEntry & Record<string, unknown>;
			return { ...safe, cost: logCostFor(log, myCostView(req)) };
		});
	});
}
