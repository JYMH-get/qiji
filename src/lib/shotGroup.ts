/**
 * shotGroup —— 分镜组节点（shot.group）的纯函数工具（布局/宫格/排序，不碰 store）。
 *
 * 语义：分镜组 = 一组图片资产 id（`node.data.shotAssets`，顺序即宫格阅读序）按固定宫格布局
 * 展示的组合节点。params：`gridCols`/`gridRows`（宫格数）、`ratio`（单格比例，决定节点整体形状）、
 * `showIndex`（序号角标）。创建入口：多选图片节点「合并为分镜组」/ 图片节点「宫格切分」。
 */
import type { CanvasNode } from "@/types";
import { genId } from "@/lib/id";

/** 宫格预设（行×列，用户锁定的五档） */
export const GRID_PRESETS: { label: string; rows: number; cols: number }[] = [
	{ label: "2×2", rows: 2, cols: 2 },
	{ label: "2×3", rows: 2, cols: 3 },
	{ label: "3×3", rows: 3, cols: 3 },
	{ label: "3×4", rows: 3, cols: 4 },
	{ label: "4×4", rows: 4, cols: 4 },
];

/** 单格比例可选值（第一项为默认） */
export const SHOT_RATIOS = ["16:9", "9:16", "4:3", "3:4", "1:1"];

export const SHOT_GRID_GAP = 6;
export const SHOT_GRID_PAD = 8;
/** 行/列上限（自定义宫格输入夹紧） */
export const GRID_MAX = 8;

/** "16:9" → 16/9；非法输入回退 16:9 */
export function parseRatio(r: unknown): number {
	if (typeof r === "string") {
		const m = r.match(/^\s*(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)\s*$/i);
		if (m) {
			const w = parseFloat(m[1]);
			const h = parseFloat(m[2]);
			if (w > 0 && h > 0) return w / h;
		}
	}
	return 16 / 9;
}

/** n 张图的默认宫格：预设里容量够用的最小档；超出 4×4 则按 4 列增行 */
export function defaultGridFor(n: number): { rows: number; cols: number } {
	for (const p of GRID_PRESETS) {
		if (p.rows * p.cols >= n) return { rows: p.rows, cols: p.cols };
	}
	return { rows: Math.max(1, Math.ceil(n / 4)), cols: 4 };
}

/** 读取分镜组节点的宫格参数（带兜底） */
export function shotGridOf(node: Pick<CanvasNode, "data">): { rows: number; cols: number; ratio: string; showIndex: boolean } {
	const p = node.data.params ?? {};
	const clamp = (v: unknown, d: number) => {
		const n = Math.round(Number(v));
		return Number.isFinite(n) && n >= 1 && n <= GRID_MAX ? n : d;
	};
	return {
		rows: clamp(p.gridRows, 2),
		cols: clamp(p.gridCols, 2),
		ratio: typeof p.ratio === "string" && p.ratio ? (p.ratio as string) : "16:9",
		showIndex: p.showIndex === true,
	};
}

/** 按宫格与比例计算节点体尺寸（单格宽 cellW，缺省 200） */
export function shotGroupSize(rows: number, cols: number, ratio: string, cellW = 200): { w: number; h: number } {
	const aspect = parseRatio(ratio);
	const cellH = cellW / aspect;
	return {
		w: Math.round(cols * cellW + (cols - 1) * SHOT_GRID_GAP + SHOT_GRID_PAD * 2),
		h: Math.round(rows * cellH + (rows - 1) * SHOT_GRID_GAP + SHOT_GRID_PAD * 2),
	};
}

/** 数组元素从 from 移到 to（拖动排序），越界/同位返回原数组 */
export function moveItem<T>(arr: T[], from: number, to: number): T[] {
	if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return arr;
	const out = [...arr];
	const [it] = out.splice(from, 1);
	out.splice(to, 0, it);
	return out;
}

/** 构建一个分镜组节点（UI 侧组装好再发 createShotGroup 命令） */
export function buildShotGroupNode(opts: {
	assets: string[];
	x: number;
	y: number;
	rows?: number;
	cols?: number;
	ratio?: string;
	title?: string;
}): CanvasNode {
	const grid = opts.rows && opts.cols ? { rows: opts.rows, cols: opts.cols } : defaultGridFor(opts.assets.length);
	const ratio = opts.ratio ?? "16:9";
	const { w, h } = shotGroupSize(grid.rows, grid.cols, ratio);
	return {
		id: genId("shot.group"),
		type: "shot.group",
		x: opts.x,
		y: opts.y,
		w,
		h,
		parentId: null,
		parentScriptId: null,
		data: {
			input: {},
			params: {
				gridRows: grid.rows,
				gridCols: grid.cols,
				ratio,
				showIndex: false,
				...(opts.title ? { assetName: opts.title } : {}),
			},
			resultAssetId: null,
			shotAssets: [...opts.assets],
		},
	};
}
