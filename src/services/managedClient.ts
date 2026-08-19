/**
 * managedClient —— 用户端与管理端通信的唯一 HTTP 客户端。
 *
 * 所有第三方调用都由管理端完成；用户端只说本协议（见 @/contract）。
 * 职责：鉴权头、超时、网关 5xx 容错、同步/异步统一、素材上传、过期 url 重解析。
 */

import {
	Endpoints,
	type Catalog,
	type GenerateRequest,
	type TaskState,
	type BatchRequest,
	type BatchState,
	type AssetUploadResult,
	type SessionUser,
	type UserStats,
	type UserConsumeStats,
	type UserLogItem,
	type UserLogDetail,
	type SharedLibraryInfo,
	type SharedFolderInfo,
	type SharedAssetRecord,
	type TeamDetail,
	type TeamMemberInfo,
	type TeamInviteInfo,
	type TeamCreditMode,
	type DownloadManifest,
	type DownloadLinkStorage,
	type DownloadMediaKind,
} from "@/contract";
import { useConnectionStore, getDeviceId } from "@/store/connectionStore";

// 收藏/配额的传输对象（与服务端 store/favorites.ts 对应；客户端侧类型见 store/favoritesStore.ts）
interface FavQuotaDto { limitBytes: number; usedBytes: number; baseBytes: number; grantBytes: number; count: number }
interface FavoriteItemDto { assetId: string; createdAt: number; type: string; contentType: string; name?: string; url: string; sizeBytes: number; platformPinned: boolean }
interface QuotaGrantDto { id: string; bytes: number; code?: string; grantedAt: number; expiresAt: number }

/** 同步结果暂存：sync 任务无需轮询远端，poll 时从这里取一次 */
const _immediate = new Map<string, TaskState>();

/**
 * 上传超时按体积自适应：基础 120s + 每 100KB 加 1s（容忍 ≈100KB/s 慢速上行），上限 15 分钟。
 * 固定 120s 对几十 MB 的视频/音频素材必超时——上传仍在正常进行却被客户端掐断（"signal timed out"）。
 */
function uploadTimeoutMs(bytes: number): number {
	return Math.min(120_000 + Math.ceil(bytes / (100 * 1024)) * 1000, 900_000);
}

/** 直传通道本会话不可用（服务端未部署新端点 / 未配 OSS）——记住后不再逐次白试 */
let _directUnavailable = false;

/**
 * 素材直传 OSS（第170轮）：签发预签名 → 字节直传桶（国内用户→国内桶，绕开跨境服务器中转）→ 回报登台账。
 * 返回 null = 本次走不了直传（调用方回退 multipart）；抛错 = 直传中途失败（调用方同样回退）。
 */
/** 文件内容 sha256（十六进制）——直传去重用；算不了（环境无 SubtleCrypto）返回空=不带哈希 */
async function sha256HexOf(blob: Blob): Promise<string> {
	try {
		const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
		return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
	} catch {
		return "";
	}
}

async function directUpload(blob: Blob, filename: string, prefix?: string): Promise<AssetUploadResult | null> {
	const contentType = blob.type || "application/octet-stream";
	// ① 签发：分配资产 id + 预签名 PUT URL（密钥只在服务端）。带内容哈希——
	//    整桶已有同内容对象时服务端直接回 dedup（第224轮：相同文件不重复上传）
	const signResp = await fetch(url(`${Endpoints.assets}/direct`), {
		method: "POST",
		headers: headers(true),
		body: JSON.stringify({ contentType, size: blob.size, prefix, name: filename, sha256: (await sha256HexOf(blob)) || undefined }),
		signal: AbortSignal.timeout(20000),
	});
	if (!signResp.ok) {
		const data = await signResp.json().catch(() => ({}));
		const msg = (data as any)?.error?.message ?? "";
		// 旧服务端无此端点 / 服务端未配 OSS → 本会话固定走 multipart，不再逐次白试
		if (signResp.status === 404 || /未配置 OSS/.test(msg)) _directUnavailable = true;
		return null;
	}
	const { id, putUrl, url: dedupUrl, dedup } = (await signResp.json()) as { id: string; putUrl?: string; url?: string; dedup?: boolean };
	// 去重命中：对象已在桶里，免上传免登记，直接用已有资产的 id+url
	if (dedup && dedupUrl) return { id, url: dedupUrl } as AssetUploadResult;
	if (!putUrl) return null; // 形状异常兜底：回退 multipart
	// ② 字节直传 OSS（不经服务器；超时按体积自适应）
	const put = await fetch(putUrl, {
		method: "PUT",
		body: blob,
		headers: { "Content-Type": contentType },
		signal: AbortSignal.timeout(uploadTimeoutMs(blob.size)),
	});
	if (!put.ok) throw new Error(`直传 OSS 失败 HTTP ${put.status}`);
	// ③ 回报服务端：校验对象后补登台账（带空 body 防 Fastify 拒空 JSON）
	const done = await fetch(url(`${Endpoints.assets}/direct/${id}/complete`), {
		method: "POST",
		headers: headers(true),
		body: "{}",
		signal: AbortSignal.timeout(30000),
	});
	if (!done.ok) {
		const data = await done.json().catch(() => ({}));
		throw new Error((data as any)?.error?.message || `直传登记失败 HTTP ${done.status}`);
	}
	return (await done.json()) as AssetUploadResult;
}

