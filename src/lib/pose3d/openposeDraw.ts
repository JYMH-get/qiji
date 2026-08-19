/**
 * openposeDraw —— OpenPose(COCO-18) 姿势图绘制（纯函数；ctx 走最小接口可单测）。
 *
 * 颜色与连线顺序照抄 OpenPose 官方渲染约定（ControlNet 姿势条件图的事实标准），
 * 黑底 + 彩色肢体线 + 关节圆点。画面外/被判不可见的键点传 null 即跳过。
 */

/** 肢体连线（键点索引对，OpenPose limbSeq 顺序） */
export const OPENPOSE_LIMBS: [number, number][] = [
	[1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7],
	[1, 8], [8, 9], [9, 10], [1, 11], [11, 12], [12, 13],
	[1, 0], [0, 14], [14, 16], [0, 15], [15, 17],
];

/** 肢体线颜色（与 OPENPOSE_LIMBS 一一对应） */
export const OPENPOSE_LIMB_COLORS: [number, number, number][] = [
	[255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0],
	[0, 255, 0], [0, 255, 85], [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255],
	[0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 170], [255, 0, 85],
];

/** 关节点颜色（18 个，OpenPose 官方点色） */
export const OPENPOSE_POINT_COLORS: [number, number, number][] = [
	[255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0],
	[0, 255, 0], [0, 255, 85], [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255],
	[0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 170], [255, 0, 85], [255, 0, 0],
];

/** 单测可替身的最小 2D 上下文 */
export interface MiniCtx {
	beginPath(): void;
	ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number): void;
	arc(x: number, y: number, r: number, a0: number, a1: number): void;
	fill(): void;
	fillStyle: string | CanvasGradient | CanvasPattern;
	globalAlpha: number;
}

export type Point2 = [number, number] | null;

/**
 * 把一个人物的 18 键点画上去（黑底由调用方铺）。
 * lineWidth 建议 = 画布短边 × 0.008 左右；OpenPose 线是「胶囊椭圆」不是 stroke。
 */
export function drawOpenPoseFigure(ctx: MiniCtx, points: Point2[], lineWidth: number): void {
	const lw = Math.max(1, lineWidth);
	// 肢体（椭圆胶囊，官方观感）
	for (let i = 0; i < OPENPOSE_LIMBS.length; i++) {
		const [a, b] = OPENPOSE_LIMBS[i];
		const pa = points[a];
		const pb = points[b];
		if (!pa || !pb) continue;
		const mx = (pa[0] + pb[0]) / 2;
		const my = (pa[1] + pb[1]) / 2;
		const len = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
		if (len < 1e-3) continue;
		const ang = Math.atan2(pb[1] - pa[1], pb[0] - pa[0]);
		const [r, g, bl] = OPENPOSE_LIMB_COLORS[i];
		ctx.globalAlpha = 0.6;
		ctx.fillStyle = `rgb(${r},${g},${bl})`;
		ctx.beginPath();
		ctx.ellipse(mx, my, len / 2, lw, ang, 0, Math.PI * 2);
		ctx.fill();
	}
	// 关节点
	ctx.globalAlpha = 1;
	for (let i = 0; i < points.length; i++) {
		const p = points[i];
		if (!p) continue;
		const [r, g, bl] = OPENPOSE_POINT_COLORS[i] ?? [255, 255, 255];
		ctx.fillStyle = `rgb(${r},${g},${bl})`;
		ctx.beginPath();
		ctx.arc(p[0], p[1], lw * 1.6, 0, Math.PI * 2);
		ctx.fill();
	}
}
