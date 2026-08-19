/**
 * 用户端路由。
 *  公开：/v1/login（校验 accessKey）、/v1/assets/:id/raw（<img> 直读，无法带头）。
 *  鉴权：/catalog /generate /tasks /batch /assets /heartbeat（Bearer accessKey）。
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireAccessKey, deviceIdOf } from "./auth.ts";
import { buildCatalog } from "./catalog.ts";
import { dispatchGenerate, rehostVideo } from "./translators/index.ts";
import { getOssConfig } from "./store/settings.ts";
import { getTaskState, createCompletedTask, setTaskBilling, setBillingReverseHook, rewriteTaskRawResult } from "./store/tasks.ts";
import { settle, reverse, type SettleResult } from "./store/credits.ts";
import { createAsset, getAsset, getAssetBytes, assetUrl, isAssetAlive, reputAsset, beginDirectAsset, commitDirectAsset, runWithAssetOwner, touchAssetRefs, thumbKeyOf, setAssetThumb, thumbUrlOf, findAssetBySha } from "./store/assets.ts";
import { listFavorites, addFavorite, removeFavorite, favoriteFlags, favoriteUsage, grantQuota, grantedBytes, listGrants } from "./store/favorites.ts";
import { getStorageCode, useStorageCode } from "./store/storageCodes.ts";
import { getFavQuotaBytes, getRegisterSettings } from "./store/settings.ts";
import { genCaptcha, verifyCaptcha, issueCode, verifyCode, checkAndNoteRegister, isBlacklistedEmailDomain } from "./store/regGuard.ts";
import { sendCodeMail, isSmtpConfigured } from "./services/mailer.ts";
import { sendSmsCode, isSmsConfigured } from "./services/smsAliyun.ts";
import { profileOf } from "./store/storage.ts";
import { isOssConfigured, ossPresignPut, ossPublicUrl } from "./store/oss.ts";
import { getUser, getUserByAccessKey, getUserByAccount, verifyUserPassword, bindAccount, setUserPassword, createUser, registerDeviceOnLogin, isEmailAccount, isPhoneAccount, getUserByInviteCode, ensureUserInviteCode, invitedCountOf, grantCredits, transferCredits, dailySpentToday, genAccessKey, persistUsers } from "./store/users.ts";
import type { User } from "./store/users.ts";
import {
	teamOfUser, createTeam, updateTeam, removeTeamMember, dissolveTeam, sanitizeTeams, effectiveTeamLimit,
	inviteToTeam, removeInvite, invitesForUser, acceptInvite, grantedOf, bumpGranted, settleMemberGrant,
} from "./store/teams.ts";
import type { Team } from "./store/teams.ts";
import { getModelDef, resolveModelCost, modelAllowedForAgent } from "./store/models.ts";
import type { ModelDef } from "./store/models.ts";
import { familyName } from "./store/families.ts";
import { refVideoBillingParams } from "./refVideoBilling.ts";
import { checkMaterialLimits } from "./materialLimits.ts";
import { scrubChannelInfo } from "./errorScrub.ts";
import { audienceOf, applyAgentFeatureGate, getAgentByInviteCode } from "./store/agents.ts";
import { modeName, modeDisabled } from "./store/modes.ts";
import {
	getLibrary, searchLibraries, verifyLibraryPassword, joinLibrary, leaveLibrary, memberLibraries, isMember,
	libraryCounts, listFolders, createFolder, getFolder, listFolderAssets, addFolderAssets,
	createLibrary, updateLibrary, deleteLibrary, deleteFolder, deleteAssetRec, getAssetRec,
} from "./store/sharedLibs.ts";
import { isRelay, sourceFetch, jsonOf, relayCatalog, estimateCostFromCatalog, chargeLocalMirror, ledgerRecord, ledgerSettleTerminal } from "./relay.ts";
import { config } from "./config.ts";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./store/db.ts";
import { redeemCode } from "./store/redeemCodes.ts";
import { startLog, finishLog, listLogs, getLog, rewriteLogResult, logSummary, PURPOSE_LABELS, type LogEntry } from "./store/logs.ts";
import { buildDownloadManifest, parseDownloadQuery } from "./store/assetExport.ts";
import type { GenerateRequest, BatchRequest, BatchState, TaskState, Capability } from "./contract.ts";

function baseUrlOf(req: FastifyRequest): string {
	return `${req.protocol}://${req.headers.host}`;
}

function fillAssetUrls(state: TaskState, baseUrl: string): TaskState {
	if (state.result?.assets?.length) {
		state.result.assets = state.result.assets.map((a) => ({ ...a, url: a.url || assetUrl(baseUrl, a.id) }));
	}
	return state;
}

function inferCapability(mime: string): Capability {
	if (mime.startsWith("image/")) return "image";
	if (mime.startsWith("video/")) return "video";
	if (mime.startsWith("audio/")) return "audio";
	return "text";
}

function bearer(req: FastifyRequest): string | undefined {
	const m = (req.headers.authorization ?? "").match(/^Bearer\s+(.+)$/i);
	return m?.[1]?.trim();
}

const batches = new Map<string, string[]>();
let _batchSeq = 0;

/** 团队信息投影（第172轮，登录/心跳/个人中心共用）。
 *  ⚠ 共享积分模式的团员 credits 下发**团队池余额**（=团长余额）——客户端积分显示/402 预检
 *  天然对齐服务端实扣（planBilling 扣的就是这口池），无需客户端特判。 */
function sessionTeamView(user: User): { credits: number; team?: { id: string; name: string; role: "leader" | "member"; creditMode: Team["creditMode"]; leaderName?: string; memberCount: number; poolCredits?: number; sharedLibId?: string } } {
	const team = teamOfUser(user.id);
	if (!team) return { credits: user.credits };
	const leader = getUser(team.leaderId);
	const role: "leader" | "member" = team.leaderId === user.id ? "leader" : "member";
	const shared = team.creditMode === "shared";
	return {
		credits: shared && role === "member" && leader ? leader.credits : user.credits,
		team: {
			id: team.id,
			name: team.name,
			role,
			creditMode: team.creditMode,
			leaderName: leader ? (leader.name || leader.account) : undefined,
			memberCount: team.memberIds.length + 1,
			poolCredits: shared && leader ? leader.credits : undefined,
			sharedLibId: team.sharedLibId,
		},
	};
}

/**
 * 计费解算（P1 经济模型翻转，2026-08 商业化改造，⚠ 勿回退成链式双扣费）：
 *  - **统一定价**：所有用户（平台直属/渠道商名下）一律按源站平台价扣自己的积分；
 *  - **渠道商不再按请求结算**——其成本已在「买积分 + 给用户分发（兑换码/激活码面额实扣）」
 *    环节体现，settle 的 agents 恒为空数组；
 *  - 余额不足 → reject 402。
 * ⚠ 此处语义须与 catalog 投影（客户端预估=平台价，无渠道商换价）保持一致。
 */
/**
 * 团队共享积分（第172轮）：用户在积分方式=shared 的团队里且不是团长 → 扣款人=团长（共享池=团长余额）。
 * 团长缺失（被删等，懒清理未跑到）回退扣自己。dispatch 模式/无团队=扣自己。
 */
function teamPayerFor(user: User): { payer: User; team?: Team } {
	const team = teamOfUser(user.id);
	if (!team || team.creditMode !== "shared" || team.leaderId === user.id) return { payer: user, team };
	const leader = getUser(team.leaderId);
	return { payer: leader ?? user, team };
}

/**
 * 用户的收藏配额现状（P1）。
 * 生效上限 = 按用户覆盖(User.favQuotaBytes) ?? 全局默认(200MB) + 未过期扩容卡合计。
 * 已用 = 其收藏资产的 size_bytes 实时 SUM（不做计数器——不同步是经典 bug）。
 */
function favQuotaById(ownerId: string, overrideBytes?: number): { limitBytes: number; usedBytes: number; baseBytes: number; grantBytes: number; count: number } {
	const baseBytes = overrideBytes && overrideBytes > 0 ? overrideBytes : getFavQuotaBytes();
	const grantBytes = grantedBytes("user", ownerId);
	const used = favoriteUsage("user", ownerId);
	return { limitBytes: baseBytes + grantBytes, usedBytes: used.bytes, baseBytes, grantBytes, count: used.count };
}
function userFavQuota(u: User): ReturnType<typeof favQuotaById> {
	return favQuotaById(u.id, u.favQuotaBytes);
}

function planBilling(
	user: User,
	md: ModelDef | undefined,
	params?: Record<string, unknown>,
): { cost: number; payer: User; reject?: string } {
	const cost = md ? resolveModelCost(md, params) : 0;
	// 共享积分模式：余额校验/扣费对象=团长的池；价格口径不变（统一平台价，catalog 预估仍=实扣）
	const { payer } = teamPayerFor(user);
	if (cost > 0 && payer.credits < cost) {
		return {
			cost, payer,
			reject: payer.id === user.id
				? `额度不足：本次需 ${cost}，剩余 ${payer.credits}`
				: `团队积分不足：本次需 ${cost}，团队池剩余 ${payer.credits}`,
		};
	}
	return { cost, payer };
}

/**
 * 提交**前**的链式预扣（第183轮改：原先在 `await dispatchGenerate` 之后扣）。
 *
 * ⚠ 勿再挪回 dispatch 之后。旧顺序 planBilling(查余额) → await 上游提交(秒级) → 扣款，
 * 中间那个秒级窗口里并发请求都能通过余额预检，回来时 `chargeCreditsAs` 静默返回 ok:false
 * （返回值当时被丢弃）→「用户没扣、渠道商照扣」；异步任务还会按 plan 金额登记 billing，
 * 失败退款退掉一笔从未扣过的钱 → 凭空造币。现在校验与扣款同处一个同步块，窗口归零。
 *
 * 钱从 plan.payer 扣（共享模式=团长的池）、消耗统计记在实际用户名下。
 * P1 起 agents 恒空（渠道商不再按请求结算）；settle/reverse 框架保留——
 * 切换前的历史扣款（billing 快照带 agentCosts）退款仍会原路两侧同退。
 */
function chargeBilling(
	user: User,
	plan: { cost: number; payer: User },
	ref?: string,
): SettleResult {
	return settle({
		reason: "generate",
		ref,
		payerId: plan.payer.id,
		statsUserId: user.id,
		userAmount: plan.cost,
		agents: [],
	});
}

/**
 * 渠道节点计费（P3 独立部署）：付款人=该商积分池，平台价，无用户侧。
 *  - settle 走 agents 段（userAmount=0，payerId 仅留痕）——池不足=一分不动；
 *  - 池不足对节点回「服务暂不可用，请联系你的服务商」同款中性文案（终端用户不该看到
 *    分销机制），另附 reason 供节点侧管理端识别真因。
 */
function planNodeBilling(agent: import("./store/agents.ts").Agent, md: ModelDef | undefined, params?: Record<string, unknown>): { cost: number; reject?: string } {
	const cost = md ? resolveModelCost(md, params) : 0;
	if (cost > 0 && agent.credits < cost) {
		return { cost, reject: "服务暂不可用，请联系你的服务商" };
	}
	return { cost };
}

function chargeNodeBilling(agent: import("./store/agents.ts").Agent, cost: number, traceUserId: string, ref?: string): SettleResult {
	return settle({
		reason: "generate",
		ref,
		payerId: traceUserId,
		statsUserId: traceUserId,
		userAmount: 0,
		agents: cost > 0 ? [{ id: agent.id, cost }] : [],
	});
}

/**
 * 节点转发请求的本地用户留痕 id（`nu:` 前缀与真实用户 id 空间隔开）。
 * 用途：日志 userId / 资产归属 user_id / 任务 billing 归属——纯留痕，源站不据此找用户。
 */
function nodeUserTrace(req: FastifyRequest): string {
	const uid = String(req.headers["x-node-user"] ?? "").trim().slice(0, 64);
	return uid ? `nu:${req.agentNode!.id}:${uid}` : `nu:${req.agentNode!.id}`;
}
function nodeUserName(req: FastifyRequest): string | undefined {
	const raw = String(req.headers["x-node-user-name"] ?? "").trim();
	if (!raw) return undefined;
	try {
		return decodeURIComponent(raw).slice(0, 64);
	} catch {
		return raw.slice(0, 64);
	}
}

/**
 * 转存来源域名白名单（防 SSRF：rehost 会由服务端 fetch 任意 url）。
 *  - 先阻断内网/回环/链路本地地址（基本 SSRF 防护）；
 *  - 再按已知媒体/上游域名后缀 + 已配 OSS 自定义域名放行，其余拒绝。
 * 新增上游渠道时在 ALLOW_SUFFIXES 补后缀即可。
 */
