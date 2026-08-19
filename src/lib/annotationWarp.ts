/**
 * annotationWarp —— 变形元素的渲染管线（碰 DOM/Konva；纯数学在 annotationXform.ts）。
 *
 * canvas 2D 只有仿射变换，透视靠**网格纹理映射**：元素（含擦除蒙版）先离屏渲染成源画布，
 * 再按单应矩阵把源网格逐格（每格两三角、每三角一个仿射）贴到目标——
 * 仿射变形（平移/旋转/翻转）1×1 网格即数学精确；透视用细分网格逼近。
 * 编辑器（react-konva Shape sceneFunc）与导出（离屏 Konva.Shape）共用本模块，所见即所得。
 */
import Konva from "konva";
import type { AnnoElement } from "@/lib/annotation";
import { elementAnchor } from "@/lib/annotation";
import { konvaSpecFor, maskSpec, type RenderCtx } from "@/lib/annotationRender";
import { applyH, isAffineH, type Homography } from "@/lib/annotationXform";

const CTORS = {
	Line: Konva.Line, Arrow: Konva.Arrow, Rect: Konva.Rect, Ellipse: Konva.Ellipse,
	Path: Konva.Path, Image: Konva.Image, Text: Konva.Text, Circle: Konva.Circle,
} as const;

export interface ElementSource {
	canvas: HTMLCanvasElement;
	/** 源画布覆盖的基准空间矩形（原图像素坐标；已含描边/投影 padding） */
	rect: { x: number; y: number; w: number; h: number };
	pixelRatio: number;
}

/**
 * 元素（含蒙版）→ 离屏源画布。带蒙版时 Group cache 后再取（destination-out 需隔离组，
 * 与 MaskedNode/导出同构）；rect 用 getClientRect（真实绘制范围，文字/投影/箭头头部都罩住）。
 */
export function renderElementSource(el: AnnoElement, rctx: RenderCtx, pixelRatio: number): ElementSource | null {
	const holder = document.createElement("div");
	holder.style.display = "none";
	document.body.appendChild(holder);
	try {
		const stage = new Konva.Stage({ container: holder, width: 1, height: 1 });
		const layer = new Konva.Layer({ listening: false });
		stage.add(layer);
		const g = new Konva.Group({ listening: false });
		const spec = konvaSpecFor(el, rctx);
		g.add(new CTORS[spec.cls](spec.config as never));
		if (el.masks?.length) {
			const anchor = elementAnchor(el);
			for (const m of el.masks) {
				const ms = maskSpec(m, anchor);
				g.add(new CTORS[ms.cls](ms.config as never));
			}
		}
		layer.add(g);
		if (el.masks?.length) g.cache({ pixelRatio });
		const r = g.getClientRect();
		if (!(r.width > 0) || !(r.height > 0)) { stage.destroy(); return null; }
		const pad = 2;
		const rect = { x: r.x - pad, y: r.y - pad, w: r.width + pad * 2, h: r.height + pad * 2 };
		const canvas = g.toCanvas({ x: rect.x, y: rect.y, width: rect.w, height: rect.h, pixelRatio });
		stage.destroy();
		return { canvas, rect, pixelRatio };
	} finally {
		holder.remove();
	}
}

