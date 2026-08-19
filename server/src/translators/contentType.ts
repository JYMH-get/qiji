/**
 * 归一化上游下载响应的 Content-Type，供「下载字节 → 落资产」的取型点共用。
 *
 * 背景（2026-08-03）：出海营渠道的成片托管站（minioapi.meaicc.com，MinIO）对成片对象
 * 返回 `binary/octet-stream`（对象上传时没设元数据，MinIO 按默认值服务）——各取型点原本
 * 只在「头缺失」时兜底，垃圾值照单全收，经 extFor 映射不到就落成 `.bin` 资产，
 * OSS 直链也以 octet-stream 对外服务（webview <video> 拒播）。
 *
 * 语义：剥掉 `;charset=` 参数段；头缺失或为泛型二进制类型（application/octet-stream、
 * binary/octet-stream）一律视为「上游没说」→ 用调用方给的兜底值（调用方在自己的语境里
 * 知道资产是什么：视频转存=video/mp4、音频=audio/mpeg……）。正常的具体类型原样保留。
 */
const GENERIC_BINARY = new Set(["application/octet-stream", "binary/octet-stream", "octet-stream"]);

export function resolveContentType(raw: string | null | undefined, fallback: string): string {
	const ct = (raw || "").split(";")[0].trim().toLowerCase();
	if (!ct || GENERIC_BINARY.has(ct)) return fallback;
	return ct;
}