const REHOST_ALLOW_SUFFIXES = [
	".r2.dev",
	".r2.cloudflarestorage.com",
	".cloudflarestorage.com",
	".jian1.vip",
	"megabyai.cc",
	".g-aisc.com",
	".sudashuiapi.com",
	".aistarslab.com",
	".aistarslab.sticki.cn", // 星辰成片 CDN（真机实测域，时效签名直链）
	".aixyzz.com", // 画影（AI-Studio）API/封面域
	".tripcdn.com", // 画影成片托管域（真机实测 file.tripcdn.com 直链）
	".dimensio.cn", // Dimensio（jimeng.dimensio.cn）API 域
	".capcut.com", // Dimensio 成片托管域（真机实测 v16-cc.capcut.com 剪映 CDN 签名时效直链）
	"aivideo.beauty", // Aivide 2.0（aivideo.beauty）API 域（成片 CDN 域待真机实测，若另有托管域在此增补）
	"museai.vip", // 简梦M（MuseAI）API 域（文档成片示例托管 capcut CDN——上方 .capcut.com 已放行）
	"zexitongxue.com", // 简梦Z API 域（成片可能返回本站绝对地址）
	".chre3.com", // 简梦T（llm.chre3.com）API 域（文档成片示例 llm.chre3.com/outputs/*.mp4 本站托管）
	".vosle.xyz", // 简梦F（new.vosle.xyz）API 域（成片本站托管、下载须带 Bearer——轮询循环经 resultHeaders 带头转存）
	".aiid.edu.kg", // 出海营（api.aiid.edu.kg）API 域（成片若返回本站相对/绝对地址）
	".zhongzhuan.chat", // 出海营素材/成片代理域（文档示例 imageproxy.zhongzhuan.chat）
	".xienlive.com", // 算力（OctopusAI）API 域（第217轮；成片若返回本站地址）
	".vlabvod.com", // 算力成片 CDN（query 示例 v6-artist.vlabvod.com 签名时效直链——裸 fetch 可下、完成即转存）
	".byteimg.com", // 算力封面托管域（query 示例 p26-dreamina-sign.byteimg.com）
	".volces.com", // 简梦Z 豆包线成片托管域（文档示例 ark-acg-*.tos-cn-beijing.volces.com 火山官方临时 CDN 签名直链）
	".808relay.com", // Skylee（api/api2.808relay.com）API 域（第230轮；结果图若返回本站直链）
	// ⚠ Skylee 结果图的 CDN 域未知（无 Key 无从实测）——若真单转存失败（日志见「下载结果资产」报错），
	//    到请求记录 ④ 段看 data[0].url 的域名并在此增补后缀即可。
	".congchen.top", // congge（聪宸）API 域（第233轮；成片下载端点 /v1/videos/{id}/content 本站托管，须带 Bearer）
	"congchen.top",
	// ⚠ congge 结果图/成片的 CDN 域未知（文档只写「https://xxxx/xxx.png」占位）——同上，
	//    真单转存失败时到请求记录 ④ 段看实际域名并在此增补。
	".autodl.art", // autodl（autodl.art）API 域（第234轮；结果 results[].url 若为本站托管，下载防御式带 Token）
	"autodl.art",
	// ⚠ autodl 成片的实际托管域未知（文档只写「https://」占位、且明言链接时效很短）——
	//    真单转存失败时到请求记录 ④ 段看 results[].url 实际域名并在此增补后缀。
	".aliyuncs.com",
	".myqcloud.com",
	".cos.ap-guangzhou.myqcloud.com",
];
function isRehostHostAllowed(u: string): boolean {
	let host = "";
	try {
		host = new URL(u).hostname.toLowerCase();
	} catch {
		return false;
	}
	// 阻断内网/回环/链路本地（SSRF 核心防护）
	if (/^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|::1|\[::1\])/.test(host)) return false;
	if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
	// 已配 OSS 自定义域名放行
	try {
		const ob = new URL(getOssConfig().publicBase).hostname.toLowerCase();
		if (ob && (host === ob || host.endsWith("." + ob))) return true;
	} catch {
		/* publicBase 未配 */
	}
	return REHOST_ALLOW_SUFFIXES.some((s) => host.endsWith(s));
}

/** relay 通用透传（P3 渠道节点）：把当前请求原样转发源站（path 缺省=原始 url 含查询串），
 *  携带 x-node-user 本地用户留痕；响应状态码+JSON 原样回给客户端。 */
async function relayProxy(
	req: FastifyRequest,
	reply: import("fastify").FastifyReply,
	opts?: { path?: string; method?: string; body?: unknown },
): Promise<unknown> {
	const u = req.user!;
	try {
		const hasBody = opts?.body !== undefined;
		const res = await sourceFetch(opts?.path ?? req.url, {
			method: opts?.method ?? req.method,
			headers: hasBody ? { "content-type": "application/json" } : undefined,
			body: hasBody ? JSON.stringify(opts?.body) : undefined,
			nodeUser: { id: u.id, name: u.name || u.account },
		});
		const j = await jsonOf(res);
		return reply.code(res.status).send(j ?? {});
	} catch (err) {
		return reply.code(502).send({ error: { message: `源站不可达：${(err as Error).message}` } });
	}
}

