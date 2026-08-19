/**
 * 管理端控制台 API + 静态页面。
 *  GET /admin           → 控制台页面（公开，页面内再用 admin token 调 API）
 *  /admin-api/*         → 需要 ADMIN_TOKEN（Bearer）
 *    users / models / logs 的增删改查
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../auth.ts";
import {
	listUsers, getUser, createUser, updateUser, deleteUser, genAccessKey, dailySpentToday, userStats, usersByAgent,
	setUserPassword,
	type User,
} from "../store/users.ts";
import {
	listAgents, getAgent, createAgent, updateAgent, deleteAgent, changeAgentCredits, publicAgent,
	createAgentSession, regenerateAgentNodeKey,
	agentModelBlocked, setAgentModelAccess,
	listAgentGroups, getAgentGroup, createAgentGroup, renameAgentGroup, deleteAgentGroup,
	setAgentGroup, setPlatformGroup, audienceGroupId, PLATFORM_AUDIENCE, DEFAULT_GROUP_ID,
	type AgentGroup,
} from "../store/agents.ts";
import { isRelay, relaySourceStatus } from "../relay.ts";
import { config } from "../config.ts";
import {
	listModels, listEnabledModels, getModelDef, createModel, updateModel, deleteModel, reorderModels, modelVisibleToAgent, modelAllowedForAgent,
	touchModelsVersion,
	type ModelDef,
} from "../store/models.ts";
import { listModes, createMode, updateMode, deleteMode, reorderModes, modeName } from "../store/modes.ts";
import { listFamilies, createFamily, updateFamily, deleteFamily, reorderFamilies } from "../store/families.ts";
import {
	listProtocols, createProtocol, updateProtocol, deleteProtocol, isBuiltinProtocol,
	BUILTIN_PROTOCOLS, type CustomProtocol,
} from "../store/protocols.ts";
import {
	listChannels, createChannel, updateChannel, deleteChannel, reorderChannels,
	type ChannelDef,
} from "../store/channels.ts";
import {
	listPlatformTemplates, listTemplatesByAgent, getTemplateDef, createTemplate, updateTemplate, deleteTemplate,
	type TemplateDef,
} from "../store/templates.ts";
import {
	listPresets, getPresetDef, createPreset, updatePreset, deletePreset,
	type PresetDef,
} from "../store/presets.ts";
import { listLogs, getLog, logFacets, requestStats, exportLogs, userModelStats, logSummary, logCostFor, logCodeIssue, PLATFORM_OWNER, type LogCostView } from "../store/logs.ts";
import { buildDownloadManifest, downloadManifestSummary, parseDownloadQuery } from "../store/assetExport.ts";
import { listCodes, createCodes, deleteCode, codesByAgent, platformCodes, pruneInvalidCodes } from "../store/redeemCodes.ts";
import {
	listAllLibraries, createLibrary as createSharedLibrary, updateLibrary as updateSharedLibrary,
	deleteLibrary as deleteSharedLibrary, libraryCounts, getLibrary as getSharedLibrary,
	listFolders as listSharedFolders, getFolder as getSharedFolder, listFolderAssets as listSharedFolderAssets,
	listLibrariesByAudience,
} from "../store/sharedLibs.ts";
import { getAsset, storageStats } from "../store/assets.ts";
import { getProfiles } from "../store/storage.ts";
import {
	listTeams, getTeam, updateTeam, dissolveTeam, sanitizeTeams, listTeamCodes, createTeamCodes, deleteTeamCode, effectiveTeamLimit,
	settleMemberGrant,
} from "../store/teams.ts";
import {
	getOssConfig, setOssConfig,
	getTeamMemberLimit, setTeamMemberLimit,
	getFavQuotaBytes, setFavQuotaBytes, getTeamLibQuotaBytes, setTeamLibQuotaBytes, getStorageCodeSpec, setStorageCodeSpec,
	getRegisterSettings, setRegisterSettings, getDeviceLimit, setDeviceLimit,
} from "../store/settings.ts";
import { isSmtpConfigured, sendMail } from "../services/mailer.ts";
import { isSmsConfigured } from "../services/smsAliyun.ts";
import { isOssConfigured, ossSelfTest } from "../store/oss.ts";
import { favoriteOwnersOverview, favoritedAssetCount, grantedBytes, addFavorite, removeFavorite } from "../store/favorites.ts";
import { listStorageCodes, createStorageCodes, deleteStorageCode } from "../store/storageCodes.ts";
import { sweepPreview, setRetentionDays } from "../store/retention.ts";
import { cleanupOverview, setCleanupConfig, runCleanupOnce } from "../store/cleanup.ts";
import { listCreditOps } from "../store/credits.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ADMIN_HTML = join(here, "..", "admin", "index.html");

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
	// 控制台页面（公开加载，页面内提示输入 admin token）。
	// P3：注入节点角色——relay 模式页面隐藏源站专属页并显示「源站连接」条。
	app.get("/admin", async (_req, reply) => {
		const html = readFileSync(ADMIN_HTML, "utf8")
			.replace("</title>", `</title>\n<script>window.__NODE_ROLE__=${JSON.stringify(config.role)};</script>`);
		return reply.header("Content-Type", "text/html; charset=utf-8").send(html);
	});

	await app.register(async (api) => {
		api.addHook("preHandler", requireAdmin);

		// P3 relay：源站专属管理端点一律 403（模型/渠道/模板/预设/渠道商/OSS/存储/配额/保留策略——
		// 这些实体都在源站；节点只管本地 用户/团队/兑换码/统计/日志/注册设置）
		if (isRelay()) {
			const SOURCE_ONLY = /^\/admin-api\/(channels|models|modes|families|protocols|templates|presets|agents|agent-groups|platform-group|settings\/oss|storage|retention|cleanup|quota)/;
			api.addHook("preHandler", async (req, reply) => {
				if (SOURCE_ONLY.test(req.url)) {
					return reply.code(403).send({ error: { message: "渠道节点不提供该管理功能（源站专属）" } });
				}
			});
			// 节点管理端「源站连接」卡：源站地址/连通性/池余额/在途任务
			api.get("/admin-api/relay/status", async () => relaySourceStatus());
		}

		// ── 用户 ──
		// 第112轮：默认只列平台直属用户——渠道商的用户由渠道商自己管理，不在源站直接显示；
		// 源站查看某商用户走 ?agentId=<id>（渠道商详情）或「查看信息」免密直登其门户。
		api.get("/admin-api/users", async (req) => {
			// 第175轮三态：__all=全部 / platform（或缺省）=平台直属 / 其余=该渠道商名下
			const q = req.query as Record<string, string | undefined>;
			const list = q.agentId === "__all"
				? listUsers()
				: q.agentId && q.agentId !== PLATFORM_AUDIENCE
					? usersByAgent(q.agentId)
					: listUsers().filter((u) => !u.agentId);
			// 脱敏：绝不外泄 passwordHash/passwordSalt（附派生 hasAccount 供前端展示注册态）
			return {
				items: list.map(({ passwordHash, passwordSalt, ...u }) => ({
					...u, dailySpent: dailySpentToday(u), totalSpent: u.totalSpent || 0, hasAccount: !!u.account,
				})),
			};
		});
		api.post("/admin-api/users", async (req) => createUser((req.body ?? {}) as any));
		// （P2b 移除：批量生成激活码——注册体系上线后用户自助注册（可填邀请码归属渠道商）；
		//   管理端仍可单个创建用户；存量激活码用户不受影响。）
		// 批量操作（第130轮）：对选中的多个用户批量 启用/停用账号、启/禁模式、解绑机器、删除
		api.post("/admin-api/users/batch-op", async (req, reply) => {
			const b = (req.body ?? {}) as { ids?: string[]; op?: string; modeId?: string; feature?: string; value?: boolean };
			const ids = Array.isArray(b.ids) ? b.ids.filter((x) => typeof x === "string") : [];
			if (!ids.length) return reply.code(400).send({ error: { message: "缺少用户 ids" } });
			if (!b.op) return reply.code(400).send({ error: { message: "缺少操作 op" } });
			let affected = 0;
			for (const id of ids) {
				const u = getUser(id);
				if (!u) continue;
				switch (b.op) {
					case "enable": if (updateUser(id, { enabled: true })) affected++; break;
					case "disable": if (updateUser(id, { enabled: false })) affected++; break;
					case "delete": if (deleteUser(id)) affected++; break;
					case "setFeature": { // 批量开关固定模式（assetMode/canvasMode/editorMode/libtv/dreamina）
						if (!b.feature) break;
						const f: Record<string, unknown> = { assetMode: true, canvasMode: true, editorMode: true, libtv: true, dreamina: true, ...(u.features ?? {}) };
						f[b.feature] = b.value !== false;
						if (f.assetMode === false && f.canvasMode === false && f.editorMode === false) break; // 资产+画布+实时剪辑不能全关
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
			return { ok: true, affected };
		});
		api.put("/admin-api/users/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			const u = updateUser(id, (req.body ?? {}) as any);
			if (!u) return reply.code(404).send({ error: { message: "用户不存在" } });
			return u;
		});
		api.delete("/admin-api/users/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			if (!deleteUser(id)) return reply.code(404).send({ error: { message: "用户不存在" } });
			return { ok: true };
		});
		api.post("/admin-api/users/:id/regenerate-key", async (req, reply) => {
			const { id } = req.params as { id: string };
			if (!getUser(id)) return reply.code(404).send({ error: { message: "用户不存在" } });
			return updateUser(id, { accessKey: genAccessKey() })!;
		});
		// 解绑账号：清空 account/密码，释放该账号供重新注册/绑定。
		// ⚠ 不是找回密码的手段（P2b 取消激活码后，已登出的用户解绑即无法自行登录；
		//    仍在登录态的可在个人中心重新绑定）——帮用户找回密码用下面的 reset-password。
		api.post("/admin-api/users/:id/unbind-account", async (req, reply) => {
			const { id } = req.params as { id: string };
			if (!getUser(id)) return reply.code(404).send({ error: { message: "用户不存在" } });
			return updateUser(id, { account: undefined, passwordSalt: undefined, passwordHash: undefined })!;
		});
		// 重置用户密码（管理员代设新密码）：自助找回不可用时的兜底——
		// 旧式用户名账号（非邮箱/手机号收不到验证码）、邮件/短信通道未配置 等场景。
		api.post("/admin-api/users/:id/reset-password", async (req, reply) => {
			const { id } = req.params as { id: string };
			const u = getUser(id);
			if (!u) return reply.code(404).send({ error: { message: "用户不存在" } });
			if (!u.account) return reply.code(400).send({ error: { message: "该用户未注册登录账号，无密码可重置" } });
			const { password } = (req.body ?? {}) as { password?: string };
			const r = setUserPassword(u, password ?? "");
			if (!r.ok) return reply.code(400).send({ error: { message: r.error } });
			return { ok: true };
		});

		// ── 统计图表（用户维度 + 请求维度，供管理端可视化/导出）──
		api.get("/admin-api/stats", async (req) => {
			const q = req.query as Record<string, string | undefined>;
			const days = Math.max(7, Math.min(90, Math.floor(Number(q.days) || 14)));
			return { generatedAt: new Date().toISOString(), users: userStats(), requests: requestStats(days) };
		});

		// 对单用户的统计：今日/累计消耗 + 按模型分开的成功/失败次数与消耗积分（近 N 天窗口）。
		api.get("/admin-api/stats/user", async (req, reply) => {
			const q = req.query as Record<string, string | undefined>;
			const u = q.userId ? getUser(q.userId) : undefined;
			if (!u) return reply.code(404).send({ error: { message: "用户不存在" } });
			const days = Math.max(1, Math.min(90, Math.floor(Number(q.days) || 30)));
			const from = Date.now() - days * 86400000;
			const ms = userModelStats(u.id, { from });
			return {
				generatedAt: new Date().toISOString(),
				windowDays: days,
				user: { id: u.id, name: u.name, credits: u.credits, totalSpent: u.totalSpent || 0, dailySpent: dailySpentToday(u) },
				...ms,
			};
		});

		// ── 渠道（上游凭据组：baseUrl + apiKey；apiKey 列表脱敏）──
		const maskKey = (k?: string) => (k ? "****" + k.slice(-4) : "");
		api.get("/admin-api/channels", async () => ({
			items: listChannels().map((c) => ({ ...c, apiKey: maskKey(c.apiKey), apiKeySet: !!c.apiKey })),
		}));
		api.post("/admin-api/channels", async (req, reply) => {
			const b = (req.body ?? {}) as Partial<ChannelDef>;
			if (!b.name) return reply.code(400).send({ error: { message: "缺少渠道名" } });
			const c = createChannel(b as any);
			return { ...c, apiKey: maskKey(c.apiKey), apiKeySet: !!c.apiKey };
		});
		api.put("/admin-api/channels/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			const b = (req.body ?? {}) as Record<string, unknown>;
			// apiKey 仅在传入“非掩码”新值时更新，避免被 **** 覆盖清空
			if (typeof b.apiKey === "string" && b.apiKey.startsWith("****")) delete b.apiKey;
			const c = updateChannel(id, b as any);
			if (!c) return reply.code(404).send({ error: { message: "渠道不存在" } });
			return { ...c, apiKey: maskKey(c.apiKey), apiKeySet: !!c.apiKey };
		});
		// 第165轮：卡片拖动排序——仅影响管理端显示顺序（渠道不下发客户端）。回包同列表口径脱敏
		api.post("/admin-api/channels/reorder", async (req, reply) => {
			const b = (req.body ?? {}) as { ids?: string[] };
			if (!Array.isArray(b.ids) || !b.ids.length) return reply.code(400).send({ error: { message: "缺少 ids" } });
			if (!reorderChannels(b.ids.filter((x) => typeof x === "string"))) return reply.code(400).send({ error: { message: "ids 无有效渠道" } });
			return { ok: true, items: listChannels().map((c) => ({ ...c, apiKey: maskKey(c.apiKey), apiKeySet: !!c.apiKey })) };
		});
		api.delete("/admin-api/channels/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			if (!deleteChannel(id)) return reply.code(404).send({ error: { message: "渠道不存在" } });
			return { ok: true };
		});

		// ── 模型（含翻译格式：protocol / upstreamModel / baseUrl / apiKey / channelId / routes）──
		// apiKey 覆盖与渠道一致脱敏：列表回掩码 + apiKeySet 标记；PUT 跳过掩码值、null 清除
		const maskModel = (m: ModelDef) => ({ ...m, apiKey: maskKey(m.apiKey), apiKeySet: !!m.apiKey });
		// 渠道商范围（第175轮）：不是按「谁建的」筛（模型全归平台），而是**按可用性**——
		// 只看某渠道商实际能用的模型（开放范围命中 且 未被其链上任一级禁用，modelAllowedForAgent 一把尺）。
		api.get("/admin-api/models", async (req) => {
			const scope = audScope(req.query as Record<string, string | undefined>);
			const list = scope.all
				? listModels()
				: listModels().filter((m) => modelAllowedForAgent(m, scope.platform ? undefined : scope.agentId));
			return { items: list.map(maskModel) };
		});
		// 同组内拖动排序（第176轮）：只重排列出的这批（其余模型 order 不动，见 reorderModels 注释）；
		// ⚠ 须在 /admin-api/models/:id 之前注册，否则被参数路由吞掉。
		api.post("/admin-api/models/reorder", async (req, reply) => {
			const { ids } = (req.body ?? {}) as { ids?: unknown };
			const list = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
			if (list.length < 2) return reply.code(400).send({ error: { message: "缺少 ids（至少 2 个）" } });
			if (!reorderModels(list)) return reply.code(400).send({ error: { message: "ids 未命中足够的模型" } });
			return { items: listModels().map(maskModel) };
		});
		api.post("/admin-api/models", async (req, reply) => {
			const b = (req.body ?? {}) as Partial<ModelDef>;
			if (!b.id || !b.label || !b.capability || !b.protocol) {
				return reply.code(400).send({ error: { message: "缺少 id/label/capability/protocol" } });
			}
			return maskModel(createModel(b as any));
		});
		api.put("/admin-api/models/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			const body = (req.body ?? {}) as Record<string, unknown>;
			// apiKey 仅在传入“非掩码”新值时更新；显式 null 清除；掩码值不动（避免 **** 覆盖真值）
			if (typeof body.apiKey === "string" && body.apiKey.startsWith("****")) delete body.apiKey;
			const m = updateModel(id, body as any);
			if (!m) return reply.code(404).send({ error: { message: "模型不存在" } });
			return maskModel(m);
		});
		api.delete("/admin-api/models/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			if (!deleteModel(id)) return reply.code(404).send({ error: { message: "模型不存在" } });
			return { ok: true };
		});

		// ── 模式（第130轮）：动态视频模式注册表。新建模型选模式、用户/渠道商按模式开关；删除模式清空引用它的模型 modeId ──
		api.get("/admin-api/modes", async () => ({ items: listModes() }));
		api.post("/admin-api/modes", async (req, reply) => {
			const b = (req.body ?? {}) as { id?: string; name?: string };
			const r = createMode({ id: b.id, name: b.name ?? "" });
			if (!r.ok) return reply.code(400).send({ error: { message: r.error } });
			return r.mode;
		});
		api.put("/admin-api/modes/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			const r = updateMode(id, (req.body ?? {}) as { name?: string; order?: number; enabled?: boolean });
			if (!r.ok) return reply.code(r.error === "模式不存在" ? 404 : 400).send({ error: { message: r.error } });
			return r.mode;
		});
		// 第165轮：卡片拖动排序——整表按 id 数组重排（一次落盘一次版本 bump；顺序影响客户端下拉源顺序）
		api.post("/admin-api/modes/reorder", async (req, reply) => {
			const b = (req.body ?? {}) as { ids?: string[] };
			if (!Array.isArray(b.ids) || !b.ids.length) return reply.code(400).send({ error: { message: "缺少 ids" } });
			if (!reorderModes(b.ids.filter((x) => typeof x === "string"))) return reply.code(400).send({ error: { message: "ids 无有效模式" } });
			return { ok: true, items: listModes() };
		});
		api.delete("/admin-api/modes/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			if (!deleteMode(id)) return reply.code(404).send({ error: { message: "模式不存在" } });
			return { ok: true };
		});

		// ── 家族（第163轮）：模型「家族」注册表（底层模型种类，纯展示分组——客户端一级筛选）。
		//    删除家族清空引用它的模型 familyId（回落「其他」分组，无门禁/计费影响）──
		api.get("/admin-api/families", async () => ({ items: listFamilies() }));
		api.post("/admin-api/families", async (req, reply) => {
			const b = (req.body ?? {}) as { id?: string; name?: string; capability?: string };
			const r = createFamily({ id: b.id, name: b.name ?? "", capability: b.capability });
			if (!r.ok) return reply.code(400).send({ error: { message: r.error } });
			return r.family;
		});
		api.put("/admin-api/families/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			const r = updateFamily(id, (req.body ?? {}) as { name?: string; order?: number; capability?: string; enabled?: boolean });
			if (!r.ok) return reply.code(r.error === "家族不存在" ? 404 : 400).send({ error: { message: r.error } });
			return r.family;
		});
		// 第165轮：卡片拖动排序（同模式 reorder；顺序影响客户端一级筛选顺序）
		api.post("/admin-api/families/reorder", async (req, reply) => {
			const b = (req.body ?? {}) as { ids?: string[] };
			if (!Array.isArray(b.ids) || !b.ids.length) return reply.code(400).send({ error: { message: "缺少 ids" } });
			if (!reorderFamilies(b.ids.filter((x) => typeof x === "string"))) return reply.code(400).send({ error: { message: "ids 无有效家族" } });
			return { ok: true, items: listFamilies() };
		});
		api.delete("/admin-api/families/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			if (!deleteFamily(id)) return reply.code(404).send({ error: { message: "家族不存在" } });
			return { ok: true };
		});

		// ── 协议（翻译官招募市场）：内置只读 + 自定义 CRUD。模型 protocol 下拉 = 内置 + 已启用自定义 ──
		api.get("/admin-api/protocols", async () => ({ builtins: BUILTIN_PROTOCOLS, items: listProtocols() }));
		api.post("/admin-api/protocols", async (req, reply) => {
			const b = (req.body ?? {}) as Partial<CustomProtocol>;
			if (!b.id || !b.name || !b.capability || !b.mode) {
				return reply.code(400).send({ error: { message: "缺少 id/name/capability/mode" } });
			}
			if (isBuiltinProtocol(String(b.id))) return reply.code(409).send({ error: { message: "协议 id 与内置协议冲突" } });
			try { return createProtocol(b as any); }
			catch (e) { return reply.code(400).send({ error: { message: (e as Error).message } }); }
		});
		api.put("/admin-api/protocols/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			if (isBuiltinProtocol(id)) return reply.code(403).send({ error: { message: "内置协议不可修改" } });
			const p = updateProtocol(id, (req.body ?? {}) as Partial<CustomProtocol>);
			if (!p) return reply.code(404).send({ error: { message: "协议不存在" } });
			return p;
		});
		api.delete("/admin-api/protocols/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			if (isBuiltinProtocol(id)) return reply.code(403).send({ error: { message: "内置协议不可删除" } });
			if (!deleteProtocol(id)) return reply.code(404).send({ error: { message: "协议不存在" } });
			return { ok: true };
		});

		// ── 提示词模板（管理端仅管平台模板；渠道商自营模板由 /agent-api 各自管理，互不可见）──
		// 渠道商范围（第175轮，⚠ 放宽第103轮「管理端看不到渠道商模板」）：源站可**只读查看**某商自营模板——
		// 不是新增权限（源站本就能经渠道商详情「查看信息」免密直登其门户看到），只是省一次跳转；
		// 编辑/删除仍被 PUT/DELETE 的 403 守卫拦住（自营模板只能商自己改）。
		api.get("/admin-api/templates", async (req) => {
			const scope = audScope(req.query as Record<string, string | undefined>);
			const items = scope.all
				? [...listPlatformTemplates(), ...listAgents().flatMap((a) => listTemplatesByAgent(a.id))]
				: scope.platform ? listPlatformTemplates() : listTemplatesByAgent(scope.agentId!);
			return { items: items.map((t) => ({ ...t, agentName: t.agentId ? (getAgent(t.agentId)?.name ?? t.agentId) : "" })) };
		});
		api.post("/admin-api/templates", async (req, reply) => {
			const b = (req.body ?? {}) as Partial<TemplateDef>;
			if (!b.id || !b.name || !b.capability) {
				return reply.code(400).send({ error: { message: "缺少 id/name/capability" } });
			}
			const { agentId, ...rest } = b; // 管理端只建平台模板，忽略 agentId
			return createTemplate(rest as any);
		});
		api.put("/admin-api/templates/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			const cur = getTemplateDef(id);
			if (!cur) return reply.code(404).send({ error: { message: "模板不存在" } });
			if (cur.agentId) return reply.code(403).send({ error: { message: "该模板归属渠道商，管理端不可编辑" } });
			const { agentId, ...rest } = (req.body ?? {}) as Record<string, unknown>; // 禁止把平台模板改成渠道商归属
			return updateTemplate(id, rest as any)!;
		});
		api.delete("/admin-api/templates/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			const cur = getTemplateDef(id);
			if (!cur) return reply.code(404).send({ error: { message: "模板不存在" } });
			if (cur.agentId) return reply.code(403).send({ error: { message: "该模板归属渠道商，管理端不可删除" } });
			deleteTemplate(id);
			return { ok: true };
		});

		// ── 预设（第174轮从提示词模板拆出的独立实体：画风/预设方案/资产拆分前后缀，presets.json）──
		api.get("/admin-api/presets", async () => ({ items: listPresets() }));
		api.post("/admin-api/presets", async (req, reply) => {
			const b = (req.body ?? {}) as Partial<PresetDef>;
			if (!b.id || !b.name) return reply.code(400).send({ error: { message: "缺少 id/name" } });
			return createPreset(b as any);
		});
		api.put("/admin-api/presets/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			if (!getPresetDef(id)) return reply.code(404).send({ error: { message: "预设不存在" } });
			return updatePreset(id, (req.body ?? {}) as any)!;
		});
		api.delete("/admin-api/presets/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			if (!deletePreset(id)) return reply.code(404).send({ error: { message: "预设不存在" } });
			return { ok: true };
		});

		// ── 渠道商范围（第175轮）：源站各页统一的「按渠道商查看」一把尺 ──
		// 约定：`?agentId` 缺省/"__all"=全部（不筛）；"platform"=源站（平台直属，无归属）；其余=该渠道商。
		// ⚠ 与「请求记录/用户/兑换码」页的 logScope 不同——那三页缺省=源站直属（运营口径，第116/168/171轮定），
		// 本尺用于「资源清单」类页面（团队/共享素材/模型/模板），缺省=全部，只加筛选能力、不隐藏存量数据。
		type AudScope = { all: boolean; platform: boolean; agentId?: string };
		function audScope(q: Record<string, string | undefined>): AudScope {
			const v = (q.agentId || "").trim();
			if (!v || v === "__all") return { all: true, platform: false };
			if (v === PLATFORM_AUDIENCE) return { all: false, platform: true };
			return { all: false, platform: false, agentId: v };
		}
		/** 某条记录的归属（渠道商 id / 平台直属=undefined）是否落在范围内 */
		function inAudScope(s: AudScope, ownerAgentId?: string): boolean {
			if (s.all) return true;
			if (s.platform) return !ownerAgentId;
			return ownerAgentId === s.agentId;
		}

		// ── 请求记录 ──
		// 第116轮「源站视为一个渠道商」：主「请求记录/统计」只看**平台直属**的记录——
		// 渠道商归属的记录不混进源站视图，经 ?agentId=<商id> 切换查看（第168轮下拉）。
		// 第198轮起范围按 LogMeta.ownerId（**落笔时固化**的归属：用户日志=直属商、开码日志=签发商、
		// 平台直属/无归属存量=空）过滤，不再查询期从用户表反推——用户被删/改归属后历史记录不漂移。
		function logScope(q: Record<string, string | undefined>): { userIds?: string[]; owners?: string[] } {
			// 单用户视图（第121轮「每个用户的请求记录」）最优先：不受直属/渠道商范围限制（源站权限高，
			// 平台直属用户与渠道商用户都可按 userId 查看）；单用户视图不含开码日志（属渠道商、无用户）。
			if (q.userId) return { userIds: [q.userId] };
			// 第175轮统一三态：__all=全部（不设范围）/ platform=源站直属（与缺省同义）/ 其余=该渠道商
			if (q.agentId === "__all") return {};
			// 渠道商视图：该商归属的记录（名下用户消耗 + 本商开码；不含其下游商——下拉里下游商单列）
			if (q.agentId && q.agentId !== PLATFORM_AUDIENCE) return { owners: [q.agentId] };
			// 源站主视图：仅平台直属归属（开码日志归属=签发商，天然不进源站视图）
			return { owners: [PLATFORM_OWNER] };
		}
		// 消耗视角：商属范围（?agentId=/商属 ?userId=）按**源站实收**聚合——带链记录（发码划转/
		// 节点池扣/旧链式）=链根级实扣、无链记录（统一定价后的生成请求）=用户实扣（第220轮补充：
		// 源站借此可统计渠道商用户消耗）；直属范围 cost 本就=源站实收，不变。
		function logCostViewFor(q: Record<string, string | undefined>): LogCostView | undefined {
			if (q.agentId && q.agentId !== "__all" && q.agentId !== PLATFORM_AUDIENCE) return { kind: "platform" };
			if (q.userId) return getUser(q.userId)?.agentId ? { kind: "platform" } : undefined;
			return undefined;
		}
		// 筛选下拉选项（用户/步骤/模型去重，按范围）。须在 /:id 之前注册以免被参数路由吞掉。
		api.get("/admin-api/logs/facets", async (req) => logFacets(logScope(req.query as Record<string, string | undefined>)));
		// 按筛选聚合统计（统计页 + 请求记录简单统计条）。须在 /:id 之前注册。
		api.get("/admin-api/logs/summary", async (req) => {
			const q = req.query as Record<string, string | undefined>;
			const num = (v?: string) => (v != null && v !== "" ? Number(v) : undefined);
			const status = q.status === "success" || q.status === "failed" || q.status === "running" ? q.status : undefined;
			return logSummary({
				...logScope(q),
				from: num(q.from), to: num(q.to),
				userName: q.user || undefined, purpose: q.purpose || undefined, model: q.model || undefined, status,
			}, logCostViewFor(q));
		});
		// 导出（按当前筛选取全部匹配，映射成表格行供 CSV）。同样须在 /:id 之前注册。
		api.get("/admin-api/logs/export", async (req) => {
			const q = req.query as Record<string, string | undefined>;
			const num = (v?: string) => (v != null && v !== "" ? Number(v) : undefined);
			const status = q.status === "success" || q.status === "failed" || q.status === "running" ? q.status : undefined;
			return {
				items: exportLogs({
					...logScope(q),
					from: num(q.from),
					to: num(q.to),
					userName: q.user || undefined,
					purpose: q.purpose || undefined,
					model: q.model || undefined,
					status,
				}, logCostViewFor(q)),
			};
		});
			// 批量下载清单（第232轮）：把请求记录里的成功产物摊平成可供下载器消费的条目。
			// 归属隔离复用 logScope（源站看直属、切渠道商看该商）——范围绝不由查询串自定。
			api.get("/admin-api/downloads/manifest", async (req) => {
				const q = req.query as Record<string, string | undefined>;
				return buildDownloadManifest({ ...parseDownloadQuery(q), ...logScope(q) });
			});
			api.get("/admin-api/downloads/summary", async (req) => {
				const q = req.query as Record<string, string | undefined>;
				return downloadManifestSummary({ ...parseDownloadQuery(q), ...logScope(q) });
			});
		api.get("/admin-api/logs", async (req) => {
			const q = req.query as Record<string, string | undefined>;
			const num = (v?: string) => (v != null && v !== "" ? Number(v) : undefined);
			const status = q.status === "success" || q.status === "failed" || q.status === "running" ? q.status : undefined;
			const r = listLogs({
				...logScope(q),
				limit: num(q.limit) ?? 50,
				offset: num(q.offset) ?? 0,
				from: num(q.from),
				to: num(q.to),
				userName: q.user || undefined,
				purpose: q.purpose || undefined,
				model: q.model || undefined,
				status,
			});
			// 商属范围：每条附「源站实收」（platformCost：带链=根级实扣、无链=用户实扣（统一定价））——
			// 消耗列显示源站自己的口径，用户扣的售价数仅作参考（cost 保留）
			const view = logCostViewFor(q);
			return view ? { total: r.total, items: r.items.map((l) => ({ ...l, platformCost: logCostFor(l, view) })) } : r;
		});
		api.get("/admin-api/logs/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			const log = getLog(id);
			if (!log) return reply.code(404).send({ error: { message: "记录不存在" } });
			// 源站全见：链路扣费明细带商名（用户按售价扣 cost + 链上各级结算侧实扣，根级=源站实收）
			return {
				...log,
				agentCosts: log.agentCosts?.map((a) => ({ ...a, name: getAgent(a.id)?.name || `（已删渠道商 ${a.id}）` })),
			};
		});

		// ── 积分兑换码（批量生成一次性码 + 可选有效期）──
		// 范围（第175轮，与请求记录页同款）：缺省=源站平台直发的码；?agentId=<id>=该商签发；?agentId=__all=全部。
		// 归属决定可兑换范围：平台直发全体可用、渠道商签发仅其名下用户可用（见 redeemCodes.codeUsableBy）。
		api.get("/admin-api/redeem-codes", async (req) => {
			const scope = audScope(req.query as Record<string, string | undefined>);
			const items = scope.all ? listCodes() : scope.platform ? platformCodes() : codesByAgent(scope.agentId!);
			return {
				items: items.map((c) => ({ ...c, agentName: c.agentId ? (getAgent(c.agentId)?.name ?? c.agentId) : "" })),
				scope,
			};
		});
		api.post("/admin-api/redeem-codes", async (req, reply) => {
			const b = (req.body ?? {}) as { count?: number; credits?: number; expiresAt?: string; note?: string };
			if (!b.credits || Number(b.credits) <= 0) return reply.code(400).send({ error: { message: "缺少面额 credits（需 > 0）" } });
			// 管理端发的一律是**平台码**（全体用户可兑换）——绝不接受 body 里的 agentId（渠道商码走其门户签发）
			return { items: createCodes({ count: b.count, credits: Number(b.credits), expiresAt: b.expiresAt, note: b.note }) };
		});
		api.delete("/admin-api/redeem-codes/:code", async (req, reply) => {
			const { code } = req.params as { code: string };
			if (!deleteCode(code)) return reply.code(404).send({ error: { message: "兑换码不存在" } });
			return { ok: true };
		});
		// 清除失效兑换码（第225轮）：已使用 + 已过期一键清掉（全部归属范围）。
		// ⚠ 已过期未使用的**渠道商码**面额退回其积分池（签发是真金划转、过期=永远兑不了——
		//   与门户「作废退回」同语义，同一条 logCodeIssue 记账通道）；平台码是 mint 无需退；商已删=无处可退仅清码。
		api.post("/admin-api/redeem-codes/prune", async () => {
			const r = pruneInvalidCodes();
			let refunded = 0;
			for (const f of r.agentRefunds) {
				const a = getAgent(f.agentId);
				if (!a || f.credits <= 0) continue;
				changeAgentCredits(f.agentId, f.credits);
				refunded += f.credits;
				logCodeIssue({
					agentId: f.agentId, agentName: a.name, tierLabel: `兑换码过期清除退回 ×${f.count}`, cost: -f.credits,
					agentCosts: [{ id: f.agentId, cost: -f.credits }],
					summary: { action: "清除过期兑换码", refund: f.credits, count: f.count },
				});
			}
			return { ok: true, removed: r.removed, usedRemoved: r.usedRemoved, expiredRemoved: r.expiredRemoved, refunded };
		});

		// ── 团队（第172轮）：用户互绑（团队码开团）。管理端=看团队数量/积分 + 生成/作废团队码 + 强制解散 ──
		function adminTeamView(t: ReturnType<typeof listTeams>[number]) {
			const leader = getUser(t.leaderId);
			const members = t.memberIds.map((id) => getUser(id)).filter((u): u is User => !!u);
			return {
				id: t.id, name: t.name, creditMode: t.creditMode, createdAt: t.createdAt, code: t.code,
				/** 归属：团长所属渠道商名（空=源站直属团队） */
				agentName: leader?.agentId ? (getAgent(leader.agentId)?.name || `（已删渠道商 ${leader.agentId}）`) : undefined,
				/** 人数上限（含团长）：memberLimit=本团覆盖（空=跟随默认）、effectiveLimit=生效值 */
				memberLimit: t.memberLimit,
				effectiveLimit: effectiveTeamLimit(t),
				leader: leader ? { id: leader.id, name: leader.name || leader.account || "（未注册）", account: leader.account, credits: leader.credits } : null,
				memberCount: members.length + (leader ? 1 : 0),
				/** 池余额=团长余额（共享模式下即团队共享池；分发模式下是团长可分发的余量） */
				poolCredits: leader?.credits ?? 0,
				memberCredits: members.reduce((s, u) => s + (u.credits || 0), 0),
				todaySpent: (leader ? dailySpentToday(leader) : 0) + members.reduce((s, u) => s + dailySpentToday(u), 0),
				sharedLibId: t.sharedLibId,
				sharedLibName: t.sharedLibId ? getSharedLibrary(t.sharedLibId)?.name : undefined,
			};
		}
		api.get("/admin-api/teams", async (req) => {
			// 懒清理：团长被删的团队解散 + 共享库级联删（与用户端 GET /v1/team 同尺）
			for (const t of sanitizeTeams()) if (t.sharedLibId) deleteSharedLibrary(t.sharedLibId);
			// 渠道商范围（第175轮）：归属=**团长的归属**（团队本身不限归属，第172轮补充4）
			const scope = audScope(req.query as Record<string, string | undefined>);
			const items = listTeams().filter((t) => inAudScope(scope, getUser(t.leaderId)?.agentId)).map(adminTeamView);
			return {
				items,
				defaultMemberLimit: getTeamMemberLimit(),
				summary: {
					teams: items.length,
					members: items.reduce((s, t) => s + t.memberCount, 0),
					poolCredits: items.reduce((s, t) => s + t.poolCredits, 0),
					memberCredits: items.reduce((s, t) => s + t.memberCredits, 0),
				},
			};
		});
		// 团队人数上限（第173轮，含团长）：全局默认（2–500；空/非法=恢复默认 50）
		api.put("/admin-api/settings/team-member-limit", async (req) => {
			const { limit } = (req.body ?? {}) as { limit?: unknown };
			return { ok: true, limit: setTeamMemberLimit(limit) };
		});
		// （P1 移除：团队码单价——团队码免费且仅源站签发）
		// 按团覆盖人数上限：memberLimit=null/空 → 清除跟随全局默认（只影响后续加人，不裁现有成员）
		api.put("/admin-api/teams/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			const t = getTeam(id);
			if (!t) return reply.code(404).send({ error: { message: "团队不存在" } });
			const { memberLimit } = (req.body ?? {}) as { memberLimit?: number | null };
			const r = updateTeam(id, { memberLimit: memberLimit ?? null });
			if (!r.ok) return reply.code(400).send({ error: { message: r.error } });
			return { ok: true, memberLimit: r.team.memberLimit, effectiveLimit: effectiveTeamLimit(r.team) };
		});
		api.delete("/admin-api/teams/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			const t = getTeam(id);
			if (!t) return reply.code(404).send({ error: { message: "团队不存在" } });
			// 与团长解散同口径：逐团员把分发余量退回团长（只结算分发部分，不动团员自有积分）
			for (const mid of t.memberIds) settleMemberGrant(id, mid);
			dissolveTeam(id);
			if (t.sharedLibId) deleteSharedLibrary(t.sharedLibId);
			return { ok: true };
		});
		// 团队码：生成 N 个（源站码，仅平台直属用户可开团）/ 列表（含渠道商发的码，带签发方+核销团名）/ 删除
		api.get("/admin-api/team-codes", async () => ({
			items: listTeamCodes().map((c) => ({
				...c,
				agentName: c.agentId ? (getAgent(c.agentId)?.name || `（已删渠道商 ${c.agentId}）`) : undefined,
				teamName: c.usedByTeamId ? (getTeam(c.usedByTeamId)?.name || "（已解散）") : undefined,
			})),
		}));
		api.post("/admin-api/team-codes", async (req, reply) => {
			const b = (req.body ?? {}) as { count?: number; note?: string };
			const n = Math.floor(Number(b.count) || 0);
			if (n < 1) return reply.code(400).send({ error: { message: "缺少数量 count（需 ≥ 1）" } });
			return { items: createTeamCodes(n, b.note) };
		});
		api.delete("/admin-api/team-codes/:code", async (req, reply) => {
			const { code } = req.params as { code: string };
			const r = deleteTeamCode(code);
			if (!r.ok) return reply.code(400).send({ error: { message: r.error } });
			return { ok: true };
		});

		// ── 下游渠道商（Agent：账密登录的独立门户 /agent，用自己的积分池发码）──
		// 列表附带派生统计：名下用户数、签发兑换码数/已兑换数（激活码数=名下用户数）
		function agentView(id: string) {
			const a = getAgent(id)!;
			const us = usersByAgent(id);
			const cs = listCodes().filter((c) => c.agentId === id);
			return {
				...publicAgent(a),
				// 第167轮：生效分组（未设/所在分组已删=默认分组）
				groupId: audienceGroupId(a.id),
				groupName: getAgentGroup(audienceGroupId(a.id))?.name,
				userCount: us.length,
				redeemCount: cs.length,
				redeemUsed: cs.filter((c) => c.used).length,
			};
		}
		api.get("/admin-api/agents", async () => ({
			items: listAgents().map((a) => agentView(a.id)),
			// 第167轮：源站作为受众常驻渠道商页（有且最少有源站）——与渠道商一样归属分组
			platform: {
				groupId: audienceGroupId(PLATFORM_AUDIENCE),
				groupName: getAgentGroup(audienceGroupId(PLATFORM_AUDIENCE))?.name,
				userCount: listUsers().filter((u) => !u.agentId).length,
			},
		}));
		api.post("/admin-api/agents", async (req, reply) => {
			const b = (req.body ?? {}) as { name?: string; account?: string; password?: string; credits?: number; note?: string };
			const r = createAgent(b);
			if (!r.ok) return reply.code(400).send({ error: { message: r.error } });
			return agentView(r.agent.id);
		});
		api.put("/admin-api/agents/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			const r = updateAgent(id, (req.body ?? {}) as any);
			if (!r.ok) return reply.code(r.error === "渠道商不存在" ? 404 : 400).send({ error: { message: r.error } });
			return agentView(id);
		});
		api.delete("/admin-api/agents/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			if (!deleteAgent(id)) return reply.code(404).send({ error: { message: "渠道商不存在" } });
			return { ok: true };
		});
		// 分发（delta>0）/ 扣回（delta<0）积分
		api.post("/admin-api/agents/:id/credits", async (req, reply) => {
			const { id } = req.params as { id: string };
			const { delta } = (req.body ?? {}) as { delta?: number };
			const d = Math.floor(Number(delta) || 0);
			if (!d) return reply.code(400).send({ error: { message: "缺少积分变动 delta（非 0 整数）" } });
			const r = changeAgentCredits(id, d);
			if (!r.ok) return reply.code(r.error === "渠道商不存在" ? 404 : 400).send({ error: { message: r.error } });
			return agentView(id);
		});
		// （P1 移除：开码积分分发端点——开码积分整体退役）

		// P3：生成/重置渠道节点密钥（ank-）——商自部署 relay 节点的对接凭证。
		// 重置=旧密钥立即失效（线上节点须同步换 SOURCE_NODE_KEY），故走独立端点不并入 PUT。
		api.post("/admin-api/agents/:id/node-key", async (req, reply) => {
			const { id } = req.params as { id: string };
			const a = regenerateAgentNodeKey(id);
			if (!a) return reply.code(404).send({ error: { message: "渠道商不存在" } });
			return { ok: true, nodeKey: a.nodeKey };
		});

		// ── 渠道商分组（第167轮）：受众（渠道商 + 源站）的管理维度——模型「开放范围」按分组勾选。
		// 默认分组恒在、不可删。（P1 起分组不再承载定价）──
		function groupView(g: AgentGroup) {
			const members = listAgents().filter((a) => audienceGroupId(a.id) === g.id);
			const platformIn = audienceGroupId(PLATFORM_AUDIENCE) === g.id;
			return {
				id: g.id,
				name: g.name,
				isDefault: g.id === DEFAULT_GROUP_ID,
				memberCount: members.length + (platformIn ? 1 : 0),
				platformIn,
			};
		}
		api.get("/admin-api/agent-groups", async () => ({
			items: listAgentGroups().map(groupView),
			platformGroupId: audienceGroupId(PLATFORM_AUDIENCE),
			defaultGroupId: DEFAULT_GROUP_ID,
		}));
		api.post("/admin-api/agent-groups", async (req, reply) => {
			const { name } = (req.body ?? {}) as { name?: string };
			const r = createAgentGroup(name || "");
			if (!r.ok) return reply.code(400).send({ error: { message: r.error } });
			return groupView(r.group);
		});
		api.put("/admin-api/agent-groups/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			const { name } = (req.body ?? {}) as { name?: string };
			const r = renameAgentGroup(id, name || "");
			if (!r.ok) return reply.code(r.error === "分组不存在" ? 404 : 400).send({ error: { message: r.error } });
			return groupView(getAgentGroup(id)!);
		});
		api.delete("/admin-api/agent-groups/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			const r = deleteAgentGroup(id);
			if (!r.ok) return reply.code(r.error === "分组不存在" ? 404 : 400).send({ error: { message: r.error } });
			// 成员回落默认分组可能改变模型开放范围：成员商已各自 bump 版本；
			// 源站/整体保险起见全局 bump 目录版本，全部用户 ≤30s 热更
			touchModelsVersion();
			return { ok: true };
		});
		// 渠道商换分组（分组决定开放范围命中与顶级商分组价；setAgentGroup 内部 bump 该商 pricingVersion 热更其体系）
		api.put("/admin-api/agents/:id/group", async (req, reply) => {
			const { id } = req.params as { id: string };
			const { groupId } = (req.body ?? {}) as { groupId?: string | null };
			const r = setAgentGroup(id, groupId ?? null);
			if (!r.ok) return reply.code(r.error === "渠道商不存在" ? 404 : 400).send({ error: { message: r.error } });
			return agentView(id);
		});
		// 源站换分组（影响平台直属用户的模型开放范围 → 全局 bump 目录版本热更）
		api.put("/admin-api/platform-group", async (req, reply) => {
			const { groupId } = (req.body ?? {}) as { groupId?: string | null };
			const r = setPlatformGroup(groupId ?? null);
			if (!r.ok) return reply.code(400).send({ error: { message: r.error } });
			touchModelsVersion();
			return { ok: true, groupId: audienceGroupId(PLATFORM_AUDIENCE) };
		});
		// （P1 移除：分组默认结算价端点——统一定价后分组只承载模型开放范围）

		// ── 渠道商详情（第110轮：源站对每个渠道商有查看权）──
		// 查看信息：签发该渠道商的门户会话 token，管理员免密打开 /agent 门户（与渠道商本人所见完全一致）
		api.post("/admin-api/agents/:id/impersonate", async (req, reply) => {
			const { id } = req.params as { id: string };
			const a = getAgent(id);
			if (!a) return reply.code(404).send({ error: { message: "渠道商不存在" } });
			if (!a.enabled) return reply.code(400).send({ error: { message: "该渠道商已停用，无法打开其门户" } });
			const token = createAgentSession(id);
			return { token, url: `/agent?imp=${encodeURIComponent(token)}` };
		});
		// 该渠道商名下用户（只读查看：渠道商用户不进源站用户页，由渠道商自己管理；脱敏同用户列表）
		api.get("/admin-api/agents/:id/users", async (req, reply) => {
			const { id } = req.params as { id: string };
			if (!getAgent(id)) return reply.code(404).send({ error: { message: "渠道商不存在" } });
			return {
				items: usersByAgent(id).map(({ passwordHash, passwordSalt, ...u }) => ({
					...u, dailySpent: dailySpentToday(u), totalSpent: u.totalSpent || 0, hasAccount: !!u.account,
				})),
			};
		});
		// 该渠道商的模型视图（P1 统一定价：**只读**平台价 + 开放/禁用标记——定价编辑整体退役，
		// 保留此端点供「渠道商详情」的模型开放/禁用管控 UI 使用）。
		api.get("/admin-api/agents/:id/pricing", async (req, reply) => {
			const { id } = req.params as { id: string };
			const a = getAgent(id);
			if (!a) return reply.code(404).send({ error: { message: "渠道商不存在" } });
			return {
				items: listEnabledModels().map((m) => ({
					id: m.id,
					label: m.label,
					capability: m.capability,
					hidden: !!m.hidden,
					// 第131轮：按模式分组显示（hidden 内部计费模型恒无模式=默认组）
					modeId: m.modeId,
					modeName: m.modeId ? modeName(m.modeId) : undefined,
					open: modelVisibleToAgent(m, id),
					// 第121轮：该商禁用标记（与 open 双闸：open 是模型侧受众开放、blocked 是商侧禁用清单）
					blocked: agentModelBlocked(id, m.id),
					cost: m.cost,
					costField: m.costField,
					costPerUnit: m.costPerUnit,
					costRules: (m.routes ?? []).map((r) => ({ when: r.when, cost: r.cost, costPerUnit: r.costPerUnit })),
				})),
			};
		});
		// （P1 移除：给渠道商设结算价端点——统一定价）

		// 第121轮：禁用/解除某商对某模型的使用（源站整商级管控）。禁用后其名下用户 catalog 不下发该模型、
		// generate/batch 403、门户「模型定价」不显示；变更 bump pricingVersion 触发名下用户 catalog 热更。
		api.put("/admin-api/agents/:id/models/:modelId/access", async (req, reply) => {
			const { id, modelId } = req.params as { id: string; modelId: string };
			if (!getAgent(id)) return reply.code(404).send({ error: { message: "渠道商不存在" } });
			const m = getModelDef(modelId);
			if (!m) return reply.code(404).send({ error: { message: "模型不存在" } });
			if (m.hidden) return reply.code(400).send({ error: { message: "内部计费模型不可禁用（会打断其用户的手续费扣费）" } });
			const b = (req.body ?? {}) as { blocked?: boolean };
			const r = setAgentModelAccess(id, modelId, !!b.blocked);
			if (!r.ok) return reply.code(400).send({ error: { message: r.error || "保存失败" } });
			return { ok: true, blocked: !!b.blocked };
		});

		// （P1 移除：激活码签发价（平台默认/按商单设）与 源站默认渠道商价格 全部端点——
		//   统一定价 + 免费码：激活码签发免费、面额从商积分池实扣，无「签发价」概念）

		// ── 共享素材库（第120轮）：源站权限高——看全部（含各渠道商的库），建平台库，管/删任意库 ──
		const sharedLibView = (l: { id: string; name: string; ownerAudience: string; enabled: boolean; createdAt: string }) => ({
			id: l.id, name: l.name, enabled: l.enabled, createdAt: l.createdAt,
			ownerAudience: l.ownerAudience,
			ownerName: l.ownerAudience === "platform" ? "源站" : getAgent(l.ownerAudience)?.name || `（已删渠道商 ${l.ownerAudience}）`,
			...libraryCounts(l.id),
		});
		// 渠道商范围（第175轮）：归属=创建方受众 ownerAudience（"platform"=源站建的库）
		api.get("/admin-api/shared-libs", async (req) => {
			const scope = audScope(req.query as Record<string, string | undefined>);
			const items = scope.all
				? listAllLibraries()
				: listLibrariesByAudience(scope.platform ? PLATFORM_AUDIENCE : scope.agentId!);
			return { items: items.map(sharedLibView) };
		});
		api.post("/admin-api/shared-libs", async (req, reply) => {
			const { name, password } = (req.body ?? {}) as { name?: string; password?: string };
			const r = createSharedLibrary({ name, password, ownerAudience: "platform" });
			if (!r.ok) return reply.code(400).send({ error: { message: r.error } });
			return { ok: true, library: sharedLibView(r.library) };
		});
		api.put("/admin-api/shared-libs/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			const { name, password, enabled } = (req.body ?? {}) as { name?: string; password?: string; enabled?: boolean };
			const r = updateSharedLibrary(id, { name, password, enabled });
			if (!r.ok) return reply.code(r.error === "共享库不存在" ? 404 : 400).send({ error: { message: r.error } });
			return { ok: true, library: sharedLibView(r.library) };
		});
		api.delete("/admin-api/shared-libs/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			if (!deleteSharedLibrary(id)) return reply.code(404).send({ error: { message: "共享库不存在" } });
			return { ok: true };
		});
		// 详情（只读预览）：文件夹列表 + 按文件夹取素材记录——预览直连 OSS 直链，服务端不代理不落盘
		api.get("/admin-api/shared-libs/:id/folders", async (req, reply) => {
			const { id } = req.params as { id: string };
			if (!getSharedLibrary(id)) return reply.code(404).send({ error: { message: "共享库不存在" } });
			return { items: listSharedFolders(id).map((f) => ({ id: f.id, name: f.name, count: f.count, by: f.by, createdAt: f.createdAt })) };
		});
		api.get("/admin-api/shared-folders/:id/assets", async (req, reply) => {
			const folder = getSharedFolder((req.params as { id: string }).id);
			if (!folder) return reply.code(404).send({ error: { message: "文件夹不存在" } });
			return {
				items: listSharedFolderAssets(folder.id).map((a) => ({
					id: a.id, assetId: a.assetId,
					// id 是真理：台账里有该资产则用其当前 OSS 直链，否则用登记时的 url 缓存
					url: (a.assetId && getAsset(a.assetId)?.url) || a.url,
					name: a.name, mime: a.mime, by: a.by, createdAt: a.createdAt,
				})),
			};
		});

		// ── OSS 对象存储设置（密钥只存服务端；secret 返回时脱敏）──
		api.get("/admin-api/settings/oss", async () => {
			const o = getOssConfig();
			const tail = o.secretAccessKey ? o.secretAccessKey.slice(-4) : "";
			return {
				endpoint: o.endpoint, bucket: o.bucket, accessKeyId: o.accessKeyId,
				region: o.region, publicBase: o.publicBase,
				secretMasked: o.secretAccessKey ? "****" + tail : "",
				configured: isOssConfigured(),
			};
		});
		api.put("/admin-api/settings/oss", async (req) => {
			const b = (req.body ?? {}) as Record<string, string>;
			const patch: Record<string, string> = {};
			for (const k of ["endpoint", "bucket", "accessKeyId", "region", "publicBase"]) {
				if (b[k] !== undefined) patch[k] = b[k];
			}
			// secret 仅在传入“非掩码”新值时更新，避免被 **** 覆盖清空
			if (b.secretAccessKey && !b.secretAccessKey.startsWith("****")) patch.secretAccessKey = b.secretAccessKey;
			setOssConfig(patch);
			return { ok: true, configured: isOssConfigured() };
		});
		api.post("/admin-api/settings/oss/test", async () => ossSelfTest());

		// ── 注册与安全（P2 商业化改造：注册开关/赠送/频控/黑名单/SMTP/短信/设备上限）──
		api.get("/admin-api/settings/register", async () => {
			const r = getRegisterSettings();
			return {
				enabled: r.enabled,
				giftCredits: r.giftCredits,
				ipRegPerDay: r.ipRegPerDay,
				ipSendPerHour: r.ipSendPerHour,
				ipSendPerDay: r.ipSendPerDay,
				emailDomainBlacklist: r.emailDomainBlacklist,
				// 密钥脱敏：只回「是否已配」；表单密钥框留空提交=不改
				smtp: { host: r.smtp?.host || "", port: r.smtp?.port || 465, secure: r.smtp?.secure !== false, user: r.smtp?.user || "", from: r.smtp?.from || "", hasPass: !!r.smtp?.pass },
				sms: { provider: "aliyun", accessKeyId: r.sms?.accessKeyId || "", signName: r.sms?.signName || "", templateCode: r.sms?.templateCode || "", hasSecret: !!r.sms?.accessKeySecret },
				smtpConfigured: isSmtpConfigured(),
				smsConfigured: isSmsConfigured(),
				deviceLimit: getDeviceLimit(),
			};
		});
		api.put("/admin-api/settings/register", async (req) => {
			const b = (req.body ?? {}) as Record<string, unknown>;
			const patch: Record<string, unknown> = {};
			for (const k of ["enabled", "giftCredits", "ipRegPerDay", "ipSendPerHour", "ipSendPerDay", "emailDomainBlacklist", "smtp", "sms"]) {
				if (b[k] !== undefined) patch[k] = b[k];
			}
			setRegisterSettings(patch as Parameters<typeof setRegisterSettings>[0]);
			if (b.deviceLimit !== undefined) setDeviceLimit(b.deviceLimit);
			return { ok: true, smtpConfigured: isSmtpConfigured(), smsConfigured: isSmsConfigured(), deviceLimit: getDeviceLimit() };
		});
		// SMTP 自检：发一封测试邮件（配置错误在此现形，不必等真用户注册）
		api.post("/admin-api/settings/register/test-mail", async (req, reply) => {
			const { to } = (req.body ?? {}) as { to?: string };
			if (!to || !to.includes("@")) return reply.code(400).send({ error: { message: "请填写收件邮箱" } });
			try {
				await sendMail(to, "【灵创工场】SMTP 配置测试", "这是一封测试邮件——收到即说明 SMTP 配置正确，注册验证码通道可用。");
				return { ok: true };
			} catch (err) {
				return reply.code(502).send({ error: { message: `发送失败：${(err as Error).message}` } });
			}
		});

		// ── 积分流水（第183轮结算闸门附带产物）──
		// 只读对账用：每次结算（生成扣费/失败退款/重启补退）一条，含每个账户的 pre/post 余额。
		// accountId 可传用户或渠道商 id；ref 可传 logId/taskId 精确回溯某一单。
		api.get("/admin-api/credit-ops", async (req) => {
			const q = req.query as { accountId?: string; ref?: string; limit?: string };
			return { items: listCreditOps({ accountId: q.accountId || undefined, ref: q.ref || undefined, limit: Number(q.limit) || 200 }) };
		});

		// ── 收藏与配额（P1）──
		// 语义提醒：收藏=永久保留额度。平台收藏（管理端二次收藏/审核）**优先级最高且不占用户配额**——
		// 用户全取消了，只要平台还收着，该素材依然永久保留。
		api.get("/admin-api/quota", async () => {
			const users = new Map(listUsers().map((u) => [u.id, u]));
			const teamMap = new Map(listTeams().map((t) => [t.id, t.name]));
			const rows = favoriteOwnersOverview(200).map((o) => {
				const u = o.ownerType === "user" ? users.get(o.ownerId) : undefined;
				const base = o.ownerType === "platform" ? 0 : o.ownerType === "team" ? getTeamLibQuotaBytes() : u?.favQuotaBytes && u.favQuotaBytes > 0 ? u.favQuotaBytes : getFavQuotaBytes();
				const grant = o.ownerType === "platform" ? 0 : grantedBytes(o.ownerType as "user" | "team", o.ownerId);
				return {
					...o,
					name: o.ownerType === "platform" ? "平台收藏（审核）" : o.ownerType === "team" ? teamMap.get(o.ownerId) ?? "（已解散）" : u?.name || "（未注册）",
					baseBytes: base,
					grantBytes: grant,
					limitBytes: base + grant,
					overridden: o.ownerType === "user" && !!u?.favQuotaBytes,
				};
			});
			return {
				owners: rows,
				defaults: { favQuotaBytes: getFavQuotaBytes(), teamLibQuotaBytes: getTeamLibQuotaBytes() },
				storageCode: { user: getStorageCodeSpec("user"), team: getStorageCodeSpec("team") },
				pinnedAssets: favoritedAssetCount(),
				codes: listStorageCodes().slice(0, 300).map((c) => ({ ...c, agentName: c.agentId ? getAgent(c.agentId)?.name : undefined })),
			};
		});
		api.put("/admin-api/quota/defaults", async (req) => {
			const b = (req.body ?? {}) as Record<string, unknown>;
			if (b.favQuotaBytes !== undefined) setFavQuotaBytes(b.favQuotaBytes);
			if (b.teamLibQuotaBytes !== undefined) setTeamLibQuotaBytes(b.teamLibQuotaBytes);
			if (b.storageCodeUser) setStorageCodeSpec("user", b.storageCodeUser as never);
			if (b.storageCodeTeam) setStorageCodeSpec("team", b.storageCodeTeam as never);
			return { ok: true, defaults: { favQuotaBytes: getFavQuotaBytes(), teamLibQuotaBytes: getTeamLibQuotaBytes() }, storageCode: { user: getStorageCodeSpec("user"), team: getStorageCodeSpec("team") } };
		});
		// 平台收藏：管理端二次收藏（审核后钉住），不占任何人的配额、优先级最高
		api.post("/admin-api/quota/pin", async (req, reply) => {
			const { assetId } = (req.body ?? {}) as { assetId?: string };
			if (!assetId) return reply.code(400).send({ error: { message: "缺少 assetId" } });
			if (!getAsset(assetId)) return reply.code(404).send({ error: { message: "资产不存在" } });
			addFavorite(assetId, "platform", "", { limitBytes: Number.MAX_SAFE_INTEGER, usedBytes: 0 }, 0);
			return { ok: true };
		});
		api.delete("/admin-api/quota/pin/:assetId", async (req) => {
			const { assetId } = req.params as { assetId: string };
			return removeFavorite(assetId, "platform", "");
		});
		// 源站签发扩容卡（不扣任何积分——与源站发激活码同语义）
		api.post("/admin-api/storage-codes", async (req) => {
			const b = (req.body ?? {}) as { count?: number; note?: string; target?: string };
			const target: "user" | "team" = b.target === "team" ? "team" : "user";
			const spec = getStorageCodeSpec(target);
			return { items: createStorageCodes(Number(b.count) || 1, target, { bytes: spec.bytes, days: spec.days }, { note: b.note }) };
		});
		api.delete("/admin-api/storage-codes/:code", async (req, reply) => {
			const r = deleteStorageCode((req.params as { code: string }).code);
			if (!r.ok) return reply.code(400).send({ error: { message: r.error } });
			return { ok: true };
		});

		// ── 保留策略与清理预览 ──
		api.get("/admin-api/retention", async () => sweepPreview());
		api.put("/admin-api/retention", async (req) => {
			const b = (req.body ?? {}) as Record<string, unknown>;
			return { ok: true, days: setRetentionDays({ tmp: Number(b.tmp), unref: Number(b.unref), ref: Number(b.ref) }) };
		});

		// ── P3 清理执行（第223轮）──
		// 三道闸门：mode（off 默认/dry 试运行/on 真删）、scope（tmp 首批只清 TP / all 全部）、每轮上限。
		// 首次把 mode 拨离 off 时自动执行存量特赦（方案 §9）；候选查询与预览共用（retention.listSweepCandidates）。
		api.get("/admin-api/cleanup", async () => cleanupOverview());
		api.put("/admin-api/cleanup", async (req, reply) => {
			const b = (req.body ?? {}) as Record<string, unknown>;
			const r = setCleanupConfig({ mode: b.mode, scope: b.scope });
			if (!r.ok) return reply.code(400).send({ error: { message: r.error } });
			return { ok: true, amnestyJustRan: r.amnestyJustRan, ...cleanupOverview() };
		});
		api.post("/admin-api/cleanup/run", async () => ({ ok: true, report: await runCleanupOnce("manual") }));

		// ── 存储容量（P0）：纯 SQLite 聚合，不碰 OSS（页面秒开，可随时刷新）──
		// 对账/清理是**写操作**，不放在这里——走 server/scripts/reconcile.mjs（见 scripts/README-P0.md）。
		api.get("/admin-api/storage/stats", async () => {
			const users = new Map(listUsers().map((u) => [u.id, u.name]));
			const agents = new Map(listAgents().map((a) => [a.id, a.name]));
			const stats = storageStats({ user: (id) => users.get(id), agent: (id) => agents.get(id) });
			const profiles = Object.values(getProfiles()).map((p) => ({
				id: p.id, bucket: p.bucket, layout: p.layout, writable: p.writable, active: p.active, publicBase: p.publicBase,
			}));
			return { ...stats, profiles, ossConfigured: isOssConfigured() };
		});
	});
}
