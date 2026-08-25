/**
 * comfyuiClient —— ComfyUI 直连的传输层（⚠ CORS 双路径）。
 *
 * ComfyUI 默认**不带 CORS 头**，webview 里直接 fetch 会被浏览器拦下——
 *   - Tauri（打包版/真机）：一律走 Rust 命令代发（并行实现，签名冻结如下，勿改）：
 *       invoke("comfy_http_json", { method, url, body?, timeoutSecs? })
 *         → { status: number, body: any }（非 2xx 也正常返回，调用方判 status；body 解析失败=null）
 *       invoke("comfy_upload_file", { url, fieldFilename, filePath, timeoutSecs? })
 *         → { status: number, body: any }（multipart 字段 image=@filePath（文件名 fieldFilename）
 *            + 文本字段 overwrite=true；url=调用方拼好的 {base}/upload/image）
 *   - 浏览器 dev：回退 window.fetch——需 ComfyUI 以 `--enable-cors-header` 参数启动才通
 *     （个人中心绑定区块有同款提示；不带该参数时请求会被 CORS 拦，报网络错误）。
 *
 * 三个导出的返回形态统一 { status, body }：网络层错误（连不上/超时）直接 throw，
 * HTTP 层错误（4xx/5xx）如实返回交调用方提炼人话（ComfyUI 的报错细节在 body 里）。
 */

const isTauri = (): boolean =>
	typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

export interface ComfyHttpResult {
	status: number;
	/** 响应体（JSON 解析结果；解析失败/空体=null） */
	body: unknown;
}

const DEFAULT_TIMEOUT_SECS = 60;

/** 浏览器回退路径：window.fetch + JSON 解析（非 2xx 也返回；网络错误 throw） */
async function browserFetchJson(method: "GET" | "POST", url: string, body?: unknown, timeoutSecs?: number): Promise<ComfyHttpResult> {
	const resp = await fetch(url, {
		method,
		headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout((timeoutSecs ?? DEFAULT_TIMEOUT_SECS) * 1000),
	});
	let parsed: unknown = null;
	try {
		parsed = await resp.json();
	} catch {
		parsed = null;
	}
	return { status: resp.status, body: parsed };
}

/** GET {url}（如 {base}/queue、{base}/history/{id}） */
export async function comfyGet(url: string, opts?: { timeoutSecs?: number }): Promise<ComfyHttpResult> {
	if (isTauri()) {
		const { invoke } = await import("@tauri-apps/api/core");
		return await invoke<ComfyHttpResult>("comfy_http_json", {
			method: "GET",
			url,
			timeoutSecs: opts?.timeoutSecs ?? DEFAULT_TIMEOUT_SECS,
		});
	}
	return browserFetchJson("GET", url, undefined, opts?.timeoutSecs);
}

/** POST {url} JSON body（如 {base}/prompt） */
export async function comfyPostJson(url: string, body: unknown, opts?: { timeoutSecs?: number }): Promise<ComfyHttpResult> {
	if (isTauri()) {
		const { invoke } = await import("@tauri-apps/api/core");
		return await invoke<ComfyHttpResult>("comfy_http_json", {
			method: "POST",
			url,
			body,
			timeoutSecs: opts?.timeoutSecs ?? DEFAULT_TIMEOUT_SECS,
		});
	}
	return browserFetchJson("POST", url, body, opts?.timeoutSecs);
}

/**
 * 上传一个素材文件进 ComfyUI 的 input 目录（POST {base}/upload/image，图/视频/音频通吃——
 * ComfyUI 该端点只管收文件，类型由消费它的 Loader 节点决定）。
 * Tauri=本地文件路径走 Rust（流式 multipart，绕 CORS）；浏览器=字节走 FormData。
 * 成功响应 body 形如 { name, subfolder, type }——调用方消费 body.name（+subfolder）填 Loader。
 */
export async function comfyUpload(
	baseUrl: string,
	fieldFilename: string,
	localFilePathOrBytes: string | Uint8Array,
	opts?: { timeoutSecs?: number },
): Promise<ComfyHttpResult> {
	const url = `${baseUrl}/upload/image`;
	if (typeof localFilePathOrBytes === "string") {
		// 文件路径形态仅 Tauri 可用（Rust 读文件）；浏览器拿不到本地路径，调用方应传字节
		const { invoke } = await import("@tauri-apps/api/core");
		return await invoke<ComfyHttpResult>("comfy_upload_file", {
			url,
			fieldFilename,
			filePath: localFilePathOrBytes,
			timeoutSecs: opts?.timeoutSecs ?? 300,
		});
	}
	// 字节形态：浏览器 dev 回退（FormData 与 Rust 命令同字段：image + overwrite=true）
	const fd = new FormData();
	fd.append("image", new Blob([localFilePathOrBytes as unknown as BlobPart]), fieldFilename);
	fd.append("overwrite", "true");
	const resp = await fetch(url, {
		method: "POST",
		body: fd,
		signal: AbortSignal.timeout((opts?.timeoutSecs ?? 300) * 1000),
	});
	let parsed: unknown = null;
	try {
		parsed = await resp.json();
	} catch {
		parsed = null;
	}
	return { status: resp.status, body: parsed };
}