/** relay 文件透传（multipart 上传/重传）：读本地文件字段重组 FormData 发源站 */
async function relayProxyFile(req: FastifyRequest, reply: import("fastify").FastifyReply, path: string): Promise<unknown> {
	const u = req.user!;
	const file = await req.file();
	if (!file) return reply.code(400).send({ error: { message: "缺少文件字段 file" } });
	const buf = await file.toBuffer();
	const fd = new FormData();
	fd.append("file", new Blob([new Uint8Array(buf)], { type: file.mimetype || "application/octet-stream" }), file.filename || "file");
	try {
		const res = await sourceFetch(path, { method: "POST", body: fd, nodeUser: { id: u.id, name: u.name || u.account } });
		const j = await jsonOf(res);
		return reply.code(res.status).send(j ?? {});
	} catch (err) {
		return reply.code(502).send({ error: { message: `源站不可达：${(err as Error).message}` } });
	}
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
	// 注册失败退款钩子：异步任务后台失败时退回预扣积分（tasks 不直接依赖 users，故此处注册）。
	// 团队共享积分（第172轮）：钱退给实际扣款人 payerId（共享模式=团长的池），消耗统计回冲实际用户。
	// 第183轮：合成一把尺——用户侧与归属链各级在**一次结算**里同退，走 credits.settle
	setBillingReverseHook((b) => {
		settle({
			reason: "refund",
			ref: b.ref,
			payerId: b.payerId ?? b.userId,
			statsUserId: b.userId,
			userAmount: -b.cost,
			agents: b.agents.map((a) => ({ id: a.id, cost: -a.cost })),
		});
	});

	// ── 公开：登录（账号+密码 或 激活码）──
	// 账号+密码只是便捷层：解析出对应用户后，下游凭证是该用户的 accessKey（API 密钥）。
	app.post("/v1/login", async (req, reply) => {
		const body = (req.body ?? {}) as { accessKey?: string; account?: string; password?: string; deviceId?: string; machineCode?: string };
		let user: User | undefined;
		if (body.account && body.password) {
			const cand = getUserByAccount(body.account);
			if (!cand || !verifyUserPassword(cand, body.password)) {
				return reply.code(401).send({ error: { message: "账号或密码错误" } });
			}
			user = cand;
		} else {
			const key = body.accessKey?.trim() || bearer(req);
			user = key ? getUserByAccessKey(key) : undefined;
		}
		if (!user || !user.enabled) {
			return reply.code(401).send({ error: { message: "凭证无效或已被禁用" } });
		}
		// 登录抢占（第218轮：设备标识=x-device-id 随机 UUID，机器码概念退役；旧客户端字段/头兼容收下）：
		// 本机成为活跃设备，超上限挤掉最久未活跃者
		registerDeviceOnLogin(user, body.deviceId || body.machineCode || deviceIdOf(req));
		// 回传 accessKey：账号登录时客户端据此拿到真凭证并存储
		const tv = sessionTeamView(user);
		return { ok: true, accessKey: user.accessKey, user: { id: user.id, name: user.name, credits: tv.credits, team: tv.team, features: applyAgentFeatureGate(user.agentId, user.features) } };
	});

	// （P2b 移除：激活码注册端点 /v1/register——激活码机制整体退役，注册一律走 /v1/register/account）

	// ── 公开：注册体系（P2 商业化改造——邮箱/手机号验证码注册 + 找回密码；docs/商业化改造方案.md §4）──
	// 防线：图形验证码前置发码 + 发码频控（60s 冷却/IP 时日上限）+ 6 位码 10 分钟错 5 次作废
	//      + 注册 IP 日上限 + 一次性邮箱域黑名单 + 全局注册开关。频控数据落 SQLite（重启不丢）。
	const clientIp = (req: FastifyRequest): string => {
		// 反代场景取 X-Forwarded-For 首个（部署侧需配置可信反代；直连=socket 地址）
		const fwd = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
		return fwd || req.ip || "unknown";
	};
	/** 归一注册目标：邮箱（小写）或手机号；不合法返回 null */
	const normTarget = (raw: unknown): { target: string; channel: "email" | "phone" } | null => {
		const t = String(raw ?? "").trim().toLowerCase();
		if (isEmailAccount(t)) return { target: t, channel: "email" };
		if (isPhoneAccount(t)) return { target: t, channel: "phone" };
		return null;
	};

	// 图形验证码（发验证码前置；一次性）
	app.get("/v1/captcha", async () => genCaptcha());

	// 发验证码（注册）：图形码 → 目标格式/黑名单/占用 → 频控 → SMTP/短信发出
	app.post("/v1/register/send-code", async (req, reply) => {
		const body = (req.body ?? {}) as { target?: string; captchaId?: string; captchaAnswer?: string };
		const cfg = getRegisterSettings();
		if (!cfg.enabled) return reply.code(403).send({ error: { message: "注册暂未开放，请联系管理员" } });
		if (!verifyCaptcha(body.captchaId ?? "", body.captchaAnswer ?? "")) {
			return reply.code(400).send({ error: { message: "图形验证码错误或已过期，请刷新重试" } });
		}
		const t = normTarget(body.target);
		if (!t) return reply.code(400).send({ error: { message: "请填写有效的邮箱或手机号" } });
		if (t.channel === "email" && !isSmtpConfigured()) return reply.code(400).send({ error: { message: "邮箱注册暂未开放，请联系管理员" } });
		if (t.channel === "phone" && !isSmsConfigured()) return reply.code(400).send({ error: { message: "手机号注册暂未开放，请使用邮箱注册" } });
		if (t.channel === "email" && isBlacklistedEmailDomain(t.target)) {
			return reply.code(400).send({ error: { message: "不支持临时邮箱，请使用常用邮箱注册" } });
		}
		if (getUserByAccount(t.target)) return reply.code(400).send({ error: { message: "该账号已注册，请直接登录或找回密码" } });
		const issued = issueCode("register", t.target, clientIp(req));
		if (!issued.ok) return reply.code(429).send({ error: { message: issued.error } });
		try {
			if (t.channel === "email") await sendCodeMail(t.target, issued.code, "注册");
			else await sendSmsCode(t.target, issued.code);
		} catch (err) {
			req.log.warn({ err }, "send register code failed");
			return reply.code(502).send({ error: { message: `验证码发送失败：${(err as Error).message}` } });
		}
		return { ok: true, channel: t.channel };
	});

	// 注册（邮箱/手机号 + 验证码 + 密码 + 可选邀请码）→ 登录态（accessKey 回传 + 设备抢占）。
	// 邀请码（P2b，替代激活码获客）：渠道商码（A 开头）→ 归属该商名下；个人码（U 开头）→ 记录邀请人；
	// 填了但无效 → 明确 400（用户特意填的不能静默忽略）；不填 = 平台直属。
	app.post("/v1/register/account", async (req, reply) => {
		const body = (req.body ?? {}) as { target?: string; code?: string; password?: string; name?: string; inviteCode?: string; deviceId?: string; machineCode?: string };
		const cfg = getRegisterSettings();
		if (!cfg.enabled) return reply.code(403).send({ error: { message: "注册暂未开放，请联系管理员" } });
		const t = normTarget(body.target);
		if (!t) return reply.code(400).send({ error: { message: "请填写有效的邮箱或手机号" } });
		if (getUserByAccount(t.target)) return reply.code(400).send({ error: { message: "该账号已注册，请直接登录" } });
		if ((body.password ?? "").trim().length < 6) return reply.code(400).send({ error: { message: "密码至少 6 位" } });
		// 邀请码先行解析（验证码核销是一次性的——先把能拒的都拒完再核销，防用户白烧一枚验证码）
		let agentId: string | undefined;
		let invitedBy: string | undefined;
		const invite = (body.inviteCode ?? "").trim();
		if (invite) {
			const ag = getAgentByInviteCode(invite);
			const inviter = ag ? undefined : getUserByInviteCode(invite);
			if (ag) {
				if (!ag.enabled) return reply.code(400).send({ error: { message: "该邀请码所属服务商已停用" } });
				agentId = ag.id;
			} else if (inviter) {
				invitedBy = inviter.id;
			} else {
				return reply.code(400).send({ error: { message: "邀请码无效，请核对后重试（可留空注册）" } });
			}
		}
		const vc = verifyCode("register", t.target, body.code ?? "");
		if (!vc.ok) return reply.code(400).send({ error: { message: vc.error } });
		const ipGate = checkAndNoteRegister(clientIp(req));
		if (!ipGate.ok) return reply.code(429).send({ error: { message: ipGate.error } });
		const user = createUser({ credits: cfg.giftCredits, note: "自助注册", agentId, invitedBy });
		const bound = bindAccount(user, t.target, body.password ?? "", body.name);
		if (!bound.ok) return reply.code(400).send({ error: { message: bound.error } }); // 竞态兜底（send-code 后被抢注）
		registerDeviceOnLogin(user, body.deviceId || body.machineCode || deviceIdOf(req));
		const tv = sessionTeamView(user);
		return { ok: true, accessKey: user.accessKey, user: { id: user.id, name: user.name, credits: tv.credits, team: tv.team, features: applyAgentFeatureGate(user.agentId, user.features) } };
	});

	// 找回密码——发验证码：目标不存在也返回 ok（不暴露账号存在性），只是不真正发送
	app.post("/v1/password/send-code", async (req, reply) => {
		const body = (req.body ?? {}) as { target?: string; captchaId?: string; captchaAnswer?: string };
		if (!verifyCaptcha(body.captchaId ?? "", body.captchaAnswer ?? "")) {
			return reply.code(400).send({ error: { message: "图形验证码错误或已过期，请刷新重试" } });
		}
		const t = normTarget(body.target);
		if (!t) return reply.code(400).send({ error: { message: "请填写有效的邮箱或手机号" } });
		if (t.channel === "email" && !isSmtpConfigured()) return reply.code(400).send({ error: { message: "邮箱通道暂未开放，请联系管理员重置密码" } });
		if (t.channel === "phone" && !isSmsConfigured()) return reply.code(400).send({ error: { message: "短信通道暂未开放，请联系管理员重置密码" } });
		const exists = !!getUserByAccount(t.target);
		const issued = issueCode("reset", t.target, clientIp(req));
		if (!issued.ok) return reply.code(429).send({ error: { message: issued.error } });
		if (exists) {
			try {
				if (t.channel === "email") await sendCodeMail(t.target, issued.code, "重置密码");
				else await sendSmsCode(t.target, issued.code);
			} catch (err) {
				req.log.warn({ err }, "send reset code failed");
				return reply.code(502).send({ error: { message: `验证码发送失败：${(err as Error).message}` } });
			}
		}
		return { ok: true, channel: t.channel };
	});

	// 找回密码——重置：验证码核销 + 改密（成功后客户端引导重新登录）
	app.post("/v1/password/reset", async (req, reply) => {
		const body = (req.body ?? {}) as { target?: string; code?: string; newPassword?: string };
		const t = normTarget(body.target);
		if (!t) return reply.code(400).send({ error: { message: "请填写有效的邮箱或手机号" } });
		const vc = verifyCode("reset", t.target, body.code ?? "");
		if (!vc.ok) return reply.code(400).send({ error: { message: vc.error } });
		const user = getUserByAccount(t.target);
		if (!user || !user.enabled) return reply.code(400).send({ error: { message: "账号不存在或已被禁用" } });
		const r = setUserPassword(user, body.newPassword ?? "");
		if (!r.ok) return reply.code(400).send({ error: { message: r.error } });
		return { ok: true };
	});

	// ── 公开：转深度模型文件下发（客户端 transformers.js 经网关拿模型，**不直连外网**）──
	// 首次请求代理 hf-mirror 拉取并缓存到磁盘（data/depth-model/），之后全走本地缓存。
	// 白名单只放行指定模型仓库路径（防被当开放代理）；无鉴权：模型文件是公开静态资源，
	// 且 <fetch> 来自 transformers.js 内部无法定制带头。
	app.get("/v1/depth-model/*", async (req, reply) => {
		const rest = ((req.params as Record<string, string>)["*"] || "").replace(/^\/+/, "");
		const ok = /^onnx-community\/depth-anything-v2-small\/resolve\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/.test(rest) && !rest.includes("..");
		if (!ok) return reply.code(404).send({ error: { message: "不在模型下发白名单" } });
		const cachePath = join(DATA_DIR, "depth-model", ...rest.split("/"));
		const contentType = rest.endsWith(".json") ? "application/json" : "application/octet-stream";
		if (existsSync(cachePath)) {
			return reply.header("Content-Type", contentType).header("Cache-Control", "public, max-age=31536000, immutable").send(await readFile(cachePath));
		}
		const upstream = await fetch(`https://hf-mirror.com/${rest}`, { redirect: "follow" });
		if (!upstream.ok) return reply.code(upstream.status === 404 ? 404 : 502).send({ error: { message: `模型源拉取失败（HTTP ${upstream.status}）` } });
		const bytes = Buffer.from(await upstream.arrayBuffer());
		await mkdir(dirname(cachePath), { recursive: true });
		await writeFile(cachePath, bytes);
		return reply.header("Content-Type", contentType).header("Cache-Control", "public, max-age=31536000, immutable").send(bytes);
	});

	// ── 公开：资产原始字节（<img>/<video> 直读，无法带 Authorization 头）──
	app.get("/v1/assets/:id/raw", async (req, reply) => {
		const { id } = req.params as { id: string };
		// P3 relay：台账在源站——302 到源站同路径（源站该端点公开；OSS 已配时源站再 302 到公网直链）
		if (isRelay()) {
			return reply.code(302).header("location", `${config.source.url}/v1/assets/${encodeURIComponent(id)}/raw`).send();
		}
		const rec = getAsset(id);
		if (!rec) return reply.code(404).send({ error: { message: "资产不存在" } });
		if (rec.url) return reply.redirect(rec.url); // OSS 公网直链
		const bytes = getAssetBytes(id);
		if (!bytes) return reply.code(404).send({ error: { message: "资产字节不可用（未配 OSS 且内存已失）" } });
		return reply.header("Content-Type", rec.contentType).send(bytes);
	});

	// ── 以下需要 accessKey ──
	await app.register(async (api) => {
		api.addHook("preHandler", requireAccessKey);

		// 心跳：能进到这里说明 requireAccessKey 已校验 accessKey 启用 + 机器码激活匹配。
		// 任一不符（被禁用/未激活/换机）→ requireAccessKey 直接 401/403 → 用户端登出。
		api.post("/v1/heartbeat", async (req) => {
			const u = req.user!;
			// features 随心跳下发：管理端改开关后 ≤30s 生效（客户端据此隐藏模式切换等交互键）。
			// 第121轮：先过渠道商级闸门（商关的模式对其名下用户硬禁，AND 合成）
			// 第172轮：team 随心跳下发（共享积分模式的团员 credits=团队池余额，见 sessionTeamView）
			const tv = sessionTeamView(u);
			return { ok: true, user: { id: u.id, name: u.name, credits: tv.credits, team: tv.team, features: applyAgentFeatureGate(u.agentId, u.features) } };
		});

		// P3 渠道节点自身状态：节点管理端「源站连接」卡显示池余额/连通性用（仅 ank- 凭证可达）
		api.get("/v1/node/me", async (req, reply) => {
			const agent = req.agentNode;
			if (!agent) return reply.code(403).send({ error: { message: "仅渠道节点凭证可用" } });
			return { id: agent.id, name: agent.name, credits: agent.credits, enabled: agent.enabled, inviteCode: agent.inviteCode };
		});

		// 个人中心：返回当前用户的积分与消耗统计（P2b 附我的邀请码 + 已邀请人数）
		api.get("/v1/me", async (req) => {
			const u = req.user!;
			const tv = sessionTeamView(u);
			return {
				id: u.id, name: u.name, credits: tv.credits, ownCredits: u.credits, team: tv.team, account: u.account,
				totalSpent: u.totalSpent || 0, dailySpent: dailySpentToday(u), note: u.note,
				inviteCode: ensureUserInviteCode(u),
				invitedCount: invitedCountOf(u.id),
			};
		});

		// API 密钥自助重置（第218轮：accessKey 正名为「API 密钥」——身份验证与后续对接的唯一凭证）：
		// 换新密钥=旧密钥立即失效（其它设备/集成全部 401 登出）；设备表只留本机重新登记。
		api.post("/v1/api-key/regenerate", async (req, reply) => {
			const u = req.user;
			if (!u) return reply.code(403).send({ error: { message: "仅用户凭证可用" } });
			u.accessKey = genAccessKey();
			const dev = (deviceIdOf(req) ?? "").trim();
			u.devices = dev ? [{ id: dev, at: new Date().toISOString() }] : [];
			u.updatedAt = new Date().toISOString();
			persistUsers();
			return { ok: true, apiKey: u.accessKey };
		});

		// 个人消耗统计（第173轮：今日/昨日/近7天，按请求日志聚合——共享模式下消耗仍记在消耗者名下）。
		// 团长可查团员（?userId=）或全团合计（?scope=team）；越权一律 404 不暴露存在性。
		api.get("/v1/stats", async (req, reply) => {
			const u = req.user!;
			const q = req.query as { userId?: string; scope?: string };
			const team = teamOfUser(u.id);
			let userIds: string[] = [u.id];
			let target: { id?: string; name?: string; scope?: "team" } = { id: u.id, name: u.name || u.account };
			if (q.scope === "team") {
				if (!team || team.leaderId !== u.id) return reply.code(403).send({ error: { message: "仅团长可查看全团统计" } });
				userIds = [team.leaderId, ...team.memberIds];
				target = { scope: "team", name: team.name };
			} else if (q.userId && q.userId !== u.id) {
				if (!team || team.leaderId !== u.id || !team.memberIds.includes(q.userId)) {
					return reply.code(404).send({ error: { message: "无权查看该用户统计" } });
				}
				const t = getUser(q.userId);
				if (!t) return reply.code(404).send({ error: { message: "用户不存在" } });
				userIds = [t.id];
				target = { id: t.id, name: t.name || t.account };
			}
			const now = Date.now();
			const d0 = new Date();
			d0.setHours(0, 0, 0, 0);
			const today0 = d0.getTime();
			const DAY = 86400000;
			const sum = (from: number, to: number) => {
				const s = logSummary({ userIds, from, to });
				const byModel = s.byModel.map((m) => ({ model: m.key, count: m.count, success: m.success, credits: m.credits }));
				// 按**家族池**聚合（第173轮：客户端统计页先看家族、点开看组内模型）：
				// 模型 id → ModelDef.familyId → 家族名；已删模型/无家族/hidden 内部模型归「其他」。
				const fam = new Map<string, { familyId: string; familyName: string; count: number; success: number; credits: number; models: typeof byModel }>();
				for (const m of byModel) {
					const fid = getModelDef(m.model)?.familyId || "";
					const key = fid || "__other";
					const g = fam.get(key) ?? { familyId: fid, familyName: fid ? familyName(fid) : "其他", count: 0, success: 0, credits: 0, models: [] };
					g.count += m.count; g.success += m.success; g.credits += m.credits;
					g.models.push(m);
					fam.set(key, g);
				}
				const byFamily = [...fam.values()].sort((a, b) => b.count - a.count);
				return {
					credits: s.credits, count: s.total, success: s.success, failed: s.failed,
					// 明细（第173轮补充：客户端统计页按模型/按步骤）——credits=实际消耗（失败已退不计）
					byModel,
					byFamily,
					byPurpose: s.byPurpose.map((p) => ({ purpose: p.key, label: p.label, count: p.count, success: p.success, credits: p.credits })),
				};
			};
			return {
				target,
				ranges: {
					today: sum(today0, now),
					yesterday: sum(today0 - DAY, today0),
					week: sum(today0 - 6 * DAY, now),
				},
			};
		});

		// 个人中心：管理端手工建号的用户绑定账号+密码（一次性；改密走 /v1/password/change）
		api.post("/v1/bind-account", async (req, reply) => {
			const u = req.user!;
			if (u.account) return reply.code(400).send({ error: { message: "已绑定账号，如需修改请联系管理员" } });
			const { account, password } = (req.body ?? {}) as { account?: string; password?: string };
			const r = bindAccount(u, account ?? "", password ?? "");
			if (!r.ok) return reply.code(400).send({ error: { message: r.error } });
			return { ok: true, account: u.account };
		});

		// 个人中心：登录态自助修改密码（校验旧密码；不动 accessKey——其它设备不掉线）
		api.post("/v1/password/change", async (req, reply) => {
			const u = req.user;
			if (!u) return reply.code(403).send({ error: { message: "仅用户凭证可用" } });
			if (!u.account || !u.passwordHash) return reply.code(400).send({ error: { message: "当前账号未绑定登录密码，请先绑定账号" } });
			const body = (req.body ?? {}) as { oldPassword?: string; newPassword?: string };
			if (!verifyUserPassword(u, body.oldPassword ?? "")) return reply.code(400).send({ error: { message: "当前密码不正确" } });
			const r = setUserPassword(u, body.newPassword ?? "");
			if (!r.ok) return reply.code(400).send({ error: { message: r.error } });
			return { ok: true };
		});

		// 兑换积分码：一次性码，成功则把面额充入余额
		api.post("/v1/redeem", async (req, reply) => {
			const u = req.user!;
			const { code } = (req.body ?? {}) as { code?: string };
			// 归属闸（第175轮）：渠道商签发的码仅其名下用户可兑换；平台直发的码全体可用
			const r = redeemCode(code ?? "", u.id, u.name, u.agentId);
			if (!r.ok) return reply.code(400).send({ error: { message: r.error } });
			const credits = grantCredits(u.id, r.credits) ?? u.credits;
			return { ok: true, added: r.credits, credits };
		});

		// 拉取目录（since 版本一致回 304）
		api.get("/v1/catalog", async (req, reply) => {
			// P3 relay：目录=源站目录缓存透传（源站已按本商开放范围过滤、平台价；正文类模板本就不下发）
			if (isRelay()) {
				const cat = await relayCatalog();
				if (!cat) return reply.code(502).send({ error: { message: "源站目录暂不可达，请稍后重试" } });
				const since0 = (req.query as { since?: string })?.since;
				if (since0 && since0 === cat.version) return reply.code(304).send();
				return cat;
			}
			// 模板按用户归属渠道商下发：平台模板 + 该渠道商自营模板（req.user 由 requireAccessKey 注入）。
			// P3 渠道节点：按该商开放范围/改名/自营模板过滤（与其名下源站用户同一视角，平台价）。
			const catalog = buildCatalog(req.agentNode ? req.agentNode.id : req.user?.agentId);
			const since = (req.query as { since?: string })?.since;
			if (since && since === catalog.version) return reply.code(304).send();
			return catalog;
		});

		// 提交生成（同步文本直接出结果；异步图/视频/音频回 taskId）+ 记录请求
		api.post("/v1/generate", async (req, reply) => {
			const body = req.body as GenerateRequest;
			if (!body?.model) return reply.code(400).send({ error: { message: "缺少 model" } });

			// ── P3 relay：预检（目录预估价）→ 转发源站 → 按源站回传实扣镜像本地扣款 ──
			// ⚠ 勿改成「先扣本地再转发」：预估（目录价）与源站实扣可能有差（参考视频按秒加权），
			// 以源站回传为准才有「金额恒等」；源站拒单（402/403/400）时本地一分未动。
			if (isRelay()) {
				const user = req.user!;
				const { payer } = teamPayerFor(user);
				const estimate = estimateCostFromCatalog(await relayCatalog(), body.model, body.params as Record<string, unknown> | undefined);
				if (estimate > 0 && payer.credits < estimate) {
					return reply.code(402).send({
						error: {
							message: payer.id === user.id
								? `额度不足：本次需 ${estimate}，剩余 ${payer.credits}`
								: `团队积分不足：本次需 ${estimate}，团队池剩余 ${payer.credits}`,
						},
					});
				}
				let res: Response;
				try {
					res = await sourceFetch("/v1/generate", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
						nodeUser: { id: user.id, name: user.name || user.account },
					});
				} catch (err) {
					return reply.code(502).send({ error: { message: `源站不可达：${(err as Error).message}` } });
				}
				const j = await jsonOf(res);
				if (!res.ok) {
					// 源站拒单：本地未扣，状态码+错误原样转（池不足文案源站已中性化）
					return reply.code(res.status).send(j ?? { error: { message: `源站返回 ${res.status}` } });
				}
				const actual = Math.max(0, Number(j?.cost) || 0);
				const payerId = payer.id !== user.id ? payer.id : undefined;
				if (j?.taskId) {
					const taskId = String(j.taskId);
					const log = startLog({ req: body, userId: user.id, userName: user.name, cost: actual, payerId, headers: req.headers });
					const c = chargeLocalMirror(payer, user.id, actual, log.id);
					if (c.shortfall > 0) req.log.warn(`[relay] 本地余额不足实扣 ${actual}（差 ${c.shortfall}）：user=${user.id} task=${taskId}`);
					ledgerRecord(taskId, { u: user.id, p: payerId, c: actual - c.shortfall, log: log.id });
					return { taskId };
				}
				if (String(j?.status ?? "") === "success") {
					const log = startLog({ req: body, userId: user.id, userName: user.name, cost: actual, payerId, headers: req.headers });
					const c = chargeLocalMirror(payer, user.id, actual, log.id);
					if (c.shortfall > 0) req.log.warn(`[relay] 本地余额不足实扣 ${actual}（差 ${c.shortfall}）：user=${user.id} log=${log.id}`);
					finishLog(log.id, { status: "success", response: j?.result });
					return { status: "success", result: j?.result };
				}
				const log = startLog({ req: body, userId: user.id, userName: user.name, cost: 0, headers: req.headers });
				const errText = typeof j?.error === "string" ? j.error : String((j?.error as { message?: string } | undefined)?.message ?? "生成失败");
				finishLog(log.id, { status: "failed", error: errText });
				return reply.code(200).send({ status: "failed", error: errText });
			}

			// ── P3 渠道节点分支：计费=商积分池（平台价），响应回传实扣 cost 供节点镜像扣本地用户 ──
			if (req.agentNode) {
				const agent = req.agentNode;
				const md = getModelDef(body.model);
				if (md && !modelAllowedForAgent(md, agent.id)) {
					return reply.code(403).send({ error: { message: `模型「${md.label}」未对当前账号开放` } });
				}
				if (md?.modeId && !md.hidden) {
					if (modeDisabled(md.modeId)) {
						return reply.code(403).send({ error: { message: `模式「${modeName(md.modeId)}」已停用` } });
					}
					const eff = applyAgentFeatureGate(agent.id, undefined);
					if (eff?.modes?.[md.modeId] === false) {
						return reply.code(403).send({ error: { message: `模式「${modeName(md.modeId)}」未对当前账号开放` } });
					}
				}
				if (md) {
					const matErr = checkMaterialLimits(md.label, md.matLimits, body.inputs);
					if (matErr) return reply.code(400).send({ error: { message: matErr } });
				}
				const rb = await refVideoBillingParams(md, body.params as Record<string, unknown> | undefined, body.inputs);
				if (rb.error) return reply.code(400).send({ error: { message: rb.error } });
				const plan = planNodeBilling(agent, md, rb.params);
				if (plan.reject) return reply.code(402).send({ error: { message: plan.reject }, reason: "pool_insufficient" });
				const trace = nodeUserTrace(req);
				// 节点日志：cost=0（源站无用户侧扣款）+ agentCosts=[池实扣]——门户/管理端经 logCostFor
				// 取到池实扣；启动对账孤儿退款按 agentCosts 原路退池（userAmount 0 对留痕 userId 天然 no-op）。
				const log = startLog({ req: body, userId: trace, userName: nodeUserName(req), cost: 0, agentCosts: plan.cost > 0 ? [{ id: agent.id, cost: plan.cost }] : undefined, ownerId: agent.id, headers: req.headers });
				const billed = chargeNodeBilling(agent, plan.cost, trace, log.id);
				if (!billed.ok) {
					finishLog(log.id, { status: "failed", error: billed.error });
					return reply.code(402).send({ error: { message: billed.error }, reason: "pool_insufficient" });
				}
				const r = await runWithAssetOwner({ userId: trace, agentId: agent.id }, () => dispatchGenerate(body, log.id));
				if (r.kind === "sync" && r.status === "failed") {
					reverse(billed.charged, "refund", log.id);
				} else if (r.kind === "async") {
					setTaskBilling(r.taskId, trace, 0, billed.charged.agents, undefined);
				}
				if (r.kind === "async") return { taskId: r.taskId, cost: plan.cost };
				if (r.status === "failed") return reply.code(200).send({ status: "failed", error: r.error ? scrubChannelInfo(r.error) : r.error, cost: 0 });
				return { status: "success", result: r.result, cost: plan.cost };
			}

			// 额度前置校验：不足则拒绝、不下单
			const user = req.user!;
			const md = getModelDef(body.model);
			// 模型可用性校验：开放范围（第110轮 shareScope）+ 渠道商禁用清单（第121轮）双闸，任一不过直接拒绝，不下单不记账
			if (md && !modelAllowedForAgent(md, user.agentId)) {
				return reply.code(403).send({ error: { message: `模型「${md.label}」未对当前账号开放` } });
			}
			// 模式门禁（第130轮）：模型归属的模式若对该用户（含渠道商链硬闸）关闭 → 403 拒单。
			// hidden 内部计费模型（fee-thirdparty）豁免——模式关不得打断其手续费扣费（同第121轮「hidden 不可禁」）
			if (md?.modeId && !md.hidden) {
				// 第165轮：模式被管理端全局停用 → 对所有账号 403（catalog 已不下发其模型，这里兜底直连/旧缓存请求）
				if (modeDisabled(md.modeId)) {
					return reply.code(403).send({ error: { message: `模式「${modeName(md.modeId)}」已停用` } });
				}
				const eff = applyAgentFeatureGate(user.agentId, user.features);
				if (eff?.modes?.[md.modeId] === false) {
					return reply.code(403).send({ error: { message: `模式「${modeName(md.modeId)}」未对当前账号开放` } });
				}
			}
			// 素材数量硬闸（第145轮）：管理端可按模型限制 图/视/音 素材数量（0=不允许该类素材，
			// 如 933 收紧为 903 即禁垫视频）。超限明确拒单绝不静默裁剪（素材与 @tag 图例按位对齐，
			// 丢一个=整段错位，第118/142轮同尺）；未设=不限（按翻译器/上游既有守卫）。放在计费探测之前（拒单不探时长）。
			if (md) {
				const matErr = checkMaterialLimits(md.label, md.matLimits, body.inputs);
				if (matErr) return reply.code(400).send({ error: { message: matErr } });
			}
			// 参考视频按秒计费（第140轮）：模型声明 refVideoSecondsWeight 时，服务端探测每条参考视频时长
			// （不足1秒算1秒）折算进计费秒数——读不出时长明确拒单（不下单不扣费；发上游的 params 不受影响）
			const rb = await refVideoBillingParams(md, body.params as Record<string, unknown> | undefined, body.inputs);
			if (rb.error) {
				return reply.code(400).send({ error: { message: rb.error } });
			}
			// 双计费：用户按售价、渠道商按结算价（任一侧不足 → 402 拒单）
			const plan = planBilling(user, md, rb.params);
			if (plan.reject) {
				return reply.code(402).send({ error: { message: plan.reject } });
			}
			const cost = plan.cost;

			// agentCosts=归属链各级结算侧实扣（第124轮）：门户/管理端按各自视角显示「自身消耗」用
			// payerId（第183轮）：团队共享模式下钱是从团长池扣的，退款必须退回同一个池——
			// 启动对账走的是日志而非任务表，不记这个字段就会把钱退给从没付过款的团员（凭空造币）
			const log = startLog({ req: body, userId: req.user?.id, userName: req.user?.name, cost, payerId: plan.payer.id !== user.id ? plan.payer.id : undefined, ownerId: user.agentId, headers: req.headers });
			// 预扣（第183轮）：**必须在 dispatch 之前**，理由见 chargeBilling 注释
			const billed = chargeBilling(user, plan, log.id);
			if (!billed.ok) {
				finishLog(log.id, { status: "failed", error: billed.error });
				return reply.code(402).send({ error: { message: billed.error } });
			}
			// 归属上下文：整条生成链（含后台轮询循环里 rehostVideo 产出的成片）落台账时自动带上 user_id/agent_id
			const r = await runWithAssetOwner({ userId: user.id, agentId: user.agentId }, () => dispatchGenerate(body, log.id));

			// 同步失败 → 原路同退（用户与渠道商两侧同进同退）；异步 → 登记**实扣**金额供失败退款
			if (r.kind === "sync" && r.status === "failed") {
				reverse(billed.charged, "refund", log.id);
			} else if (r.kind === "async") {
				setTaskBilling(r.taskId, user.id, billed.charged.userAmount, billed.charged.agents, plan.payer.id);
			}

			if (r.kind === "async") return { taskId: r.taskId };
			// 第168轮：同步失败直接回给客户端的错误同样擦除渠道识别信息（与 failTask/finishLog 同尺）
			if (r.status === "failed") return reply.code(200).send({ status: "failed", error: r.error ? scrubChannelInfo(r.error) : r.error });
			return { status: "success", result: r.result };
		});

		// 轮询任务
		api.get("/v1/tasks/:taskId", async (req, reply) => {
			const { taskId } = req.params as { taskId: string };
			// P3 relay：轮询透传源站；见到终态顺手结算本地台账（失败=镜像退款，幂等防重复退）
			if (isRelay()) {
				const u = req.user!;
				try {
					const res = await sourceFetch(`/v1/tasks/${encodeURIComponent(taskId)}`, { nodeUser: { id: u.id, name: u.name || u.account } });
					const j = await jsonOf(res);
					if (res.ok && j) {
						const st = String(j.status ?? "");
						if (st === "failed") {
							ledgerSettleTerminal(taskId, "failed", { error: typeof j.error === "string" ? j.error : (j.error as { message?: string } | undefined)?.message });
						} else if (st === "success") {
							ledgerSettleTerminal(taskId, "success", { response: j.result });
						}
					}
					return reply.code(res.status).send(j ?? {});
				} catch (err) {
					return reply.code(502).send({ error: { message: `源站不可达：${(err as Error).message}` } });
				}
			}
			const state = getTaskState(taskId);
			if (!state) return reply.code(404).send({ error: { message: "任务不存在" } });
			return fillAssetUrls(state, baseUrlOf(req));
		});

		// 批量提交（每个子任务也记录请求）
		api.post("/v1/batch", async (req, reply) => {
			const body = req.body as BatchRequest;
			if (!Array.isArray(body?.tasks)) return reply.code(400).send({ error: { message: "缺少 tasks" } });

			// ── P3 relay：整批转发源站，按回传 costs（与 taskIds 对位）逐任务镜像扣本地 ──
			if (isRelay()) {
				const user = req.user!;
				const { payer } = teamPayerFor(user);
				const cat = await relayCatalog();
				const totalEstimate = body.tasks.reduce((s, t) => s + estimateCostFromCatalog(cat, t.model, t.params as Record<string, unknown> | undefined), 0);
				if (totalEstimate > 0 && payer.credits < totalEstimate) {
					return reply.code(402).send({ error: { message: `额度不足：本批预估需 ${totalEstimate}，剩余 ${payer.credits}` } });
				}
				let res: Response;
				try {
					res = await sourceFetch("/v1/batch", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
						nodeUser: { id: user.id, name: user.name || user.account },
					});
				} catch (err) {
					return reply.code(502).send({ error: { message: `源站不可达：${(err as Error).message}` } });
				}
				const j = await jsonOf(res);
				if (!res.ok) return reply.code(res.status).send(j ?? { error: { message: `源站返回 ${res.status}` } });
				const taskIds = Array.isArray(j?.taskIds) ? (j.taskIds as string[]) : [];
				const costs = Array.isArray(j?.costs) ? (j.costs as number[]) : [];
				const payerId = payer.id !== user.id ? payer.id : undefined;
				taskIds.forEach((tid, i) => {
					const c0 = Math.max(0, Number(costs[i]) || 0);
					if (c0 <= 0) return;
					const log = startLog({ req: (body.tasks[i] ?? { model: "unknown" }) as GenerateRequest, userId: user.id, userName: user.name, cost: c0, payerId, headers: req.headers });
					const c = chargeLocalMirror(payer, user.id, c0, log.id);
					if (c.shortfall > 0) req.log.warn(`[relay] 批量本地余额不足实扣 ${c0}（差 ${c.shortfall}）：user=${user.id} task=${tid}`);
					ledgerRecord(tid, { u: user.id, p: payerId, c: c0 - c.shortfall, log: log.id });
				});
				return { batchId: j?.batchId, taskIds };
			}

			// ── P3 渠道节点分支：逐任务池计费，响应附 costs（与 taskIds 对位）供节点镜像扣本地用户 ──
			if (req.agentNode) {
				const agent = req.agentNode;
				const trace = nodeUserTrace(req);
				const uname = nodeUserName(req);
				const taskIds: string[] = [];
				const costs: number[] = [];
				const effGate = applyAgentFeatureGate(agent.id, undefined)?.modes;
				for (const t of body.tasks) {
					const tmd = getModelDef(t.model);
					const fail = (msg: string) => {
						taskIds.push(createCompletedTask("text", "failed", undefined, msg, t.clientTaskId).taskId);
						costs.push(0);
					};
					if (tmd && !modelAllowedForAgent(tmd, agent.id)) { fail(`模型「${tmd.label}」未对当前账号开放`); continue; }
					if (tmd?.modeId && !tmd.hidden && modeDisabled(tmd.modeId)) { fail(`模式「${modeName(tmd.modeId)}」已停用`); continue; }
					if (tmd?.modeId && !tmd.hidden && effGate?.[tmd.modeId] === false) { fail(`模式「${modeName(tmd.modeId)}」未对当前账号开放`); continue; }
					if (tmd) {
						const matErr = checkMaterialLimits(tmd.label, tmd.matLimits, t.inputs);
						if (matErr) { fail(matErr); continue; }
					}
					const rb = await refVideoBillingParams(tmd, t.params as Record<string, unknown> | undefined, t.inputs);
					if (rb.error) { fail(rb.error); continue; }
					const plan = planNodeBilling(agent, tmd, rb.params);
					if (plan.reject) { fail(plan.reject); continue; }
					const log = startLog({ req: t, userId: trace, userName: uname, cost: 0, agentCosts: plan.cost > 0 ? [{ id: agent.id, cost: plan.cost }] : undefined, ownerId: agent.id, headers: req.headers });
					const billed = chargeNodeBilling(agent, plan.cost, trace, log.id);
					if (!billed.ok) {
						finishLog(log.id, { status: "failed", error: billed.error });
						fail(billed.error);
						continue;
					}
					const r = await runWithAssetOwner({ userId: trace, agentId: agent.id }, () => dispatchGenerate(t, log.id));
					if (r.kind === "sync" && r.status === "failed") {
						reverse(billed.charged, "refund", log.id);
						taskIds.push(createCompletedTask("text", r.status, r.result, r.error, t.clientTaskId).taskId);
						costs.push(0);
						continue;
					}
					if (r.kind === "async") {
						setTaskBilling(r.taskId, trace, 0, billed.charged.agents, undefined);
						taskIds.push(r.taskId);
					} else {
						taskIds.push(createCompletedTask("text", r.status, r.result, r.error, t.clientTaskId).taskId);
					}
					costs.push(plan.cost);
				}
				_batchSeq += 1;
				const batchId = `b${String(_batchSeq).padStart(6, "0")}`;
				batches.set(batchId, taskIds);
				return { batchId, taskIds, costs };
			}

			const user = req.user!;
			const taskIds: string[] = [];
			const effModes = applyAgentFeatureGate(user.agentId, user.features)?.modes; // 模式门禁（第130轮）：整批同一用户，算一次
			for (const t of body.tasks) {
				// 逐任务校验：模型未开放/模式已禁/任一侧额度不足 → 记一条 failed 任务、跳过下单
				const tmd = getModelDef(t.model);
				if (tmd && !modelAllowedForAgent(tmd, user.agentId)) {
					taskIds.push(createCompletedTask("text", "failed", undefined, `模型「${tmd.label}」未对当前账号开放`, t.clientTaskId).taskId);
					continue;
				}
				if (tmd?.modeId && !tmd.hidden && modeDisabled(tmd.modeId)) {
					// 第165轮：全局停用模式 → 与 /v1/generate 同语义，记 failed 任务跳过下单
					taskIds.push(createCompletedTask("text", "failed", undefined, `模式「${modeName(tmd.modeId)}」已停用`, t.clientTaskId).taskId);
					continue;
				}
				if (tmd?.modeId && !tmd.hidden && effModes?.[tmd.modeId] === false) {
					taskIds.push(createCompletedTask("text", "failed", undefined, `模式「${modeName(tmd.modeId)}」未对当前账号开放`, t.clientTaskId).taskId);
					continue;
				}
				// 素材数量硬闸（第145轮，与 /v1/generate 同尺）：超限 → 记 failed 任务、跳过下单
				if (tmd) {
					const matErr = checkMaterialLimits(tmd.label, tmd.matLimits, t.inputs);
					if (matErr) {
						taskIds.push(createCompletedTask("text", "failed", undefined, matErr, t.clientTaskId).taskId);
						continue;
					}
				}
				// 参考视频按秒计费（第140轮，与 /v1/generate 同尺）：读不出时长 → 记 failed 任务、跳过下单
				const rb = await refVideoBillingParams(tmd, t.params as Record<string, unknown> | undefined, t.inputs);
				if (rb.error) {
					taskIds.push(createCompletedTask("text", "failed", undefined, rb.error, t.clientTaskId).taskId);
					continue;
				}
				const plan = planBilling(user, tmd, rb.params);
				if (plan.reject) {
					taskIds.push(createCompletedTask("text", "failed", undefined, plan.reject, t.clientTaskId).taskId);
					continue;
				}
				const log = startLog({ req: t, userId: req.user?.id, userName: req.user?.name, cost: plan.cost, payerId: plan.payer.id !== user.id ? plan.payer.id : undefined, ownerId: user.agentId, headers: req.headers });
				// 预扣（第183轮，与 /v1/generate 同尺）：批量里前一条扣完余额，后一条这里才会真被拦下
				const billed = chargeBilling(user, plan, log.id);
				if (!billed.ok) {
					finishLog(log.id, { status: "failed", error: billed.error });
					taskIds.push(createCompletedTask("text", "failed", undefined, billed.error, t.clientTaskId).taskId);
					continue;
				}
				const r = await runWithAssetOwner({ userId: user.id, agentId: user.agentId }, () => dispatchGenerate(t, log.id));
				if (r.kind === "sync" && r.status === "failed") {
					reverse(billed.charged, "refund", log.id);
				} else if (r.kind === "async") {
					setTaskBilling(r.taskId, user.id, billed.charged.userAmount, billed.charged.agents, plan.payer.id);
				}
				if (r.kind === "async") taskIds.push(r.taskId);
				else taskIds.push(createCompletedTask("text", r.status, r.result, r.error, t.clientTaskId).taskId);
			}
			_batchSeq += 1;
			const batchId = `b${String(_batchSeq).padStart(6, "0")}`;
			batches.set(batchId, taskIds);
			return { batchId, taskIds };
		});

		api.get("/v1/batch/:batchId", async (req, reply) => {
			if (isRelay()) return relayProxy(req, reply);
			const { batchId } = req.params as { batchId: string };
			const taskIds = batches.get(batchId);
			if (!taskIds) return reply.code(404).send({ error: { message: "批次不存在" } });
			const baseUrl = baseUrlOf(req);
			const states = taskIds
				.map((id) => getTaskState(id))
				.filter((s): s is TaskState => !!s)
				.map((s) => fillAssetUrls(s, baseUrl));
			const summary = {
				total: states.length,
				success: states.filter((s) => s.status === "success").length,
				failed: states.filter((s) => s.status === "failed").length,
				running: states.filter((s) => s.status === "running").length,
				queued: states.filter((s) => s.status === "queued").length,
			};
			const out: BatchState = {
				batchId,
				tasks: states.map((s) => ({ taskId: s.taskId, clientTaskId: s.clientTaskId, status: s.status, progress: s.progress })),
				summary,
			};
			return out;
		});

		// ── 素材直传 OSS（第170轮）：预签名两段式——国内用户字节直传国内桶，绕开跨境服务器中转 ──
		// ①signed：分配 id + 预签名 PUT URL（服务器只签名不过字节）；②complete：HEAD 验对象后补登台账。
		// 客户端任一步失败回退下方 multipart 通道（旧客户端/未配 OSS 均不受影响）。
		const DIRECT_MAX_BYTES = 50 * 1024 * 1024; // 与 index.ts multipart fileSize 上限同尺
		api.post("/v1/assets/direct", async (req, reply) => {
			// P3 relay：直传签发透传源站（字节仍是客户端直传桶，节点不过手）
			if (isRelay()) return relayProxy(req, reply, { body: req.body ?? {} });
			if (!isOssConfigured()) return reply.code(400).send({ error: { message: "未配置 OSS，不支持直传" } });
			const b = (req.body ?? {}) as { contentType?: string; size?: number; prefix?: string; name?: string; sha256?: string };
			if (!b.contentType || typeof b.contentType !== "string") return reply.code(400).send({ error: { message: "缺少 contentType" } });
			if (typeof b.size === "number" && b.size > DIRECT_MAX_BYTES) {
				return reply.code(400).send({ error: { message: `文件超过大小上限（${Math.round(DIRECT_MAX_BYTES / 1024 / 1024)}MB）` } });
			}
			// 内容去重（第224轮）：客户端带 sha256 且整桶已有同内容对象 → 免上传直接复用其链接
			// （最坏情况=谎报哈希的客户端拿到别人文件的链接，对他人无损，不为此引入逐字节校验）
			if (typeof b.sha256 === "string" && /^[0-9a-f]{64}$/.test(b.sha256)) {
				const dup = findAssetBySha(b.sha256);
				if (dup) return { id: dup.id, url: dup.url, dedup: true };
			}
			const prefix = typeof b.prefix === "string" && /^[A-Za-z]{1,12}$/.test(b.prefix) ? b.prefix : undefined;
			const pending = beginDirectAsset(b.contentType, inferCapability(b.contentType), {
				prefix,
				name: b.name,
				owner: req.agentNode ? { userId: nodeUserTrace(req), agentId: req.agentNode.id } : { userId: req.user?.id, agentId: req.user?.agentId },
			});
			// 预签名与公网链都按 active 档（beginDirectAsset 已按同一档生成了 ossKey）
			const putUrl = await ossPresignPut(pending.ossKey, b.contentType, 1800);
			return { id: pending.id, putUrl, url: ossPublicUrl(pending.ossKey), expiresIn: 1800 };
		});
		api.post("/v1/assets/direct/:id/complete", async (req, reply) => {
			if (isRelay()) return relayProxy(req, reply, { body: req.body ?? {} });
			const { id } = req.params as { id: string };
			const r = await commitDirectAsset(id, DIRECT_MAX_BYTES);
			if (!r.ok) return reply.code(400).send({ error: { message: r.error } });
			return { id: r.rec.id, url: assetUrl(baseUrlOf(req), r.rec.id) };
		});

		// 素材上传（multipart）→ 全局唯一 id + 公网 url
		api.post("/v1/assets", async (req, reply) => {
			// P3 relay：素材上传转发源站（multipart 重组；id/url 由源站分配）
			if (isRelay()) return relayProxyFile(req, reply, req.url);
			const file = await req.file();
			if (!file) return reply.code(400).send({ error: { message: "缺少文件字段 file" } });
			const buf = await file.toBuffer();
			const cap = inferCapability(file.mimetype ?? "");
			const q = req.query as { prefix?: string; name?: string };
			const rec = await createAsset(buf, file.mimetype ?? "application/octet-stream", cap, {
				prefix: q.prefix,
				name: q.name ?? file.filename,
				owner: req.agentNode ? { userId: nodeUserTrace(req), agentId: req.agentNode.id } : { userId: req.user?.id, agentId: req.user?.agentId },
			});
			return { id: rec.id, url: assetUrl(baseUrlOf(req), rec.id) };
		});

		// 引用上报（P1）：客户端打开/保存项目时把该项目引用到的 assetId 批量报上来 → 刷 last_ref_at。
		// 保留策略「被引用 +N 天」的唯一数据来源；**观察期从这个端点上线那天开始计时**。
		// 失败对客户端无副作用（不影响打开/保存），故客户端应 fire-and-forget、不要阻塞 UI。
		api.post("/v1/assets/ref", async (req, reply) => {
			const { ids } = (req.body ?? {}) as { ids?: unknown };
			if (!Array.isArray(ids)) return reply.code(400).send({ error: { message: "缺少 ids 数组" } });
			// P3 relay：引用上报透传源站——节点用户的素材同样受源站保留策略保护（观察期语义不断档）
			if (isRelay()) return relayProxy(req, reply, { body: { ids } });
			const r = touchAssetRefs(ids as string[]);
			return { updated: r.updated, needHeal: r.needHeal };
		});

		// 缩略图直传（P1）：客户端生成 256px WebP → 这里签预签名 PUT → 传完回报 → 记 has_thumb。
		// 缩略图不进台账（是原图的附属品，无独立 id、不占配额），只在 assets 行上打个标记。
		api.post("/v1/assets/:id/thumb", async (req, reply) => {
			if (isRelay()) return relayProxy(req, reply, { body: req.body ?? {} });
			const { id } = req.params as { id: string };
			const rec = getAsset(id);
			if (!rec) return reply.code(404).send({ error: { message: "资产不存在" } });
			if (!isOssConfigured()) return reply.code(400).send({ error: { message: "未配置 OSS，不支持缩略图" } });
			const key = thumbKeyOf(id);
			const profile = profileOf(rec.storage); // 与原图同档
			const putUrl = await ossPresignPut(key, "image/webp", 900, profile);
			return { putUrl, url: ossPublicUrl(key, profile), expiresIn: 900 };
		});
		api.post("/v1/assets/:id/thumb/complete", async (req, reply) => {
			if (isRelay()) return relayProxy(req, reply, { body: req.body ?? {} });
			const { id } = req.params as { id: string };
			const rec = getAsset(id);
			if (!rec) return reply.code(404).send({ error: { message: "资产不存在" } });
			setAssetThumb(id, true);
			return { ok: true, url: thumbUrlOf(rec) };
		});

		// ── 收藏与配额（P1）──
		// 语义：收藏 = **永久保留额度**，不是「存不存得下」。超额只挡新增收藏，
		// 用户照常生成、照常使用已有素材；取消收藏也绝不立即删，只转入倒计时。
		// P3 节点收藏透传：拥有者=节点用户留痕 id（`nu:` 前缀）——收藏=永久保留 的保留策略语义
		// 对节点用户同样成立；配额=全局默认+该 id 的扩容授予（节点用户无「按用户覆盖」）。
		const favOwnerId = (req: FastifyRequest): string => (req.agentNode ? nodeUserTrace(req) : req.user!.id);
		const favQuotaOf = (req: FastifyRequest): ReturnType<typeof favQuotaById> =>
			req.agentNode ? favQuotaById(favOwnerId(req)) : userFavQuota(req.user!);
		api.get("/v1/favorites", async (req, reply) => {
			// P3 relay：收藏透传源站（收藏=永久保留 的语义在源站生效；拥有者=nu: 留痕 id）
			if (isRelay()) return relayProxy(req, reply);
			const oid = favOwnerId(req);
			const q = req.query as { type?: string; limit?: string; offset?: string };
			return {
				items: listFavorites("user", oid, { type: q.type, limit: Number(q.limit) || 500, offset: Number(q.offset) || 0 }),
				quota: favQuotaOf(req),
				grants: listGrants("user", oid),
			};
		});
		api.post("/v1/favorites", async (req, reply) => {
			if (isRelay()) return relayProxy(req, reply, { body: req.body ?? {} });
			const oid = favOwnerId(req);
			const { assetId } = (req.body ?? {}) as { assetId?: string };
			if (!assetId) return reply.code(400).send({ error: { message: "缺少 assetId" } });
			const rec = getAsset(assetId);
			if (!rec) return reply.code(404).send({ error: { message: "资产不存在" } });
			const quota = favQuotaOf(req);
			const r = addFavorite(assetId, "user", oid, { limitBytes: quota.limitBytes, usedBytes: quota.usedBytes }, rec.sizeBytes ?? 0);
			if (!r.ok) return reply.code(409).send({ error: { message: r.error, needBytes: r.needBytes, quota } });
			return { ok: true, quota: favQuotaOf(req) };
		});
		api.delete("/v1/favorites/:assetId", async (req, reply) => {
			if (isRelay()) return relayProxy(req, reply);
			const { assetId } = req.params as { assetId: string };
			const r = removeFavorite(assetId, "user", favOwnerId(req));
			return { ...r, quota: favQuotaOf(req) };
		});
		// 批量问「这些我收藏了吗」——客户端渲染 ☆ 用，一次查完不逐个问
		api.post("/v1/favorites/flags", async (req, reply) => {
			const { ids } = (req.body ?? {}) as { ids?: unknown };
			if (!Array.isArray(ids)) return reply.code(400).send({ error: { message: "缺少 ids 数组" } });
			if (isRelay()) return relayProxy(req, reply, { body: { ids } });
			return { favorited: favoriteFlags("user", favOwnerId(req), ids as string[]) };
		});

		// 扩容卡核销：个人卡→本人配额；团队卡→须为团长，落到团队共享库配额
		api.post("/v1/storage-codes/redeem", async (req, reply) => {
			// P3 relay 边界：扩容卡是源站/门户签发体系，节点 v1 暂不支持（收藏配额=默认档）
			if (isRelay()) return reply.code(400).send({ error: { message: "渠道节点暂不支持扩容卡，请联系你的服务商" } });
			const u = req.user!;
			const { code } = (req.body ?? {}) as { code?: string };
			if (!code) return reply.code(400).send({ error: { message: "缺少扩容卡号" } });
			const card = getStorageCode(code.trim());
			if (!card) return reply.code(404).send({ error: { message: "扩容卡不存在" } });
			let owner: { type: "user" | "team"; id: string };
			if (card.target === "team") {
				const team = teamOfUser(u.id);
				if (!team) return reply.code(400).send({ error: { message: "你还没有团队，团队扩容卡需由团长使用" } });
				if (team.leaderId !== u.id) return reply.code(403).send({ error: { message: "只有团长可以使用团队扩容卡" } });
				owner = { type: "team", id: team.id };
			} else {
				owner = { type: "user", id: u.id };
			}
			const r = useStorageCode(code.trim(), owner);
			if (!r.ok) return reply.code(400).send({ error: { message: r.error } });
			// ⚠ 用卡上冻结的规格授予（不是核销时的管理端档位）——事后调档不该改变用户已买到手的东西
			const g = grantQuota(owner.type, owner.id, r.card.bytes, r.card.days, r.card.code);
			return { ok: true, granted: g, quota: owner.type === "user" ? userFavQuota(u) : undefined };
		});

		// 转存兜底：客户端拿到「上游直链」（服务端受理时转存失败，meta.rehosted=false）时，
		// 请求管理端把该 url 下载并转存到 OSS，返回永久公网直链 + 全局资产 id。
		// 用途：客户端 webview 直接 fetch 上游直链被 CORS 拦时，改从 OSS（同 S3、CORS 友好）下载到本地播放。
		api.post("/v1/assets/rehost", async (req, reply) => {
			if (isRelay()) return relayProxy(req, reply, { body: req.body ?? {} });
			const { url, prefix, name } = (req.body ?? {}) as { url?: string; prefix?: string; name?: string };
			if (!url || !/^https?:\/\//i.test(url)) return reply.code(400).send({ error: { message: "缺少或非法 url" } });
			if (!isRehostHostAllowed(url)) return reply.code(400).send({ error: { message: "不允许的来源域名（防 SSRF）" } });
			const r = await runWithAssetOwner(req.agentNode ? { userId: nodeUserTrace(req), agentId: req.agentNode.id } : { userId: req.user?.id, agentId: req.user?.agentId }, () => rehostVideo(url, { prefix, name }));
			if (!r) return reply.code(502).send({ error: { message: "转存失败（可能未配置 OSS 或源不可达）" } });
			return { id: r.id, url: r.url };
		});

		// 第158轮：客户端接力转存完成后改写任务响应体——rehosted:false 的原始时效直链 → 真 OSS 台账资产。
		// 客户端凭本机网络下载原链、经 POST /v1/assets 上传拿到台账 id 后回报到这里；
		// url 由服务端按台账现解（id 是真理，不信客户端传的 url）；请求日志 ②段/resultLink 同步改写。
		// 仅 rehosted:false 的本人成功任务可改写（防越权/防任意篡改结果）。
		api.post("/v1/tasks/:id/result-asset", async (req, reply) => {
			if (isRelay()) return relayProxy(req, reply, { body: req.body ?? {} });
			const { id } = req.params as { id: string };
			const { assetId } = (req.body ?? {}) as { assetId?: string };
			if (!assetId) return reply.code(400).send({ error: { message: "缺少 assetId" } });
			const rec = getAsset(assetId);
			if (!rec) return reply.code(400).send({ error: { message: "资产不存在（须先经 POST /v1/assets 上传）" } });
			const url = rec.url || assetUrl(baseUrlOf(req), rec.id);
			// P3 节点：任务归属按节点留痕 id 校验（billing.userId 落的就是它）
			const r = rewriteTaskRawResult(id, req.agentNode ? nodeUserTrace(req) : req.user!.id, { id: rec.id, url });
			if (!r.ok) {
				// forbidden 与 not_found 同文案（不泄露他人任务存在性）
				if (r.reason === "not_rewritable") return reply.code(400).send({ error: { message: "该任务无需改写（仅原始直链结果可转存回填）" } });
				return reply.code(404).send({ error: { message: "任务不存在或已过期" } });
			}
			if (r.logId) rewriteLogResult(r.logId, r.result);
			return { ok: true, id: rec.id, url };
		});

		// 凭 id 重解析 url
		api.get("/v1/assets/:id", async (req, reply) => {
			if (isRelay()) return relayProxy(req, reply);
			const { id } = req.params as { id: string };
			const rec = getAsset(id);
			if (!rec) return reply.code(404).send({ error: { message: "资产不存在" } });
			return { id: rec.id, url: assetUrl(baseUrlOf(req), rec.id) };
		});

		// 死链自愈①探活：资产 OSS 直链是否可达（服务端 HEAD，绕开 webview CORS）。
		// 客户端据此判断是否需要用本地副本重传修复丢失的云端对象。
		api.get("/v1/assets/:id/alive", async (req, reply) => {
			if (isRelay()) return relayProxy(req, reply);
			const { id } = req.params as { id: string };
			const rec = getAsset(id);
			if (!rec) return reply.code(404).send({ error: { message: "资产不存在" } });
			return { id, alive: await isAssetAlive(id), url: rec.url };
		});

		// 死链自愈②重传：客户端用本地副本字节把资产字节写回 OSS（常规=原键 url 不变；
		// 旧 OSS 桥接=新桶新键 `<恢复者账号>/<旧路径>`，url 随之更新——第224轮）。
		// contentType 沿用台账既有值（不由上传方改）。恢复者账号取当前登录用户的 account。
		api.post("/v1/assets/:id/reput", async (req, reply) => {
			if (isRelay()) return relayProxyFile(req, reply, req.url);
			const { id } = req.params as { id: string };
			if (!getAsset(id)) return reply.code(404).send({ error: { message: "资产不存在" } });
			const file = await req.file();
			if (!file) return reply.code(400).send({ error: { message: "缺少文件字段 file" } });
			const out = await reputAsset(id, await file.toBuffer(), { acct: req.user?.account || req.user?.id });
			if (!out) return reply.code(404).send({ error: { message: "资产不存在" } });
			return { id: out.id, url: assetUrl(baseUrlOf(req), out.id), healed: true };
		});

		// ── 本人请求记录（第110轮，客户端「请求记录」页）：仅本人日志；详情只回 ①② 段 ──
		// 扣费/退款口径：cost=本次预扣积分；失败=已自动退款/未扣（refunded 派生标记，客户端据此展示「已退还」）。
		api.get("/v1/logs", async (req) => {
			const u = req.user!;
			const q = req.query as Record<string, string | undefined>;
			const num = (v?: string) => (v != null && v !== "" ? Number(v) : undefined);
			const status = q.status === "success" || q.status === "failed" || q.status === "running" ? q.status : undefined;
			const r = listLogs({ userIds: [u.id], limit: Math.min(num(q.limit) ?? 50, 200), offset: num(q.offset) ?? 0, from: num(q.from), to: num(q.to), status });
			return {
				total: r.total,
				items: r.items.map((l) => ({
					id: l.id,
					startedAt: l.startedAt,
					finishedAt: l.finishedAt,
					durationMs: l.durationMs,
					purpose: l.purpose,
					purposeLabel: l.purpose ? PURPOSE_LABELS[l.purpose] || l.purpose : "",
					model: l.model,
					status: l.status,
					cost: l.cost,
					refunded: l.status === "failed" && (l.cost ?? 0) > 0, // 失败即退款（异步退回预扣/同步未扣）
					error: l.error,
					resultLink: l.status === "success" ? l.resultLink : undefined,
				})),
			};
		});
		/**
		 * 批量下载清单（第232轮）：用户自助批量取回自己的产物。
		 * ⚠ 范围恒 `userIds:[本人]`（查询串无从改动）——越权隔离与 /v1/logs 同规。
		 * ⚠ 只下发链接本身，不含 内部渠道信息/归属/结算——条目字段（url/类型/保存情况/建议路径）
		 *   均为用户自有产物的公开信息；authRequired 只是「此链接直连下不了」的事实标注。
		 */
		api.get("/v1/downloads/manifest", async (req) => {
			const q = req.query as Record<string, string | undefined>;
			const m = buildDownloadManifest({ ...parseDownloadQuery(q), userIds: [req.user!.id] });
			// 用户侧不需要（也不该看到）内部 userId 字段，剥掉；其余原样
			return { ...m, items: m.items.map(({ userId: _uid, ...rest }) => rest) };
		});
		api.get("/v1/logs/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			const log = getLog(id);
			// 越权一律 404（不暴露他人日志是否存在）
			if (!log || log.userId !== req.user!.id) return reply.code(404).send({ error: { message: "记录不存在" } });
			// 只返回 ①（客户端→服务端：requestHeaders+request）②（服务端→客户端：response）；③④上游报文不下发；
			// agentCosts（归属链各级结算价）与 ownerId（归属渠道商内部 id）对用户保密，一并剥除
			const { upstreamRequest, upstreamResponse, agentCosts, ownerId, ...safe } = log as LogEntry & Record<string, unknown>;
			return { ...safe, purposeLabel: log.purpose ? PURPOSE_LABELS[log.purpose] || log.purpose : "" };
		});

		// ── 共享素材库（第120轮）：三级=库/文件夹/素材；素材只存 OSS 记录，字节不复制 ──
		// ⚠ 第173轮用户定「不需要隔离，开放」：受众隔离整体取消——任何用户可全局搜索、凭**加入密码**加入
		// 任意共享库（密码即门槛）；ownerAudience 仅作创建方归属（门户/管理端各管自己建的库）。勿恢复隔离。
		const libFor = (req: FastifyRequest, id: string, opts?: { member?: boolean }) => {
			const l = getLibrary(id);
			if (!l || !l.enabled) return null;
			if (opts?.member && !isMember(l.id, req.user!.id)) return null;
			return l;
		};
		const libView = (l: { id: string; name: string }) => ({ id: l.id, name: l.name, ...(({ folderCount, assetCount }) => ({ folderCount, assetCount }))(libraryCounts(l.id)) });

		// 已加入的库（共享资产首层；轻量）——不限归属，加入过的都显示
		api.get("/v1/shared/libraries", async (req) => ({ items: memberLibraries(req.user!.id).map(libView) }));

		// 全局按名搜索（加入用；不回密码信息，标注是否已加入）——不限归属，密码即门槛
		api.get("/v1/shared/libraries/search", async (req) => {
			const { q } = req.query as { q?: string };
			const uid = req.user!.id;
			return { items: searchLibraries(q || "").map((l) => ({ ...libView(l), joined: isMember(l.id, uid) })) };
		});

		// 加入（需库密码）
		api.post("/v1/shared/libraries/:id/join", async (req, reply) => {
			const l = libFor(req, (req.params as { id: string }).id);
			if (!l) return reply.code(404).send({ error: { message: "共享库不存在" } });
			const { password } = (req.body ?? {}) as { password?: string };
			if (!verifyLibraryPassword(l, password || "")) return reply.code(403).send({ error: { message: "加入密码错误" } });
			joinLibrary(l.id, req.user!.id);
			return { ok: true, library: libView(l) };
		});

		api.post("/v1/shared/libraries/:id/leave", async (req) => {
			leaveLibrary((req.params as { id: string }).id, req.user!.id);
			return { ok: true };
		});

		// 二级：库内文件夹 + 各自素材数（共享主页「获取」只拉这一层，惰性加载）
		api.get("/v1/shared/libraries/:id/folders", async (req, reply) => {
			const l = libFor(req, (req.params as { id: string }).id, { member: true });
			if (!l) return reply.code(404).send({ error: { message: "共享库不存在或未加入" } });
			return { items: listFolders(l.id).map((f) => ({ id: f.id, name: f.name, count: f.count })) };
		});

		// 成员建文件夹
		api.post("/v1/shared/libraries/:id/folders", async (req, reply) => {
			const l = libFor(req, (req.params as { id: string }).id, { member: true });
			if (!l) return reply.code(404).send({ error: { message: "共享库不存在或未加入" } });
			const { name } = (req.body ?? {}) as { name?: string };
			const r = createFolder(l.id, name || "", req.user!.name || req.user!.id);
			if (!r.ok) return reply.code(400).send({ error: { message: r.error } });
			return { ok: true, folder: { id: r.folder.id, name: r.folder.name, count: 0 } };
		});

		// 三级：文件夹内素材记录（进入文件夹后「获取」才拉；带 assetId 的按台账刷新当前直链——id 是真理）
		api.get("/v1/shared/folders/:id/assets", async (req, reply) => {
			const folder = getFolder((req.params as { id: string }).id);
			const l = folder ? libFor(req, folder.libraryId, { member: true }) : null;
			if (!folder || !l) return reply.code(404).send({ error: { message: "文件夹不存在或未加入所属共享库" } });
			const baseUrl = baseUrlOf(req);
			return {
				items: listFolderAssets(folder.id).map((a) => ({
					id: a.id,
					assetId: a.assetId,
					url: a.assetId && getAsset(a.assetId) ? assetUrl(baseUrl, a.assetId) : a.url,
					name: a.name,
					mime: a.mime,
				})),
			};
		});

		// 成员登记素材（分享=只存 OSS 记录，不复制字节）。逐条：优先按 assetId 回查台账取当前直链；
		// 否则要求真公网 https url（拒收 localhost/.localhost 本地直链——与 isPublicUrl 客户端同一把尺）。
		api.post("/v1/shared/folders/:id/assets", async (req, reply) => {
			const folder = getFolder((req.params as { id: string }).id);
			const l = folder ? libFor(req, folder.libraryId, { member: true }) : null;
			if (!folder || !l) return reply.code(404).send({ error: { message: "文件夹不存在或未加入所属共享库" } });
			const raw = ((req.body ?? {}) as { items?: unknown }).items;
			if (!Array.isArray(raw) || raw.length === 0) return reply.code(400).send({ error: { message: "缺少 items" } });
			if (raw.length > 200) return reply.code(400).send({ error: { message: "单次最多登记 200 条" } });
			const isPublic = (u: string) => {
				try {
					const h = new URL(u).hostname.toLowerCase();
					return /^https?:$/i.test(new URL(u).protocol) && h !== "localhost" && h !== "127.0.0.1" && !h.endsWith(".localhost");
				} catch { return false; }
			};
			const items: Array<{ assetId?: string; url: string; name: string; mime?: string }> = [];
			for (const r of raw as Array<{ assetId?: string; url?: string; name?: string; mime?: string }>) {
				const assetId = typeof r?.assetId === "string" && r.assetId ? r.assetId : undefined;
				const rec = assetId ? getAsset(assetId) : undefined;
				// id 是真理：台账内的资产按台账直链登记；否则退 url（必须真公网）
				const url = rec ? assetUrl(baseUrlOf(req), rec.id) : typeof r?.url === "string" ? r.url : "";
				if (!url || !isPublic(url)) continue; // 无公网直链的条目跳过（本地素材需先上传 OSS）
				items.push({ assetId: rec ? rec.id : undefined, url, name: String(r?.name || rec?.name || "素材"), mime: r?.mime || rec?.contentType });
			}
			if (!items.length) return reply.code(400).send({ error: { message: "没有可登记的素材（本地素材需先上传得到 OSS 直链）" } });
			const out = addFolderAssets(folder, items, req.user!.name || req.user!.id);
			if (!out.ok) return reply.code(400).send({ error: { message: out.error } });
			return { ok: true, added: out.added, skipped: out.skipped + (raw.length - items.length) };
		});

		// ── 团队（第172轮）：团队码开团（团长）+ 成员绑定 + 积分方式（共享/分发）+ 分发/收回 + 团队共享库 ──

		// 开团自动建团队共享素材库：名「团队·<团名>」（撞名补后缀）、随机密码（成员随团自动加入，无需密码）
		const createTeamLib = (team: Team, leader: User): string | undefined => {
			const pw = randomBytes(8).toString("hex");
			const aud = audienceOf(leader.agentId);
			// teamId=豁免受众隔离的凭据（第173轮：团员不限归属，跨归属团员按成员身份可见）
			let r = createLibrary({ name: `团队·${team.name}`, password: pw, ownerAudience: aud, teamId: team.id });
			if (!r.ok) r = createLibrary({ name: `团队·${team.name}·${team.id.slice(-4)}`, password: pw, ownerAudience: aud, teamId: team.id });
			if (!r.ok) return undefined;
			updateTeam(team.id, { sharedLibId: r.library.id });
			joinLibrary(r.library.id, leader.id);
			return r.library.id;
		};

		// 懒清理级联：团长被删的团队解散 + 其共享库随删（sanitizeTeams 只清 store，本层做级联）
		const sanitizeTeamsCascade = (): void => {
			for (const t of sanitizeTeams()) if (t.sharedLibId) deleteLibrary(t.sharedLibId);
		};

		const teamMemberView = (id: string, teamId?: string) => {
			const u = getUser(id);
			if (!u) return null;
			// granted=团长对该团员的分发净额；reclaimable=本次可收回上限 min(净额, 当前余额)——收回只认这口径
			const granted = teamId ? grantedOf(teamId, id) : 0;
			return {
				id: u.id, name: u.name || u.account || "（未注册）", account: u.account, credits: u.credits,
				dailySpent: dailySpentToday(u), totalSpent: u.totalSpent || 0, lastSeenAt: u.lastSeenAt, enabled: u.enabled,
				granted, reclaimable: Math.min(granted, u.credits || 0),
			};
		};

		// 团队详情：团长见全量（成员积分/消耗 + 待接受邀请），团员见概要；不在团队=返回收到的邀请
		api.get("/v1/team", async (req) => {
			sanitizeTeamsCascade();
			const u = req.user!;
			const team = teamOfUser(u.id);
			if (!team) {
				// 收到的待处理邀请（接受才入团——邀请-同意制）
				const invites = invitesForUser(u.id).map(({ team: t, createdAt }) => {
					const leader = getUser(t.leaderId);
					return {
						teamId: t.id, teamName: t.name, creditMode: t.creditMode,
						leaderName: leader ? (leader.name || leader.account) : "（已删）",
						memberCount: t.memberIds.length + 1, createdAt,
					};
				});
				return { team: null, invites };
			}
			const leader = getUser(team.leaderId);
			const role: "leader" | "member" = team.leaderId === u.id ? "leader" : "member";
			const base = {
				id: team.id, name: team.name, role, creditMode: team.creditMode,
				leaderName: leader ? (leader.name || leader.account) : "（已删）",
				memberCount: team.memberIds.length + 1,
				memberLimit: effectiveTeamLimit(team),
				poolCredits: team.creditMode === "shared" ? (leader?.credits ?? 0) : undefined,
				sharedLibId: team.sharedLibId,
				sharedLibName: team.sharedLibId ? getLibrary(team.sharedLibId)?.name : undefined,
				createdAt: team.createdAt,
			};
			if (role !== "leader") return { team: base };
			const pendingInvites = (team.invites ?? []).map((i) => {
				const cand = getUser(i.userId);
				return cand ? { userId: cand.id, name: cand.name || cand.account || "（未注册）", account: cand.account, createdAt: i.createdAt } : null;
			}).filter(Boolean);
			return { team: { ...base, leaderCredits: leader?.credits ?? 0, members: team.memberIds.map((id) => teamMemberView(id, team.id)).filter(Boolean), pendingInvites } };
		});

		// 开团（需管理端发放的团队码）：开团者=团长；自动创建团队共享素材库
		api.post("/v1/team", async (req, reply) => {
			sanitizeTeamsCascade();
			const u = req.user!;
			const { code, name } = (req.body ?? {}) as { code?: string; name?: string };
			const r = createTeam({ code, name, leaderId: u.id });
			if (!r.ok) return reply.code(400).send({ error: { message: r.error } });
			const libId = createTeamLib(r.team, u);
			return { ok: true, team: { id: r.team.id, name: r.team.name, sharedLibId: libId } };
		});

		// 团长：改名 / 切换积分方式（shared=共享池（团长余额）；dispatch=分发模式，各扣各的）
		api.put("/v1/team", async (req, reply) => {
			const u = req.user!;
			const team = teamOfUser(u.id);
			if (!team || team.leaderId !== u.id) return reply.code(403).send({ error: { message: "仅团长可操作" } });
			const { name, creditMode } = (req.body ?? {}) as { name?: string; creditMode?: Team["creditMode"] };
			const r = updateTeam(team.id, { name, creditMode });
			if (!r.ok) return reply.code(400).send({ error: { message: r.error } });
			// 团名变更 → 团队共享库跟随改名（撞名等失败不阻断改名本身）
			if (name && team.sharedLibId) updateLibrary(team.sharedLibId, { name: `团队·${r.team.name}` });
			return { ok: true, team: { id: r.team.id, name: r.team.name, creditMode: r.team.creditMode } };
		});

		// 团长：按登录账号**邀请**团员（⚠ 邀请-同意制：对方在其团队页接受才入团——防强拉；
		// 对方须已注册账号、不在其它团队）。**不限归属**（第173轮用户定「自由点」）：跨渠道商/平台直属可互绑——
		// 计费口径互不越界：共享模式扣团长池、售价按消耗者自己的归属定价、渠道商链按消耗者归属逐笔结算。
		api.post("/v1/team/members", async (req, reply) => {
			const u = req.user!;
			const team = teamOfUser(u.id);
			if (!team || team.leaderId !== u.id) return reply.code(403).send({ error: { message: "仅团长可操作" } });
			const { account } = (req.body ?? {}) as { account?: string };
			const cand = getUserByAccount(account ?? "");
			if (!cand || !cand.enabled) return reply.code(404).send({ error: { message: "未找到该账号（对方需先注册登录账号）" } });
			if (cand.id === u.id) return reply.code(400).send({ error: { message: "不能邀请自己" } });
			const r = inviteToTeam(team.id, cand.id);
			if (!r.ok) return reply.code(400).send({ error: { message: r.error } });
			return { ok: true, invited: { userId: cand.id, name: cand.name || cand.account, account: cand.account } };
		});

		// 团长：撤销邀请
		api.delete("/v1/team/invites/:userId", async (req, reply) => {
			const u = req.user!;
			const team = teamOfUser(u.id);
			if (!team || team.leaderId !== u.id) return reply.code(403).send({ error: { message: "仅团长可操作" } });
			if (!removeInvite(team.id, (req.params as { userId: string }).userId)) {
				return reply.code(404).send({ error: { message: "邀请不存在" } });
			}
			return { ok: true };
		});

		// 被邀请人：接受邀请（唯一入团路径）——入团即加入团队共享库
		api.post("/v1/team/invites/accept", async (req, reply) => {
			sanitizeTeamsCascade();
			const u = req.user!;
			const { teamId } = (req.body ?? {}) as { teamId?: string };
			if (!teamId) return reply.code(400).send({ error: { message: "缺少 teamId" } });
			const r = acceptInvite(teamId, u.id);
			if (!r.ok) return reply.code(400).send({ error: { message: r.error } });
			if (r.team.sharedLibId) joinLibrary(r.team.sharedLibId, u.id);
			return { ok: true, team: { id: r.team.id, name: r.team.name } };
		});

		// 被邀请人：拒绝邀请
		api.post("/v1/team/invites/decline", async (req, reply) => {
			const u = req.user!;
			const { teamId } = (req.body ?? {}) as { teamId?: string };
			if (!teamId || !removeInvite(teamId, u.id)) return reply.code(404).send({ error: { message: "邀请不存在或已过期" } });
			return { ok: true };
		});

		// 团长：移除团员（分发余量 min(净额,余额) 自动退回团长——只结算分发部分，不动团员自有积分）
		api.delete("/v1/team/members/:userId", async (req, reply) => {
			const u = req.user!;
			const team = teamOfUser(u.id);
			if (!team || team.leaderId !== u.id) return reply.code(403).send({ error: { message: "仅团长可操作" } });
			const { userId } = req.params as { userId: string };
			if (!team.memberIds.includes(userId)) return reply.code(400).send({ error: { message: "该用户不在团队中" } });
			const settled = settleMemberGrant(team.id, userId);
			removeTeamMember(team.id, userId);
			if (team.sharedLibId) leaveLibrary(team.sharedLibId, userId);
			return { ok: true, settled };
		});

		// 团员：退出团队（分发余量自动退回团长，同一口径）
		api.post("/v1/team/leave", async (req, reply) => {
			const u = req.user!;
			const team = teamOfUser(u.id);
			if (!team) return reply.code(400).send({ error: { message: "你不在任何团队中" } });
			if (team.leaderId === u.id) return reply.code(400).send({ error: { message: "团长不能退出，请使用「解散团队」" } });
			const settled = settleMemberGrant(team.id, u.id);
			removeTeamMember(team.id, u.id);
			if (team.sharedLibId) leaveLibrary(team.sharedLibId, u.id);
			return { ok: true, settled };
		});

		// 团长：解散团队（逐团员结算分发余量退回团长 → 共享库级联删除——素材只是 OSS 记录不动字节；
		// 团员自有积分保持现状；团队码不复用）
		api.post("/v1/team/dissolve", async (req, reply) => {
			const u = req.user!;
			const team = teamOfUser(u.id);
			if (!team || team.leaderId !== u.id) return reply.code(403).send({ error: { message: "仅团长可操作" } });
			for (const mid of team.memberIds) settleMemberGrant(team.id, mid);
			dissolveTeam(team.id);
			if (team.sharedLibId) deleteLibrary(team.sharedLibId);
			return { ok: true };
		});

		// 团长：分发（delta>0 团长→团员）/ 收回（delta<0 团员→团长）积分——零和转账、双向不透支、不计消耗统计。
		// ⚠ 经济安全（勿回退）：收回上限=分发净额台账 min(granted, 团员当前余额)——团长永远收不走团员自有积分。
		api.post("/v1/team/credits", async (req, reply) => {
			const u = req.user!;
			const team = teamOfUser(u.id);
			if (!team || team.leaderId !== u.id) return reply.code(403).send({ error: { message: "仅团长可操作" } });
			const { userId, delta } = (req.body ?? {}) as { userId?: string; delta?: number };
			if (!userId || !team.memberIds.includes(userId)) return reply.code(400).send({ error: { message: "该用户不在团队中" } });
			const n = Math.floor(Number(delta) || 0);
			if (!n) return reply.code(400).send({ error: { message: "金额需为非零整数（正=分发，负=收回）" } });
			if (n < 0) {
				const cap = Math.min(grantedOf(team.id, userId), getUser(userId)?.credits ?? 0);
				if (-n > cap) {
					return reply.code(400).send({ error: { message: `只能收回你分发的余量（当前可收回 ${cap}）——团员自有积分不可收缴` } });
				}
			}
			const r = n > 0 ? transferCredits(u.id, userId, n) : transferCredits(userId, u.id, -n);
			if (!r.ok) return reply.code(400).send({ error: { message: (n > 0 ? "分发失败：" : "收回失败：对方") + r.error } });
			bumpGranted(team.id, userId, n);
			return { ok: true, leaderCredits: getUser(u.id)?.credits ?? 0, member: teamMemberView(userId, team.id) };
		});

		// 团长：管理团队共享库（删文件夹/删素材记录；成员日常使用走既有 /v1/shared/*，无需密码已自动入库）
		api.delete("/v1/team/lib/folders/:id", async (req, reply) => {
			const u = req.user!;
			const team = teamOfUser(u.id);
			const folder = getFolder((req.params as { id: string }).id);
			if (!team || team.leaderId !== u.id || !folder || !team.sharedLibId || folder.libraryId !== team.sharedLibId) {
				return reply.code(404).send({ error: { message: "文件夹不存在或无权限" } });
			}
			deleteFolder(folder.id);
			return { ok: true };
		});
		api.delete("/v1/team/lib/assets/:id", async (req, reply) => {
			const u = req.user!;
			const team = teamOfUser(u.id);
			const rec = getAssetRec((req.params as { id: string }).id);
			if (!team || team.leaderId !== u.id || !rec || !team.sharedLibId || rec.libraryId !== team.sharedLibId) {
				return reply.code(404).send({ error: { message: "素材不存在或无权限" } });
			}
			deleteAssetRec(rec.id);
			return { ok: true };
		});
	});
}
