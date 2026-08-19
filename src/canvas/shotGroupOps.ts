/**
 * shotGroupOps —— 分镜组的落库/合成操作（碰 store 与网络；纯布局函数在 src/lib/shotGroup.ts）。
 *
 *  - createShotGroupFromNodes：多选图片节点 → 合并为分镜组（源节点删除，一次撤销）。
 *  - stitchShotGroup：宫格拼接成一张 2048 宽大图 → 上传资产 → 右侧新 image.gen 节点承载。
 *  - splitImageToShotGroup：图片按行列裁剪选中宫格 → 逐格上传资产 → 右侧生成分镜组节点。
 *
 * 图像字节一律走 fetch(显示uri)→createImageBitmap（同源字节，避免 asset:// 图污染画布
 * 导致 toBlob 抛错——见 assetPersist 同款做法）；fetch 失败回退 <img crossOrigin>。
 */
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { useProjectStore } from "@/store/projectStore";
import { dispatchCommand } from "@/command/dispatch";
import { uploadMediaToCanvasAsset } from "@/canvas/nodeUpload";
import { makeNode } from "@/canvas/nodeFactory";
import { getPlugin } from "@/nodes/pluginRegistry";
import { isWebviewLocalUri } from "@/lib/publicUrl";
import { buildShotGroupNode, parseRatio, shotGridOf } from "@/lib/shotGroup";
import { detectTrimRect } from "@/lib/imageTrim";

/** 资产的最佳取字节 uri：本地/内联直用；远程优先已登记本地副本 */
function fetchUriOf(assetId: string): string {
	const asset = useLibraryStore.getState().assets[assetId];
	const uri = asset?.uri || "";
	if (!uri) return "";
	if (!/^https?:/i.test(uri) || isWebviewLocalUri(uri)) return uri;
	const blob = useProjectStore.getState().blobByUri(uri);
	return blob?.localUri || uri;
}

/** 载入图像位图：fetch 字节 → createImageBitmap；失败回退 <img crossOrigin> */
async function loadBitmap(uri: string): Promise<ImageBitmap | HTMLImageElement> {
	try {
		const resp = await fetch(uri);
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
		return await createImageBitmap(await resp.blob());
	} catch {
		return await new Promise<HTMLImageElement>((resolve, reject) => {
			const img = new Image();
			img.crossOrigin = "anonymous";
			img.onload = () => resolve(img);
			img.onerror = () => reject(new Error(`图像加载失败：${uri.slice(0, 80)}`));
			img.src = uri;
		});
	}
}

const dimOf = (b: ImageBitmap | HTMLImageElement) =>
	"naturalWidth" in b ? { w: b.naturalWidth, h: b.naturalHeight } : { w: b.width, h: b.height };

function canvasToBlob(canvas: HTMLCanvasElement, type = "image/png"): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas.toBlob 失败（图像可能跨域污染）"))), type, 0.92);
	});
}

/** W:H 像素 → 比例串（整数约简；除不尽用两位小数比 1） */
export function ratioStringFrom(w: number, h: number): string {
	if (!(w > 0 && h > 0)) return "16:9";
	const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
	const g = gcd(Math.round(w), Math.round(h));
	const rw = Math.round(w) / g;
	const rh = Math.round(h) / g;
	if (rw <= 64 && rh <= 64) return `${rw}:${rh}`;
	return `${(w / h).toFixed(2)}:1`;
}

/**
 * 多选图片节点 → 合并为分镜组：取各节点主图（按 y→x 阅读序），组节点落在源集合左上角，
 * 源节点删除（连线级联，一次撤销恢复全部）。返回错误文案（null=成功）。
 */
export function createShotGroupFromNodes(sourceIds: string[]): string | null {
	const nodes = useCanvasStore.getState().nodes;
	const srcs = sourceIds
		.map((id) => nodes[id])
		.filter((n) => n && getPlugin(n.type)?.displayKind === "image" && !!n.data.resultAssetId)
		.sort((a, b) => (Math.abs(a.y - b.y) > 40 ? a.y - b.y : a.x - b.x));
	if (srcs.length < 2) return "至少选择 2 个有图片结果的节点（生成图片/上传图片）";
	const assets = srcs.map((n) => n.data.resultAssetId!) ;
	const x = Math.min(...srcs.map((n) => n.x));
	const y = Math.min(...srcs.map((n) => n.y));
	const node = buildShotGroupNode({ assets, x, y, title: "分镜组" });
	dispatchCommand({ type: "createShotGroup", node, deleteSourceIds: srcs.map((n) => n.id) });
	return null;
}

/**
 * 宫格拼接：按当前宫格布局把组内图片合成一张大图（宽 outW：2k=2048 / 4k=4096，
 * 单格 cover 裁齐，无缝），上传为资产 → 分镜组右侧生成新 image.gen 节点承载。
 * 行数收敛到实际占用（不留空白带）。
 */
