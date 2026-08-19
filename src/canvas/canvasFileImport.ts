/**
 * canvasFileImport —— 把本地文件（拖入 / 系统剪贴板粘贴）导入画布成节点的单一实现。
 *  - 图片文件名命中已登记 assetBlob（资产助手原生拖入 <assetId>.<ext>）→ 复用 id，建 image.gen 节点；
 *  - 其余媒体（图/视频/音频）→ 「上传本地」节点 + OSS 上传（uploadMediaToCanvasAsset，显示本地/请求公网）；
 *  - 文本类文件（.txt/.doc/.docx/.pdf/.json）→ 上传节点 + 本地落库（不占 OSS）。
 * useCanvasDrop（拖入）与 useCanvasPaste（Ctrl+V 粘贴）共用；新增导入入口一律走这里。
 */
import { storeDroppedFile } from "@/services/fileStorage";
import { uploadMediaToCanvasAsset } from "./nodeUpload";
import { makeNode } from "./nodeFactory";
import { useLibraryStore } from "@/store/libraryStore";
import { useProjectStore } from "@/store/projectStore";
import { useCanvasStore } from "@/store/canvasStore";
import { dispatchCommand } from "@/command/dispatch";

/** 逐文件导入画布（pos 为画布坐标；多文件纵向排开）。返回受理的文件数。 */
export function importFilesToCanvas(files: File[], pos: { x: number; y: number }): number {
	let offsetY = 0;
	let accepted = 0;
	for (const file of files) {
		// 资产助手原生拖入：文件名 <assetId>.<ext> 命中已登记 blob → 复用 id（粘贴 id，不重复入库字节）
		if (file.type.startsWith("image/")) {
			const base = file.name.replace(/\.[^.]+$/, "");
			const blob = useProjectStore.getState().assetBlobs[base];
			const ref = blob?.localUri || blob?.url;
			if (blob && ref) {
				useLibraryStore.getState().addAsset({
					id: blob.id, kind: "image", name: file.name, uri: ref, thumbnailUri: ref,
					createdAt: new Date().toISOString(), deletedByUser: false, localPath: blob.localPath || null,
					origin: "generated", // 资产助手派生 → 不进「本地素材库」
				});
				// 资产图 → 新建「生成图片」节点，把该图作为节点结果显示（可再连线/重生成）
				const node = makeNode("image.gen", pos.x, pos.y + offsetY);
				node.data.resultAssetId = blob.id;
				dispatchCommand({ type: "addNode", node });
				offsetY += 240;
				accepted++;
				continue;
			}
		}
		let kind: "image" | "video" | "audio" | "script" | null = null;
		if (file.type.startsWith("image/")) {
			kind = "image";
		} else if (file.type.startsWith("video/")) {
			kind = "video";
		} else if (file.type.startsWith("audio/")) {
			kind = "audio";
		} else if (
			file.name.endsWith(".txt") ||
			file.name.endsWith(".doc") ||
			file.name.endsWith(".docx") ||
			file.name.endsWith(".pdf") ||
			file.name.endsWith(".json")
		) {
			kind = "script";
		}

		if (kind) {
			accepted++;
			// 捕获当前落点（offsetY 随循环递增，闭包延迟执行时已变；快照避免多文件位置错位）
			const px = pos.x;
			const py = pos.y + offsetY;
			// 先建节点（立即可见）：媒体类标「上传中…」转圈，避免 OSS 上传期间静默无响应。
			const newNode = makeNode("upload", px, py);
			newNode.data.fileMime = file.type;
			dispatchCommand({ type: "addNode", node: newNode });
			if (kind !== "script") useCanvasStore.getState().setRuntime(newNode.id, { status: "uploading" });
			void (async () => {
				try {
					let assetId: string;
					let displayUri: string;
					let localPath: string | null = null;
					if (kind === "script") {
						// 文本类不作上游媒体素材：本地落库即可
						const stored = await storeDroppedFile(file);
						if (!stored) { useCanvasStore.getState().removeNode(newNode.id); return; }
						assetId = stored.fileId;
						displayUri = stored.fileUri;
						localPath = stored.localPath;
					} else {
						// 媒体类（图/视频/音频）：先传 OSS 拿 id+公网url（请求用），本地副本显示
						const up = await uploadMediaToCanvasAsset(file);
						assetId = up.assetId;
						displayUri = up.displayUri;
						localPath = up.localPath;
					}

					useLibraryStore.getState().addAsset({
						id: assetId,
						kind,
						name: file.name,
						uri: displayUri,
						serverAssetId: kind === "script" ? null : assetId,
						thumbnailUri: null,
						createdAt: new Date().toISOString(),
						deletedByUser: false,
						localPath,
						origin: "upload", // 本地文件导入 → 进「本地素材库」
					});

					// 上传完成 → 回填结果并清除上传态
					const cs = useCanvasStore.getState();
					const n = cs.nodes[newNode.id];
					if (n) useCanvasStore.setState({ nodes: { ...cs.nodes, [newNode.id]: { ...n, data: { ...n.data, resultAssetId: assetId, fileMime: file.type } } } });
					cs.setRuntime(newNode.id, { status: "idle" });
				} catch (err) {
					useCanvasStore.getState().setRuntime(newNode.id, { status: "failed", error: err instanceof Error ? err.message : "上传失败" });
					alert(`文件上传失败（未做 OSS 存储）：${err instanceof Error ? err.message : "未知错误"}`);
				}
			})();
			offsetY += 240;
		}
	}
	return accepted;
}

/** 粘贴纯文字 → 文本节点（内容既是展示结果也是下游输入；与原文节点同语义） */
export function createTextNodeAt(text: string, pos: { x: number; y: number }): void {
	const node = makeNode("text.seed", pos.x, pos.y);
	node.data.params.prompt = text;
	node.data.resultText = text;
	dispatchCommand({ type: "addNode", node });
}
