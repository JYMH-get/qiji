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
} from "@/contract";
import { useConnectionStore } from "@/store/connectionStore";

/** 同步结果暂存：sync 任务无需轮询远端，poll 时从这里取一次 */
const _immediate = new Map<string, TaskState>();

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
	const h: Record<string, string> = { Authorization: `Bearer ${accessKey}` };
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
	async login(): Promise<{ ok: boolean; user?: SessionUser; error?: string }> {
		const { accessKey } = useConnectionStore.getState();
		let resp: Response;
		try {
			resp = await fetch(url(Endpoints.login), {
				method: "POST",
				headers: headers(true),
				body: JSON.stringify({ accessKey }),
				signal: AbortSignal.timeout(20000),
			});
		} catch (err) {
			return { ok: false, error: `无法连接管理端：${(err as Error).message}` };
		}
		const data = await resp.json().catch(() => ({}));
		if (!resp.ok) return { ok: false, error: (data as any)?.error?.message || `登录失败 HTTP ${resp.status}` };
		return { ok: true, user: (data as any).user };
	},

	/** 心跳：accessKey 仍有效（启用）返回 true，否则 false。 */
	async heartbeat(): Promise<{ ok: boolean; user?: SessionUser }> {
		try {
			const resp = await fetch(url(Endpoints.heartbeat), {
				method: "POST",
				headers: headers(true),
				body: "{}",
				signal: AbortSignal.timeout(15000),
			});
			if (!resp.ok) return { ok: false };
			const data = await resp.json().catch(() => ({}));
			return { ok: true, user: (data as any).user };
		} catch {
			return { ok: false };
		}
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

	/** 上传本地素材 → 管理端对象存储，拿回全局唯一 id + 公网 url */
	async uploadAsset(blob: Blob, filename: string): Promise<AssetUploadResult> {
		const form = new FormData();
		form.append("file", blob, filename);
		let resp: Response;
		try {
			resp = await fetch(url(Endpoints.assets), {
				method: "POST",
				headers: headers(false), // multipart 不设 Content-Type
				body: form,
				signal: AbortSignal.timeout(120000),
			});
		} catch (err) {
			throw new ManagedClientError(`素材上传失败: ${(err as Error).message}`, 0);
		}
		const data = await resp.json().catch(() => ({}));
		if (!resp.ok) {
			throw new ManagedClientError((data as any)?.message || `上传失败 HTTP ${resp.status}`, resp.status, data);
		}
		return data as AssetUploadResult;
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
};

export { ManagedClientError };