export async function stitchShotGroup(nodeId: string, outW: 2048 | 4096 = 2048): Promise<void> {
	const node = useCanvasStore.getState().nodes[nodeId];
	if (!node || node.type !== "shot.group") throw new Error("节点不是分镜组");
	const assets = (node.data.shotAssets ?? []).filter((id) => !!useLibraryStore.getState().assets[id]);
	if (assets.length === 0) throw new Error("分镜组内没有图片");
	const { cols, ratio } = shotGridOf(node);
	const usedRows = Math.ceil(assets.length / cols);
	const aspect = parseRatio(ratio);
	const cellW = Math.floor(outW / cols);
	const cellH = Math.round(cellW / aspect);

	const canvas = document.createElement("canvas");
	canvas.width = cellW * cols;
	canvas.height = cellH * usedRows;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("无法创建绘图上下文");
	ctx.fillStyle = "#101014";
	ctx.fillRect(0, 0, canvas.width, canvas.height);

	for (let i = 0; i < assets.length; i++) {
		const uri = fetchUriOf(assets[i]);
		if (!uri) continue;
		const bmp = await loadBitmap(uri);
		const { w, h } = dimOf(bmp);
		// cover 裁齐：取源图中心最大匹配区
		const scale = Math.max(cellW / w, cellH / h);
		const sw = cellW / scale;
		const sh = cellH / scale;
		const sx = (w - sw) / 2;
		const sy = (h - sh) / 2;
		ctx.drawImage(bmp, sx, sy, sw, sh, (i % cols) * cellW, Math.floor(i / cols) * cellH, cellW, cellH);
		if ("close" in bmp) bmp.close();
	}

	const blob = await canvasToBlob(canvas);
	const grade = outW >= 4096 ? "4k" : "2k";
	const file = new File([blob], `分镜拼接-${grade}.png`, { type: "image/png" });
	const up = await uploadMediaToCanvasAsset(file, "TP");
	useLibraryStore.getState().addAsset({
		id: up.assetId,
		kind: "image",
		name: file.name,
		uri: up.displayUri,
		serverAssetId: up.assetId,
		thumbnailUri: null,
		createdAt: new Date().toISOString(),
		deletedByUser: false,
		localPath: up.localPath,
	});
	const child = makeNode("image.gen", node.x + node.w + 64, node.y);
	child.data.resultAssetId = up.assetId;
	child.data.resultHistory = [up.assetId];
	child.data.params = { ...child.data.params, prompt: `分镜组拼接（${grade}，${cols}×${usedRows}，${canvas.width}×${canvas.height}）` };
	dispatchCommand({ type: "addNode", node: child });
}

/**
 * 图片宫格切分：把图片节点主图按 rows×cols 均分，裁剪 cells 选中的宫格（r/c 从 0 计），
 * 逐格上传资产 → 源节点右侧生成分镜组节点承载（宫格比例=切出单格的真实比例）。
 * trimBorder（缺省开）：逐格自动去白边（detectTrimRect：四角采样背景色+容差扫描+单边上限，
 * 见 lib/imageTrim）——canvas 被跨域污染读不了像素时按原样切（<img crossOrigin> 回退路径固有约束）。
 */
export async function splitImageToShotGroup(
	nodeId: string,
	rows: number,
	cols: number,
	cells: { r: number; c: number }[],
	trimBorder = true,
): Promise<void> {
	const node = useCanvasStore.getState().nodes[nodeId];
	const srcId = node?.data.resultAssetId;
	if (!node || !srcId) throw new Error("未找到图片资产（请确认已生成/下载完成）");
	if (cells.length === 0) throw new Error("请至少选择一个宫格");
	const srcAsset = useLibraryStore.getState().assets[srcId];
	const base = (srcAsset?.name || "图片").replace(/\.[^.]+$/, "");
	const uri = fetchUriOf(srcId);
	if (!uri) throw new Error("图片源不可读");
	const bmp = await loadBitmap(uri);
	const { w, h } = dimOf(bmp);
	const cellW = Math.floor(w / cols);
	const cellH = Math.floor(h / rows);
	if (cellW < 8 || cellH < 8) throw new Error("宫格过密：单格尺寸过小");

	const ordered = [...cells].sort((a, b) => (a.r === b.r ? a.c - b.c : a.r - b.r));
	const ids: string[] = [];
	let firstW = cellW;
	let firstH = cellH;
	for (const { r, c } of ordered) {
		let canvas = document.createElement("canvas");
		canvas.width = cellW;
		canvas.height = cellH;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("无法创建绘图上下文");
		ctx.drawImage(bmp, c * cellW, r * cellH, cellW, cellH, 0, 0, cellW, cellH);
		if (trimBorder) {
			try {
				const rect = detectTrimRect(ctx.getImageData(0, 0, cellW, cellH));
				if (rect.w < cellW || rect.h < cellH) {
					const c2 = document.createElement("canvas");
					c2.width = rect.w;
					c2.height = rect.h;
					c2.getContext("2d")!.drawImage(canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
					canvas = c2;
				}
			} catch {
				/* 跨域污染读不了像素 → 按原样切（不因去边失败拖垮整个切分） */
			}
		}
		if (ids.length === 0) {
			firstW = canvas.width;
			firstH = canvas.height;
		}
		const blob = await canvasToBlob(canvas);
		const file = new File([blob], `${base}-${r + 1}-${c + 1}.png`, { type: "image/png" });
		const up = await uploadMediaToCanvasAsset(file, "TP");
		useLibraryStore.getState().addAsset({
			id: up.assetId,
			kind: "image",
			name: file.name,
			uri: up.displayUri,
			serverAssetId: up.assetId,
			thumbnailUri: null,
			createdAt: new Date().toISOString(),
			deletedByUser: false,
			localPath: up.localPath,
		});
		ids.push(up.assetId);
	}
	if ("close" in bmp) bmp.close();

	const outCols = Math.min(cols, ids.length);
	const outRows = Math.ceil(ids.length / outCols);
	const group = buildShotGroupNode({
		assets: ids,
		x: node.x + (node.w || 240) + 64,
		y: node.y,
		rows: outRows,
		cols: outCols,
		// 宫格比例=首格真实产物比例（去白边后各格尺寸可能略有差异，以首格为代表）
		ratio: ratioStringFrom(firstW, firstH),
		title: `${base}-宫格切分`,
	});
	dispatchCommand({ type: "createShotGroup", node: group });
}
