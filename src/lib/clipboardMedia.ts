/**
 * clipboardMedia —— 从剪贴板 / 拖拽数据里抽取图片/视频/音频文件（素材）。
 *
 * 用途：在提示词输入框粘贴截图/媒体文件、或把本地文件拖入素材区时，统一拿到 File[]，
 * 交给上层走「上传 OSS → 加入素材区」链路（资产模式 addLocalMaterial / 画布 uploadMediaToCanvasAsset）。
 */
const MEDIA_RE = /^(image|video|audio)\//i;

/** 从 DataTransfer（剪贴板/拖拽）里取出媒体文件；items 优先（覆盖截图位图），回退 files。去重(name+size)。 */
export function mediaFilesFromDataTransfer(dt: DataTransfer | null): File[] {
	if (!dt) return [];
	const out: File[] = [];
	const seen = new Set<string>();
	const push = (f: File | null) => {
		if (!f || !MEDIA_RE.test(f.type)) return;
		const key = `${f.name}:${f.size}:${f.type}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push(f);
	};
	// items：粘贴截图（kind=file, type=image/png）走这里
	for (const it of Array.from(dt.items || [])) {
		if (it.kind === "file" && MEDIA_RE.test(it.type)) push(it.getAsFile());
	}
	// files：从资源管理器粘贴/拖入的文件
	for (const f of Array.from(dt.files || [])) push(f);
	return out;
}

/** 从粘贴事件抽媒体文件 */
export function mediaFilesFromClipboard(e: { clipboardData: DataTransfer | null }): File[] {
	return mediaFilesFromDataTransfer(e.clipboardData);
}