class ManagedClientError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly body?: unknown,
	) {
		super(message);
		this.name = "ManagedClientError";
	}
}

function headers(json = true): Record<string, string> {
	const { accessKey } = useConnectionStore.getState();
	// 身份=API 密钥（Bearer）；设备 id 随每个请求带上（同时在线设备限制的设备区分，无身份语义）
	const h: Record<string, string> = { Authorization: `Bearer ${accessKey}`, "x-device-id": getDeviceId() };
	if (json) h["Content-Type"] = "application/json";
	return h;
}

function url(path: string): string {
	const base = useConnectionStore.getState().normalizedUrl();
	if (!base) throw new ManagedClientError("未配置管理端服务器地址", 0);
	return `${base}${path}`;
}

async function request<T>(
	method: string,
	path: string,
	body?: unknown,
	timeoutMs = 60000,
): Promise<T> {
	let resp: Response;
	try {
		resp = await fetch(url(path), {
			method,
			headers: headers(body !== undefined),
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		useConnectionStore.getState().setOnline(false, (err as Error).message);
		throw new ManagedClientError(`网络请求失败: ${(err as Error).message}`, 0);
	}

	// 网关高可用：5xx 视为暂时不可用，由上层重试/继续轮询
	if ([502, 503, 504, 521].includes(resp.status)) {
		throw new ManagedClientError(`网关暂时不可用 (${resp.status})`, resp.status);
	}

	// 304 Not Modified（catalog since 版本一致）：正常的"无更新"，非错误。
	// 服务器可达 → 在线；返回空对象，由上层保留本地缓存。
	if (resp.status === 304) {
		useConnectionStore.getState().setOnline(true, null);
		return {} as T;
	}

	const data = await resp.json().catch(() => ({}));
	if (!resp.ok) {
		const msg =
			(data as any)?.error?.message ||
			(data as any)?.message ||
			`HTTP ${resp.status} ${resp.statusText}`;
		useConnectionStore.getState().setOnline(resp.status < 500, msg);
		throw new ManagedClientError(msg, resp.status, data);
	}
	useConnectionStore.getState().setOnline(true, null);
	return data as T;
}

export const managedClient = {
	/** 登录：校验 accessKey 对应启用用户。用当前 connectionStore 的 url+key。 */
	async login(): Promise<{ ok: boolean; user?: SessionUser; accessKey?: string; error?: string }> {
		const { accessKey } = useConnectionStore.getState();
		let resp: Response;
		try {
			resp = await fetch(url(Endpoints.login), {
				method: "POST",
				headers: headers(true),
				body: JSON.stringify({ accessKey, deviceId: getDeviceId() }),
				signal: AbortSignal.timeout(20000),
			});
		} catch (err) {
			return { ok: false, error: `无法连接管理端：${(err as Error).message}` };
		}
		const data = await resp.json().catch(() => ({}));
		if (!resp.ok) return { ok: false, error: (data as any)?.error?.message || `登录失败 HTTP ${resp.status}` };
		return { ok: true, user: (data as any).user, accessKey: (data as any).accessKey };
	},

	/** 账号+密码登录：解析出对应用户的 accessKey（下游真凭证），随响应回传。 */
	async loginWithAccount(account: string, password: string): Promise<{ ok: boolean; user?: SessionUser; accessKey?: string; error?: string }> {
		let resp: Response;
		try {
			resp = await fetch(url(Endpoints.login), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ account, password, deviceId: getDeviceId() }),
				signal: AbortSignal.timeout(20000),
			});
		} catch (err) {
			return { ok: false, error: `无法连接管理端：${(err as Error).message}` };
		}
		const data = await resp.json().catch(() => ({}));
		if (!resp.ok) return { ok: false, error: (data as any)?.error?.message || `登录失败 HTTP ${resp.status}` };
		return { ok: true, user: (data as any).user, accessKey: (data as any).accessKey };
	},

	// ── 注册体系（P2 商业化改造）：图形验证码 → 发验证码 → 邮箱/手机号注册（可填邀请码）/ 找回密码 ──

	/** 图形验证码（发验证码前置；一次性，错了重取） */
	async getCaptcha(): Promise<{ ok: boolean; id?: string; svg?: string; error?: string }> {
		try {
			const resp = await fetch(url(Endpoints.captcha), { signal: AbortSignal.timeout(15000) });
			const data = await resp.json().catch(() => ({}));
			if (!resp.ok) return { ok: false, error: (data as any)?.error?.message || `HTTP ${resp.status}` };
			return { ok: true, id: (data as any).id, svg: (data as any).svg };
		} catch (err) {
			return { ok: false, error: `无法连接服务器：${(err as Error).message}` };
		}
	},

	/** 发验证码（注册/找回密码共用；purpose 决定走哪个端点） */
	async sendVerifyCode(purpose: "register" | "reset", target: string, captchaId: string, captchaAnswer: string): Promise<{ ok: boolean; channel?: string; error?: string }> {
		const path = purpose === "register" ? Endpoints.registerSendCode : Endpoints.passwordSendCode;
		try {
			const resp = await fetch(url(path), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ target, captchaId, captchaAnswer }),
				signal: AbortSignal.timeout(30000),
			});
			const data = await resp.json().catch(() => ({}));
			if (!resp.ok) return { ok: false, error: (data as any)?.error?.message || `发送失败 HTTP ${resp.status}` };
			return { ok: true, channel: (data as any).channel };
		} catch (err) {
			return { ok: false, error: `无法连接服务器：${(err as Error).message}` };
		}
	},

	/** 邮箱/手机号注册：验证码核销 → 建号 → 回传 accessKey（直接进入登录态）。
	 *  inviteCode 可选：渠道商邀请码=注册即归属该商；个人邀请码=记录邀请关系。 */
	async registerAccount(target: string, code: string, password: string, name?: string, inviteCode?: string): Promise<{ ok: boolean; user?: SessionUser; accessKey?: string; error?: string }> {
		try {
			const resp = await fetch(url(Endpoints.registerAccount), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ target, code, password, name, inviteCode: inviteCode || undefined, deviceId: getDeviceId() }),
				signal: AbortSignal.timeout(20000),
			});
			const data = await resp.json().catch(() => ({}));
			if (!resp.ok) return { ok: false, error: (data as any)?.error?.message || `注册失败 HTTP ${resp.status}` };
			return { ok: true, user: (data as any).user, accessKey: (data as any).accessKey };
		} catch (err) {
			return { ok: false, error: `无法连接服务器：${(err as Error).message}` };
		}
	},

	/** 找回密码：验证码核销 + 重置（成功后回登录页重新登录） */
	async resetPassword(target: string, code: string, newPassword: string): Promise<{ ok: boolean; error?: string }> {
		try {
			const resp = await fetch(url(Endpoints.passwordReset), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ target, code, newPassword }),
				signal: AbortSignal.timeout(20000),
			});
			const data = await resp.json().catch(() => ({}));
			if (!resp.ok) return { ok: false, error: (data as any)?.error?.message || `重置失败 HTTP ${resp.status}` };
			return { ok: true };
		} catch (err) {
			return { ok: false, error: `无法连接服务器：${(err as Error).message}` };
		}
	},

	/** 个人中心：自助重置 API 密钥（旧密钥立即失效——其它设备/外部对接全部登出）。
	 *  成功后调用方须用返回的新密钥更新 connectionStore（本机无感续用）。 */
	async regenerateApiKey(): Promise<{ ok: boolean; apiKey?: string; error?: string }> {
		try {
			const data = await request<{ ok: boolean; apiKey: string }>("POST", Endpoints.apiKeyRegenerate, {});
			return { ok: true, apiKey: data.apiKey };
		} catch (err) {
			return { ok: false, error: err instanceof ManagedClientError ? err.message : (err as Error).message };
		}
	},

	/** 个人中心：登录态自助修改密码（校验旧密码；不动 API 密钥——其它设备不掉线）。 */
	async changePassword(oldPassword: string, newPassword: string): Promise<{ ok: boolean; error?: string }> {
		try {
			await request<{ ok: boolean }>("POST", Endpoints.passwordChange, { oldPassword, newPassword });
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof ManagedClientError ? err.message : (err as Error).message };
		}
	},

	/** 个人中心：管理端手工建号的用户绑定账号+密码（自助注册用户天然已有账号）。 */
	async bindAccount(account: string, password: string): Promise<{ ok: boolean; account?: string; error?: string }> {
		try {
			const data = await request<{ ok: boolean; account: string }>("POST", Endpoints.bindAccount, { account, password });
			return { ok: true, account: data.account };
		} catch (err) {
			return { ok: false, error: err instanceof ManagedClientError ? err.message : (err as Error).message };
		}
	},

	/**
	 * 心跳。返回 `authRejected` 区分「服务端明确拒绝」与「瞬时掉线」：
	 *  - 401/403（API 密钥失效 / 用户被禁用 / 被其它设备抢占登录）→ authRejected=true，调用方应立即登出；
	 *  - 网络错误 / 超时 / 5xx 等 → authRejected 缺省（false），调用方按掉线容差处理（连续多次才登出）。
	 */
	async heartbeat(): Promise<{ ok: boolean; user?: SessionUser; authRejected?: boolean }> {
		try {
			const resp = await fetch(url(Endpoints.heartbeat), {
				method: "POST",
				headers: headers(true),
				body: JSON.stringify({}),
				signal: AbortSignal.timeout(15000),
			});
			if (!resp.ok) return { ok: false, authRejected: resp.status === 401 || resp.status === 403 };
			const data = await resp.json().catch(() => ({}));
			return { ok: true, user: (data as any).user };
		} catch {
			return { ok: false }; // 网络/超时 → 瞬时故障（容差）
		}
	},

	/** 个人中心：拉取当前用户积分 + 消耗统计 */
	async me(): Promise<UserStats> {
		return request<UserStats>("GET", Endpoints.me, undefined, 15000);
	},

	/** 消耗统计（今日/昨日/近7天）：缺省=自己；团长可传 userId=团员 或 scope:"team"=全团合计 */
	async getStats(opts?: { userId?: string; scope?: "team" }): Promise<UserConsumeStats> {
		const p = new URLSearchParams();
		if (opts?.userId) p.set("userId", opts.userId);
		if (opts?.scope) p.set("scope", opts.scope);
		const q = p.toString();
		return request<UserConsumeStats>("GET", `${Endpoints.stats}${q ? `?${q}` : ""}`, undefined, 15000);
	},

	/**
	 * 批量下载清单（第232轮）：本人产物摊平成条目，供批量取回。
	 * ⚠ 范围恒本人（服务端强制，查询串改不了）；storages/kinds 传逗号分隔多值。
	 * 清单可能很大（几千条），超时给足。
	 */
	async getDownloadManifest(opts?: {
		from?: number;
		to?: number;
		purpose?: string;
		model?: string;
		storages?: DownloadLinkStorage[];
		kinds?: DownloadMediaKind[];
		limit?: number;
	}): Promise<DownloadManifest> {
		const p = new URLSearchParams();
		if (opts?.from != null) p.set("from", String(opts.from));
		if (opts?.to != null) p.set("to", String(opts.to));
		if (opts?.purpose) p.set("purpose", opts.purpose);
		if (opts?.model) p.set("model", opts.model);
		if (opts?.storages?.length) p.set("storages", opts.storages.join(","));
		if (opts?.kinds?.length) p.set("kinds", opts.kinds.join(","));
		if (opts?.limit != null) p.set("limit", String(opts.limit));
		const q = p.toString();
		return request<DownloadManifest>("GET", `${Endpoints.downloadsManifest}${q ? `?${q}` : ""}`, undefined, 60000);
	},

	// ── 团队（第172轮）：团队码开团、成员绑定、积分方式、分发/收回 ──

	/** 团队详情：不在团队返回 team:null + 收到的邀请；团长见成员全量、团员见概要 */
	async getTeam(): Promise<{ team: TeamDetail | null; invites?: TeamInviteInfo[] }> {
		return request<{ team: TeamDetail | null; invites?: TeamInviteInfo[] }>("GET", Endpoints.team, undefined, 15000);
	},

	/** 开团（需管理端发放的团队码；开团者=团长，自动附带团队共享素材库） */
	async createTeam(code: string, name: string): Promise<{ ok: boolean; error?: string }> {
		try {
			await request("POST", Endpoints.team, { code, name });
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof ManagedClientError ? err.message : (err as Error).message };
		}
	},

	/** 团长：改名 / 切换积分方式（shared=共享池（团长余额）；dispatch=分发模式） */
	async updateTeam(patch: { name?: string; creditMode?: TeamCreditMode }): Promise<{ ok: boolean; error?: string }> {
		try {
			await request("PUT", Endpoints.team, patch);
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof ManagedClientError ? err.message : (err as Error).message };
		}
	},

	/** 团长：按登录账号**邀请**团员（邀请-同意制：对方在其团队页接受才入团） */
	async inviteTeamMember(account: string): Promise<{ ok: boolean; error?: string }> {
		try {
			await request("POST", Endpoints.teamMembers, { account });
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof ManagedClientError ? err.message : (err as Error).message };
		}
	},

	/** 团长：撤销邀请 */
	async cancelTeamInvite(userId: string): Promise<{ ok: boolean; error?: string }> {
		try {
			await request("DELETE", Endpoints.teamInvite(userId));
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof ManagedClientError ? err.message : (err as Error).message };
		}
	},

	/** 被邀请人：接受邀请（唯一入团路径） */
	async acceptTeamInvite(teamId: string): Promise<{ ok: boolean; error?: string }> {
		try {
			await request("POST", Endpoints.teamInviteAccept, { teamId });
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof ManagedClientError ? err.message : (err as Error).message };
		}
	},

	/** 被邀请人：拒绝邀请 */
	async declineTeamInvite(teamId: string): Promise<{ ok: boolean; error?: string }> {
		try {
			await request("POST", Endpoints.teamInviteDecline, { teamId });
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof ManagedClientError ? err.message : (err as Error).message };
		}
	},

	/** 团长：移除团员（分发余量自动退回团长） */
	async removeTeamMember(userId: string): Promise<{ ok: boolean; error?: string }> {
		try {
			await request("DELETE", Endpoints.teamMember(userId));
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof ManagedClientError ? err.message : (err as Error).message };
		}
	},

	/** 团长：分发（delta>0 团长→团员）/ 收回（delta<0 团员→团长）积分 */
	async teamCredits(userId: string, delta: number): Promise<{ ok: boolean; leaderCredits?: number; member?: TeamMemberInfo; error?: string }> {
		try {
			const data = await request<{ ok: boolean; leaderCredits: number; member: TeamMemberInfo }>("POST", Endpoints.teamCredits, { userId, delta });
			return { ok: true, leaderCredits: data.leaderCredits, member: data.member };
		} catch (err) {
			return { ok: false, error: err instanceof ManagedClientError ? err.message : (err as Error).message };
		}
	},

	/** 团员：退出团队 */
	async leaveTeam(): Promise<{ ok: boolean; error?: string }> {
		try {
			await request("POST", Endpoints.teamLeave);
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof ManagedClientError ? err.message : (err as Error).message };
		}
	},

	/** 团长：解散团队（团队共享素材库随删；成员积分保持现状） */
	async dissolveTeam(): Promise<{ ok: boolean; error?: string }> {
		try {
			await request("POST", Endpoints.teamDissolve);
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof ManagedClientError ? err.message : (err as Error).message };
		}
	},

	/** 兑换积分码：成功返回新余额与本次入账面额 */
	async redeem(code: string): Promise<{ ok: boolean; credits?: number; added?: number; error?: string }> {
		try {
			const data = await request<{ ok: boolean; credits: number; added: number }>("POST", Endpoints.redeem, { code });
			return { ok: true, credits: data.credits, added: data.added };
		} catch (err) {
			return { ok: false, error: err instanceof ManagedClientError ? err.message : (err as Error).message };
		}
	},

	/** 本人请求记录列表（第110轮个人中心「请求记录」页）：status 可选 success/failed/running */
	async listLogs(opts?: { limit?: number; offset?: number; status?: string }): Promise<{ total: number; items: UserLogItem[] }> {
		const p = new URLSearchParams();
		if (opts?.limit != null) p.set("limit", String(opts.limit));
		if (opts?.offset != null) p.set("offset", String(opts.offset));
		if (opts?.status) p.set("status", opts.status);
		const q = p.toString();
		return request<{ total: number; items: UserLogItem[] }>("GET", `${Endpoints.logs}${q ? `?${q}` : ""}`, undefined, 15000);
	},

	/** 本人请求记录详情：仅含 ①客户端→服务端 ②服务端→客户端 两段报文 */
	async getLogDetail(id: string): Promise<UserLogDetail> {
		return request<UserLogDetail>("GET", Endpoints.log(id), undefined, 15000);
	},

	/** 拉取目录（增量）；模型/模板/节点/出图模板/变体前缀/schema */
	async fetchCatalog(sinceVersion?: string): Promise<Catalog> {
		const q = sinceVersion ? `?since=${encodeURIComponent(sinceVersion)}` : "";
		return request<Catalog>("GET", `${Endpoints.catalog}${q}`, undefined, 20000);
	},

	/**
	 * 提交生成。统一返回 { taskId }：
	 *  - 异步(图/视频)：管理端返回 taskId，后续轮询
	 *  - 同步(文本)：管理端直接返回结果，这里暂存，首次 getTask 即取回
	 */
	async generate(req: GenerateRequest): Promise<{ taskId: string }> {
		const data = await request<any>("POST", Endpoints.generate, req);
		if (data.taskId) return { taskId: data.taskId };
		// 同步结果：合成一个本地 taskId 暂存
		const taskId = `sync-${req.clientTaskId}`;
		_immediate.set(taskId, {
			taskId,
			clientTaskId: req.clientTaskId,
			status: data.status ?? "success",
			progress: 100,
			result: data.result,
			error: data.error,
		});
		return { taskId };
	},

	/** 查询任务（同步结果走暂存，异步走远端轮询） */
	async getTask(taskId: string): Promise<TaskState> {
		const cached = _immediate.get(taskId);
		if (cached) {
			_immediate.delete(taskId);
			return cached;
		}
		return request<TaskState>("GET", Endpoints.task(taskId), undefined, 30000);
	},

	/** 批量提交（管理端做拓扑排期/并发/幂等/断点续传） */
	async batch(req: BatchRequest): Promise<BatchState> {
		return request<BatchState>("POST", Endpoints.batch, req);
	},

	async getBatch(batchId: string): Promise<BatchState> {
		return request<BatchState>("GET", Endpoints.batchState(batchId), undefined, 30000);
	},

	/**
	 * 上传本地素材 → 管理端对象存储，拿回全局唯一 id + 公网 url。
	 * prefix：资产 id 前缀（如临时素材用 "TP"=temporary）；name：资产名（便于检索/日志）。
	 */
	async uploadAsset(blob: Blob, filename: string, prefix?: string): Promise<AssetUploadResult> {
		// 直传优先（第170轮）：字节直传 OSS 桶不过服务器；任一步失败回退下方 multipart 中转（语义完全一致）
		if (!_directUnavailable) {
			try {
				const direct = await directUpload(blob, filename, prefix);
				if (direct) return direct;
			} catch (err) {
				console.warn("[managedClient] OSS 直传失败，回退服务器中转:", err);
			}
		}
		const form = new FormData();
		form.append("file", blob, filename);
		const qs = new URLSearchParams();
		if (prefix) qs.set("prefix", prefix);
		qs.set("name", filename);
		const path = qs.toString() ? `${Endpoints.assets}?${qs}` : Endpoints.assets;
		const timeoutMs = uploadTimeoutMs(blob.size);
		let resp: Response;
		try {
			resp = await fetch(url(path), {
				method: "POST",
				headers: headers(false), // multipart 不设 Content-Type
				body: form,
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (err) {
			const e = err as Error;
			const msg = e.name === "TimeoutError"
				? `素材上传超时（${(blob.size / 1024 / 1024).toFixed(1)}MB，已等待 ${Math.round(timeoutMs / 1000)} 秒）：网络过慢或服务器不可达，请重试`
				: `素材上传失败: ${e.message}`;
			throw new ManagedClientError(msg, 0);
		}
		const data = await resp.json().catch(() => ({}));
		if (!resp.ok) {
			throw new ManagedClientError((data as any)?.message || `上传失败 HTTP ${resp.status}`, resp.status, data);
		}
		return data as AssetUploadResult;
	},

	/**
	 * 死链自愈①：探资产 OSS 直链是否可达（服务端 HEAD，绕 webview CORS）。
	 * 查不了一律当「活着」（失败安全：绝不因探测失败误判死链而白重传）。
	 * 第224轮起附带服务端当前 url——别人已桥接恢复到新 OSS 时，本机据此直接换用新链接。
	 */
	async assetAlive(assetId: string): Promise<{ alive: boolean; url?: string }> {
		try {
			const data = await request<{ alive: boolean; url?: string }>("GET", `${Endpoints.assets}/${assetId}/alive`, undefined, 15000);
			return { alive: !!data.alive, url: typeof data.url === "string" && data.url ? data.url : undefined };
		} catch {
			return { alive: true };
		}
	},

	/** 死链自愈②：用本地副本字节把资产写回 OSS 原键（url 不变），修复丢失对象。失败返回 null。 */
	async reputAsset(assetId: string, blob: Blob, filename: string): Promise<{ id: string; url: string } | null> {
		const form = new FormData();
		form.append("file", blob, filename);
		try {
			const resp = await fetch(url(`${Endpoints.assets}/${assetId}/reput`), {
				method: "POST",
				headers: headers(false), // multipart 不设 Content-Type
				body: form,
				signal: AbortSignal.timeout(uploadTimeoutMs(blob.size)),
			});
			const data = await resp.json().catch(() => ({}));
			if (!resp.ok) return null;
			return { id: (data as any).id, url: (data as any).url };
		} catch (e) {
			console.warn("[managedClient] reputAsset failed:", e);
			return null;
		}
	},

	// ── 共享素材库（第120轮）：三级=库/文件夹/素材；素材只存 OSS 记录，字节不复制 ──

	/** 已加入的共享库（共享资产首层，轻量） */
	async sharedLibraries(): Promise<SharedLibraryInfo[]> {
		return (await request<{ items: SharedLibraryInfo[] }>("GET", Endpoints.sharedLibraries, undefined, 15000)).items;
	},

	/** 受众内按库名搜索（加入用；joined=是否已加入） */
	async sharedSearch(q: string): Promise<Array<SharedLibraryInfo & { joined?: boolean }>> {
		return (await request<{ items: Array<SharedLibraryInfo & { joined?: boolean }> }>("GET", `${Endpoints.sharedSearch}?q=${encodeURIComponent(q)}`, undefined, 15000)).items;
	},

	/** 凭密码加入共享库 */
	async sharedJoin(libId: string, password: string): Promise<{ ok: boolean; library?: SharedLibraryInfo; error?: string }> {
		try {
			const data = await request<{ ok: boolean; library: SharedLibraryInfo }>("POST", Endpoints.sharedJoin(libId), { password }, 15000);
			return { ok: true, library: data.library };
		} catch (err) {
			return { ok: false, error: err instanceof ManagedClientError ? err.message : (err as Error).message };
		}
	},

	async sharedLeave(libId: string): Promise<void> {
		await request("POST", Endpoints.sharedLeave(libId), {}, 15000);
	},

	/** 二级「获取」：库内文件夹 + 各自素材数（惰性加载，绝不连带素材） */
	async sharedFolders(libId: string): Promise<SharedFolderInfo[]> {
		return (await request<{ items: SharedFolderInfo[] }>("GET", Endpoints.sharedFolders(libId), undefined, 20000)).items;
	},

	async sharedCreateFolder(libId: string, name: string): Promise<{ ok: boolean; folder?: SharedFolderInfo; error?: string }> {
		try {
			const data = await request<{ ok: boolean; folder: SharedFolderInfo }>("POST", Endpoints.sharedFolders(libId), { name }, 15000);
			return { ok: true, folder: data.folder };
		} catch (err) {
			return { ok: false, error: err instanceof ManagedClientError ? err.message : (err as Error).message };
		}
	},

	/** 三级「获取」：文件夹内素材记录（进入文件夹后才拉；带 assetId 的服务端已按台账刷新直链） */
	async sharedFolderAssets(folderId: string): Promise<SharedAssetRecord[]> {
		return (await request<{ items: SharedAssetRecord[] }>("GET", Endpoints.sharedFolderAssets(folderId), undefined, 30000)).items;
	},

	/** 分享素材=登记 OSS 记录（不复制字节）。items 里 assetId 优先（id 是真理），否则 url 须真公网。 */
	async sharedAddAssets(
		folderId: string,
		items: Array<{ assetId?: string; url?: string; name: string; mime?: string }>,
	): Promise<{ ok: boolean; added?: number; skipped?: number; error?: string }> {
		try {
			const data = await request<{ ok: boolean; added: number; skipped: number }>("POST", Endpoints.sharedFolderAssets(folderId), { items }, 30000);
			return { ok: true, added: data.added, skipped: data.skipped };
		} catch (err) {
			return { ok: false, error: err instanceof ManagedClientError ? err.message : (err as Error).message };
		}
	},

	/** url 过期后凭 id 重解析（id 是真理，url 是缓存） */
	async resolveAssetUrl(assetId: string): Promise<string> {
		const data = await request<{ id: string; url: string }>(
			"GET",
			`${Endpoints.assets}/${assetId}`,
			undefined,
			20000,
		);
		return data.url;
	},

	/**
	 * 转存兜底：请管理端把「上游直链」下载并转存到 OSS，返回永久公网直链 + 全局资产 id。
	 * 用于客户端 webview 直接下载上游直链被 CORS 拦时——改从 OSS（同 S3、CORS 友好）下载到本地播放。
	 * 服务端 200s 超时内下载大视频；失败/未配 OSS 返回 null（调用方回退原直链）。
	 */
	async rehost(url: string, prefix?: string, name?: string): Promise<{ id: string; url: string } | null> {
		try {
			const data = await request<{ id: string; url: string }>("POST", Endpoints.assetRehost, { url, prefix, name }, 200000);
			return data.url ? data : null;
		} catch {
			return null;
		}
	},

	/**
	 * 引用上报（P1）：把项目引用到的资产 id 批量报给服务端刷 last_ref_at。
	 * 服务端据此判断「这个素材还有人在用」，决定保留多久——**不报就会按「未引用」更早清理**。
	 * best-effort：失败静默（打开/保存项目绝不能被它拖累），下次打开/保存会再报一次。
	 * 返回需要走死链自愈的 id（服务端标了墓碑或台账里没有）。
	 */
	async reportAssetRefs(ids: string[]): Promise<string[]> {
		if (!ids.length) return [];
		try {
			const data = await request<{ updated: number; needHeal?: string[] }>("POST", Endpoints.assetRef, { ids }, 20000);
			return data.needHeal ?? [];
		} catch {
			return [];
		}
	},

	// ── 收藏与配额（P1）──
	async listFavorites(): Promise<{ items: FavoriteItemDto[]; quota: FavQuotaDto; grants: QuotaGrantDto[] }> {
		return request("GET", Endpoints.favorites, undefined, 20000);
	},
	/** 加收藏。超配额时服务端回 409，错误信息即「收藏空间已满…」，直接透给用户 */
	async addFavorite(assetId: string): Promise<{ ok: boolean; quota?: FavQuotaDto }> {
		return request("POST", Endpoints.favorites, { assetId }, 20000);
	},
	async removeFavorite(assetId: string): Promise<{ removed: boolean; stillPinned: boolean; quota?: FavQuotaDto }> {
		return request("DELETE", Endpoints.favorite(assetId), undefined, 20000);
	},
	/** 批量问「这些我收藏了吗」——一次查完，不逐个问 */
	async favoriteFlags(ids: string[]): Promise<string[]> {
		if (!ids.length) return [];
		try {
			const r = await request<{ favorited: string[] }>("POST", Endpoints.favoriteFlags, { ids }, 20000);
			return r.favorited ?? [];
		} catch {
			return [];
		}
	},
	async redeemStorageCode(code: string): Promise<{ ok: boolean; granted?: QuotaGrantDto; quota?: FavQuotaDto }> {
		return request("POST", Endpoints.storageCodeRedeem, { code }, 20000);
	},

	/**
	 * 缩略图直传（P1）：把 256px WebP 直传到 thumb/ 前缀并回报。
	 * best-effort：任一步失败静默返回 false —— 缩略图只是加速显示，没有它一切照常。
	 */
	async uploadThumb(assetId: string, blob: Blob): Promise<boolean> {
		try {
			const sign = await request<{ putUrl: string }>("POST", Endpoints.assetThumb(assetId), {}, 20000);
			if (!sign?.putUrl) return false;
			const put = await fetch(sign.putUrl, {
				method: "PUT",
				body: blob,
				headers: { "Content-Type": "image/webp" },
				signal: AbortSignal.timeout(60000),
			});
			if (!put.ok) return false;
			await request("POST", Endpoints.assetThumbComplete(assetId), {}, 20000);
			return true;
		} catch {
			return false;
		}
	},

	/**
	 * 第158轮：客户端接力转存回报——rawLink 结果本机下载 + 上传 OSS 完成后，
	 * 请服务端把该任务响应体里的原始时效直链改写为真 OSS 台账资产（rehosted→true）。
	 * best-effort：失败返回 false（本地三元映射已正确，只是断连找回时会再走一次接力转存）。
	 */
	async rewriteTaskResult(taskId: string, assetId: string): Promise<boolean> {
		try {
			const data = await request<{ ok?: boolean }>("POST", Endpoints.taskResultAsset(taskId), { assetId }, 30000);
			return data?.ok === true;
		} catch {
			return false;
		}
	},
};

export { ManagedClientError };
