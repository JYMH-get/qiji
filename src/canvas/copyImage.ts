/**
 * copyImage —— 复制节点时把结果图写入**系统剪贴板**（PNG）。
 *
 * 用途：Ctrl+C 精准复制 / 全能复制（快捷键与右键菜单）成功后顺带调用——复制出的图可以直接
 * 粘贴到简一助手（转垫图）或外部软件。best-effort：剪贴板不可用/取字节失败一律静默忽略，
 * 绝不影响节点复制本身。多个图片节点被复制时只取**第一个**（按选中顺序）的主图——
 * 系统剪贴板一次只能承载一张图。
 *
 * 注意：navigator.clipboard.write 依赖用户手势/焦点——这里用 **Promise 值的 ClipboardItem**
 * （write 同步发起、PNG 字节异步供给），避免先 await 取字节导致手势上下文丢失被拒。
 */
import type { CanvasNode } from "@/types";
import { useLibraryStore } from "@/store/libraryStore";
import { useProjectStore } from "@/store/projectStore";
import { getPlugin } from "@/nodes/pluginRegistry";
import { isWebviewLocalUri } from "@/lib/publicUrl";
// 节点复制的系统剪贴板标记：随 PNG 同一 ClipboardItem 写入 text/plain——画布 paste 事件靠它
// 区分「刚复制的是本画布节点」（内部克隆粘贴）还是「外部图片/文字」（新建节点）。
// 粘贴到外部纯文本编辑器时会看到这串说明文字，属预期。
import { NODE_COPY_MARKER } from "@/lib/pasteRoute";

/** 资产的最佳取字节 uri：本地/内联直用；远程优先已登记本地副本（同 shotGroupOps） */
function fetchUriOf(assetId: string): string {
	const asset = useLibraryStore.getState().assets[assetId];
	const uri = asset?.uri || "";
	if (!uri) return "";
	if (!/^https?:/i.test(uri) || isWebviewLocalUri(uri)) return uri;
	const blob = useProjectStore.getState().blobByUri(uri);
	return blob?.localUri || uri;
}

/**
 * 取字节并统一转码 PNG——Chromium 剪贴板只收 image/png，经 canvas 重编码顺带覆盖非 png 源。
 * fetch 字节 → createImageBitmap（同源字节防画布污染）；失败回退 <img crossOrigin>。
 */
async function toPngBlob(uri: string): Promise<Blob> {
	let bmp: ImageBitmap | HTMLImageElement;
	try {
		const resp = await fetch(uri);
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
		bmp = await createImageBitmap(await resp.blob());
	} catch {
		bmp = await new Promise<HTMLImageElement>((resolve, reject) => {
			const img = new Image();
			img.crossOrigin = "anonymous";
			img.onload = () => resolve(img);
			img.onerror = () => reject(new Error(`图像加载失败：${uri.slice(0, 80)}`));
			img.src = uri;
		});
	}
	const w = "naturalWidth" in bmp ? bmp.naturalWidth : bmp.width;
	const h = "naturalHeight" in bmp ? bmp.naturalHeight : bmp.height;
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, w);
	canvas.height = Math.max(1, h);
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("no 2d ctx");
	ctx.drawImage(bmp, 0, 0);
	return await new Promise<Blob>((resolve, reject) =>
		canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob 失败（图像可能跨域污染）"))), "image/png"),
	);
}

/**
 * 复制节点集时写系统剪贴板：**恒写标记文本**（供画布粘贴识别内部复制），
 * 选中集里有图片结果时同一 ClipboardItem 附带首张 PNG（可粘贴到简一助手/外部软件——
 * 图像类应用优先取 image/png，标记文本不影响）。
 * 返回是否发起了写入（false=剪贴板不可用）。
 */
export function copyNodesImageToSystemClipboard(nodes: Array<CanvasNode | undefined>): boolean {
	try {
		if (typeof navigator === "undefined" || !navigator.clipboard?.write || typeof ClipboardItem === "undefined") return false;
		const img = nodes.find(
			(n): n is CanvasNode => !!n && getPlugin(n.type)?.displayKind === "image" && !!n.data.resultAssetId,
		);
		const uri = img ? fetchUriOf(img.data.resultAssetId!) : "";
		const item: Record<string, Blob | Promise<Blob>> = {
			"text/plain": new Blob([NODE_COPY_MARKER], { type: "text/plain" }),
		};
		if (uri) item["image/png"] = toPngBlob(uri);
		void navigator.clipboard
			.write([new ClipboardItem(item)])
			.catch(() => { /* 权限/焦点/取字节失败：静默，不影响节点复制 */ });
		return true;
	} catch {
		return false;
	}
}