/** 单三角纹理贴图：src 三点（源画布像素坐标）→ dst 三点（目标坐标），一个仿射 + clip */
function drawTri(
	ctx: Konva.Context,
	img: HTMLCanvasElement,
	s: number[], // [x0,y0,x1,y1,x2,y2] 源像素
	d: number[], // 同构目标坐标
): void {
	const den = s[0] * (s[3] - s[5]) + s[2] * (s[5] - s[1]) + s[4] * (s[1] - s[3]);
	if (Math.abs(den) < 1e-9) return;
	const m11 = (d[0] * (s[3] - s[5]) + d[2] * (s[5] - s[1]) + d[4] * (s[1] - s[3])) / den;
	const m21 = (d[1] * (s[3] - s[5]) + d[3] * (s[5] - s[1]) + d[5] * (s[1] - s[3])) / den;
	const m12 = (d[0] * (s[4] - s[2]) + d[2] * (s[0] - s[4]) + d[4] * (s[2] - s[0])) / den;
	const m22 = (d[1] * (s[4] - s[2]) + d[3] * (s[0] - s[4]) + d[5] * (s[2] - s[0])) / den;
	const dx = (d[0] * (s[2] * s[5] - s[4] * s[3]) + d[2] * (s[4] * s[1] - s[0] * s[5]) + d[4] * (s[0] * s[3] - s[2] * s[1])) / den;
	const dy = (d[1] * (s[2] * s[5] - s[4] * s[3]) + d[3] * (s[4] * s[1] - s[0] * s[5]) + d[5] * (s[0] * s[3] - s[2] * s[1])) / den;
	// clip 三角向质心外微扩 ~0.4px 盖住接缝（相邻三角互相重叠一线）
	const gx = (d[0] + d[2] + d[4]) / 3;
	const gy = (d[1] + d[3] + d[5]) / 3;
	const e = (x: number, y: number) => {
		const len = Math.hypot(x - gx, y - gy) || 1;
		const f = (len + 0.4) / len;
		return [gx + (x - gx) * f, gy + (y - gy) * f];
	};
	const [e0x, e0y] = e(d[0], d[1]);
	const [e1x, e1y] = e(d[2], d[3]);
	const [e2x, e2y] = e(d[4], d[5]);
	ctx.save();
	ctx.beginPath();
	ctx.moveTo(e0x, e0y);
	ctx.lineTo(e1x, e1y);
	ctx.lineTo(e2x, e2y);
	ctx.closePath();
	ctx.clip();
	ctx.transform(m11, m21, m12, m22, dx, dy);
	ctx.drawImage(img, 0, 0);
	ctx.restore();
}

/** 透视网格密度（仿射 1 格即精确；透视按源尺寸取 6–14 格） */
export function warpGridFor(h: Homography, rect: { w: number; h: number }): number {
	if (isAffineH(h)) return 1;
	return Math.max(6, Math.min(14, Math.ceil(Math.max(rect.w, rect.h) / 60)));
}

/**
 * 变形绘制主体：源画布按 H（基准空间→目标空间）网格贴图。
 * 编辑器 Shape 的 sceneFunc 与导出侧共用（ctx 为 Konva.Context）。
 */
export function drawWarped(ctx: Konva.Context, src: ElementSource, h: Homography, grid: number): void {
	const { canvas, rect, pixelRatio } = src;
	for (let i = 0; i < grid; i++) {
		for (let j = 0; j < grid; j++) {
			const bx0 = rect.x + (rect.w * i) / grid;
			const bx1 = rect.x + (rect.w * (i + 1)) / grid;
			const by0 = rect.y + (rect.h * j) / grid;
			const by1 = rect.y + (rect.h * (j + 1)) / grid;
			const p00 = applyH(h, bx0, by0);
			const p10 = applyH(h, bx1, by0);
			const p11 = applyH(h, bx1, by1);
			const p01 = applyH(h, bx0, by1);
			const sx0 = (bx0 - rect.x) * pixelRatio;
			const sx1 = (bx1 - rect.x) * pixelRatio;
			const sy0 = (by0 - rect.y) * pixelRatio;
			const sy1 = (by1 - rect.y) * pixelRatio;
			drawTri(ctx, canvas, [sx0, sy0, sx1, sy0, sx1, sy1], [p00.x, p00.y, p10.x, p10.y, p11.x, p11.y]);
			drawTri(ctx, canvas, [sx0, sy0, sx1, sy1, sx0, sy1], [p00.x, p00.y, p11.x, p11.y, p01.x, p01.y]);
		}
	}
}

/** 四角多边形 hitFunc（Konva 命中检测走它，点击/拖拽变形元素用） */
export function quadHitFunc(quad: number[]): (ctx: Konva.Context, shape: Konva.Shape) => void {
	return (ctx, shape) => {
		ctx.beginPath();
		ctx.moveTo(quad[0], quad[1]);
		ctx.lineTo(quad[2], quad[3]);
		ctx.lineTo(quad[4], quad[5]);
		ctx.lineTo(quad[6], quad[7]);
		ctx.closePath();
		ctx.fillStrokeShape(shape);
	};
}
