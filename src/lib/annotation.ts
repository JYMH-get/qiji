/**
 * annotation —— 图片标注的纯数据模型（无 DOM/Konva 依赖，可单测）。
 *
 * 坐标一律用**原图像素空间**（imgW×imgH）：编辑器按显示缩放换算、导出按原尺寸重绘，
 * 同一份矢量在任何分辨率下重进编辑/重导出都不漂移。
 * 矢量 JSON 存进节点 data（随项目落盘）；**绝不存 base64/uri**——合成图走资产 id（§7.1 教训）。
 *
 * 橡皮 = **依附在元素上的蒙版**（masks）：擦除的对象是笔画不是画布位置——蒙版以元素锚点的
 * 相对坐标存储，渲染时对该元素做 destination-out 挖透明（透出的自然是元素当前位置下的原图，
 * 颜色随位置变化）；**元素被移动时擦除效果跟着走**。dashedLine=true 为虚线橡皮（挖孔**沿笔刷
 * 路径方向**间隔分段，段间笔画保留=虚线观感）。落在空白处（没碰到任何元素）的橡皮不产生数据。
 */

import { applyH, baseQuadOf, homographyFromQuads, invertH, quadBBox, quadScaleOf } from "@/lib/annotationXform";
import { sanitizeStageScene } from "@/lib/stageScene";

export type AnnoKind = "pen" | "arrow" | "rect" | "ellipse" | "stamp" | "text" | "model3d";

/**
 * 擦除蒙版（依附于元素）：points=笔刷路径（**相对元素锚点** elementAnchor 的坐标）、
 * width=笔刷直径（原图像素）、dashedLine=沿路径方向间隔挖孔（虚线橡皮）、
 * dashScale=虚线密度倍率（涂抹时滚轮调节；<1 更密 >1 更疏，缺省 1）。
 * 渲染=元素与蒙版打包成隔离组（cache）后 destination-out 挖孔。
 */
export interface AnnoMask {
	points: number[];
	width: number;
	dashedLine?: boolean;
	dashScale?: number;
}

/** 虚线密度倍率的取值范围（滚轮调节与载入清洗共用） */
export const DASH_SCALE_MIN = 0.25;
export const DASH_SCALE_MAX = 4;

/**
 * 选中框变形（旋转/翻转/透视的统一表示）：quad=元素几何外接矩形四角（TL,TR,BR,BL）
 * 变形后的位置（原图像素坐标）。渲染凭 基准矩形→quad 的单应矩阵网格重采样
 * （纯数学在 [annotationXform.ts](./annotationXform.ts)）；quad 回到原位即摘除本字段。
 */
export interface AnnoXform {
	quad: number[];
}

export interface AnnoPen {
	id: string;
	kind: "pen";
	/** 扁平点列 [x1,y1,x2,y2,...]（原图像素） */
	points: number[];
	color: string;
	width: number;
	/** 描边虚线化（保留字段：渲染支持，当前无工具写入） */
	dashed?: boolean;
	masks?: AnnoMask[];
	xform?: AnnoXform;
}

export interface AnnoArrow {
	id: string;
	kind: "arrow";
	/** [x1,y1,x2,y2] 起点→终点 */
	points: [number, number, number, number];
	color: string;
	width: number;
	dashed?: boolean;
	masks?: AnnoMask[];
	xform?: AnnoXform;
}

export interface AnnoShapeRect {
	id: string;
	kind: "rect" | "ellipse";
	x: number;
	y: number;
	w: number;
	h: number;
	color: string;
	width: number;
	/** 有填充（实心）/ 无填充（描边） */
	fill: boolean;
	dashed?: boolean;
	masks?: AnnoMask[];
	xform?: AnnoXform;
}

/**
 * 纹章（图章）：外接矩形定位。builtin=内置矢量章 id（人形/星形/爱心，路径见 stampShapes），
 * 用 color/width/fill 上色；stampId=本机章库的自定义 PNG 章（⚠ doc 只存引用 id 绝不存 base64，
 * 图像字节在本机章库 localStorage——导出时已烙进合成图，跨设备再编辑缺章仅显示占位框）。
 */
export interface AnnoStamp {
	id: string;
	kind: "stamp";
	x: number;
	y: number;
	w: number;
	h: number;
	color: string;
	width: number;
	fill: boolean;
	builtin?: string;
	stampId?: string;
	dashed?: boolean;
	masks?: AnnoMask[];
	xform?: AnnoXform;
}

export interface AnnoText {
	id: string;
	kind: "text";
	x: number;
	y: number;
	text: string;
	color: string;
	fontSize: number;
	masks?: AnnoMask[];
	xform?: AnnoXform;
}

/**
 * 3D 模型层（第196轮任务⑤）：在涂鸦里嵌入的 3D 模型摆放结果。doc 只存
 * **场景 JSON + 相机参数**（零位图零 base64——位图由渲染层凭场景离屏重渲，
 * 见 model3dRender）；外接矩形=模型层在画面中的落位（初始=整幅画面，可用
 * 选中框移动/变形）。再编辑=凭 scene 重开 3D 导演台。
 */
export interface AnnoModel3d {
	id: string;
	kind: "model3d";
	x: number;
	y: number;
	w: number;
	h: number;
	scene: import("@/lib/stageScene").StageSceneDoc;
	camera: { theta: number; phi: number; dist: number; target: [number, number, number] };
	masks?: AnnoMask[];
	xform?: AnnoXform;
}

export type AnnoElement = AnnoPen | AnnoArrow | AnnoShapeRect | AnnoStamp | AnnoText | AnnoModel3d;

export interface AnnotationDoc {
	v: 1;
	/** 原图自然尺寸（坐标基准） */
	imgW: number;
	imgH: number;
	elements: AnnoElement[];
}

/** 单份文档的防呆上限（防脏数据把项目文件/渲染拖垮） */
export const MAX_ELEMENTS = 500;
export const MAX_PEN_POINTS = 4000;
const MAX_TEXT_LEN = 500;

let seq = 0;
/** 标注元素 id：会话内唯一即可（元素随 doc 整体存取，无全局引用） */
export function newAnnoId(): string {
	seq += 1;
	return `an-${Date.now().toString(36)}-${seq}`;
}

const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** 拖拽两角 → 归一化矩形（负向拖拽翻正） */
export function normalizedRect(x1: number, y1: number, x2: number, y2: number): { x: number; y: number; w: number; h: number } {
	return {
		x: Math.min(x1, x2),
		y: Math.min(y1, y2),
		w: Math.abs(x2 - x1),
		h: Math.abs(y2 - y1),
	};
}

/** 点到线段的垂距（RDP 用） */
function perpDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax;
	const dy = by - ay;
	const len2 = dx * dx + dy * dy;
	if (len2 === 0) return Math.hypot(px - ax, py - ay);
	let t = ((px - ax) * dx + (py - ay) * dy) / len2;
	t = Math.max(0, Math.min(1, t));
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Ramer–Douglas–Peucker 简化（扁平点列）：「鼠标停顿转曲线」的核心——
 * 抖动的密集轨迹删掉冗余点后，渲染层配 tension 贝塞尔插值即得到平滑曲线；
 * 同时显著缩小落盘体积。tolerance=允许的最大偏差（原图像素）。
 */
export function simplifyPoints(points: number[], tolerance: number): number[] {
	const n = points.length / 2;
	if (n <= 2 || tolerance <= 0) return points.slice();
	const keep = new Array<boolean>(n).fill(false);
	keep[0] = keep[n - 1] = true;
	const stack: [number, number][] = [[0, n - 1]];
	while (stack.length) {
		const [a, b] = stack.pop()!;
		let maxD = -1;
		let maxI = -1;
		for (let i = a + 1; i < b; i++) {
			const d = perpDist(points[i * 2], points[i * 2 + 1], points[a * 2], points[a * 2 + 1], points[b * 2], points[b * 2 + 1]);
			if (d > maxD) { maxD = d; maxI = i; }
		}
		if (maxD > tolerance && maxI > 0) {
			keep[maxI] = true;
			stack.push([a, maxI], [maxI, b]);
		}
	}
	const out: number[] = [];
	for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i * 2], points[i * 2 + 1]);
	return out;
}

/**
 * 整体平移一个元素（选择工具拖动落定时用）。
 * masks 是相对锚点的坐标——锚点随元素移动，蒙版**不需要**任何改写即自动跟随（核心语义）。
 * xform.quad 与基准几何**同步平移**（基准↔quad 的相对变形不变，显示位置随动）。
 */
export function translateElement<T extends AnnoElement>(el: T, dx: number, dy: number): T {
	const xf = el.xform
		? { xform: { quad: el.xform.quad.map((v, i) => (i % 2 === 0 ? v + dx : v + dy)) } }
		: {};
	if (el.kind === "pen") {
		const pts = el.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy));
		return { ...el, points: pts, ...xf };
	}
	if (el.kind === "arrow") {
		const [x1, y1, x2, y2] = el.points;
		return { ...el, points: [x1 + dx, y1 + dy, x2 + dx, y2 + dy], ...xf };
	}
	return { ...el, x: el.x + dx, y: el.y + dy, ...xf };
}

/** 元素锚点（蒙版相对坐标的基准；平移时锚点随动=蒙版随动） */
export function elementAnchor(el: AnnoElement): { x: number; y: number } {
	if (el.kind === "pen" || el.kind === "arrow") return { x: el.points[0], y: el.points[1] };
	return { x: el.x, y: el.y };
}

/** 元素外接盒（含描边半宽；文字按估算包围盒）——橡皮分发蒙版时的粗筛 */
export function elementBBox(el: AnnoElement): { x1: number; y1: number; x2: number; y2: number } {
	if (el.kind === "pen" || el.kind === "arrow") {
		let x1 = Infinity;
		let y1 = Infinity;
		let x2 = -Infinity;
		let y2 = -Infinity;
		for (let i = 0; i + 1 < el.points.length; i += 2) {
			x1 = Math.min(x1, el.points[i]);
			x2 = Math.max(x2, el.points[i]);
			y1 = Math.min(y1, el.points[i + 1]);
			y2 = Math.max(y2, el.points[i + 1]);
		}
		const half = el.width / 2;
		return { x1: x1 - half, y1: y1 - half, x2: x2 + half, y2: y2 + half };
	}
	if (el.kind === "text") {
		const lines = el.text.split("\n");
		const w = Math.max(...lines.map((l) => l.length)) * el.fontSize * 0.6;
		const h = lines.length * el.fontSize * 1.2;
		return { x1: el.x, y1: el.y, x2: el.x + w, y2: el.y + h };
	}
	const half = "width" in el ? el.width / 2 : 0;
	return { x1: el.x - half, y1: el.y - half, x2: el.x + el.w + half, y2: el.y + el.h + half };
}

/** 单元素蒙版数量上限（防同一元素被反复涂抹撑爆项目文件） */
export const MAX_MASKS_PER_ELEMENT = 40;

/** 折线上距 (x,y) 最近的点（closed=末段回接首点）；返回 null=无有效段 */
function nearestOnSegments(pts: number[], closed: boolean, x: number, y: number): { x: number; y: number; d: number } | null {
	const src = closed && pts.length >= 4 ? [...pts, pts[0], pts[1]] : pts;
	let best: { x: number; y: number; d: number } | null = null;
	for (let i = 0; i + 3 < src.length; i += 2) {
		const ax = src[i];
		const ay = src[i + 1];
		const bx = src[i + 2];
		const by = src[i + 3];
		const dx = bx - ax;
		const dy = by - ay;
		const len2 = dx * dx + dy * dy;
		let t = len2 === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / len2;
		t = Math.max(0, Math.min(1, t));
		const qx = ax + t * dx;
		const qy = ay + t * dy;
		const d = Math.hypot(x - qx, y - qy);
		if (!best || d < best.d) best = { x: qx, y: qy, d };
	}
	return best;
}

/**
 * 橡皮吸附：找 (x,y) 半径 radius 内最近的**线条类**描边点（笔/箭头/矩形边框/椭圆轮廓；
 * 纹章/文字无线可循不参与）。preferId=上一次吸中的元素（1.4× 半径的粘滞判定，
 * 沿一条线擦时不被旁边的线抢走）。返回吸附点与元素 id；无命中返回 null（用原始点）。
 */
export function snapToStroke(
	els: AnnoElement[],
	x: number,
	y: number,
	radius: number,
	preferId?: string | null,
): { x: number; y: number; elId: string } | null {
	let best: { x: number; y: number; d: number; elId: string } | null = null;
	let preferred: { x: number; y: number; d: number; elId: string } | null = null;
	for (const el of els) {
		if (el.xform) continue; // 变形元素的基准几何≠显示位置，不参与吸附（已知边界）
		let c: { x: number; y: number; d: number } | null = null;
		if (el.kind === "pen") c = nearestOnSegments(el.points, false, x, y);
		else if (el.kind === "arrow") c = nearestOnSegments([...el.points], false, x, y);
		else if (el.kind === "rect") c = nearestOnSegments([el.x, el.y, el.x + el.w, el.y, el.x + el.w, el.y + el.h, el.x, el.y + el.h], true, x, y);
		else if (el.kind === "ellipse") {
			const rx = el.w / 2;
			const ry = el.h / 2;
			if (rx > 0 && ry > 0) {
				const cx = el.x + rx;
				const cy = el.y + ry;
				// 参数角近似投影（对橡皮吸附精度足够）
				const a = Math.atan2((y - cy) / ry, (x - cx) / rx);
				const qx = cx + rx * Math.cos(a);
				const qy = cy + ry * Math.sin(a);
				c = { x: qx, y: qy, d: Math.hypot(x - qx, y - qy) };
			}
		}
		if (!c) continue;
		if (el.id === preferId && c.d <= radius * 1.4) {
			if (!preferred || c.d < preferred.d) preferred = { ...c, elId: el.id };
		}
		if (c.d <= radius && (!best || c.d < best.d)) best = { ...c, elId: el.id };
	}
	const hit = preferred ?? best;
	return hit ? { x: hit.x, y: hit.y, elId: hit.elId } : null;
}

/**
 * 把一笔橡皮/虚线橡皮分发到元素上：笔刷外接盒与元素外接盒相交的元素各得一份蒙版
 * （坐标转为该元素锚点的相对值——之后元素移动，蒙版自动跟随）。
 * 蒙版落在元素外的部分渲染时天然无效果，粗筛用外接盒足够（不需精确命中）。
 * 返回 null=没碰到任何元素（调用方不落撤销快照；空白处擦除无意义）。
 */
export function applyEraseStroke(
	els: AnnoElement[],
	brush: number[],
	width: number,
	dashedLine: boolean,
	dashScale?: number,
): AnnoElement[] | null {
	let bx1 = Infinity;
	let by1 = Infinity;
	let bx2 = -Infinity;
	let by2 = -Infinity;
	for (let i = 0; i + 1 < brush.length; i += 2) {
		bx1 = Math.min(bx1, brush[i]);
		bx2 = Math.max(bx2, brush[i]);
		by1 = Math.min(by1, brush[i + 1]);
		by2 = Math.max(by2, brush[i + 1]);
	}
	const half = width / 2;
	bx1 -= half; by1 -= half; bx2 += half; by2 += half;

	let changed = false;
	const out = els.map((el) => {
		// 变形元素：外接盒按显示位置（quad）判交，笔刷点经**逆单应**换回基准空间再存
		// （蒙版永远存基准空间的锚点相对坐标——渲染时随整组一起变形，位置自然对上）
		const b = el.xform ? { ...quadBBox(el.xform.quad) } : elementBBox(el);
		if (b.x2 < bx1 || b.x1 > bx2 || b.y2 < by1 || b.y1 > by2) return el;
		if ((el.masks?.length ?? 0) >= MAX_MASKS_PER_ELEMENT) return el;
		const a = elementAnchor(el);
		let pts = brush;
		let maskWidth = width;
		if (el.xform) {
			const h = homographyFromQuads(baseQuadOf(el), el.xform.quad);
			const hi = h ? invertH(h) : null;
			if (!hi) return el; // 退化变形不分发（渲染同样回退基准，不会错位）
			pts = [];
			for (let i = 0; i + 1 < brush.length; i += 2) {
				const p = applyH(hi, brush[i], brush[i + 1]);
				pts.push(p.x, p.y);
			}
			maskWidth = sane(width / quadScaleOf(el), 1, 500);
		}
		const rel = pts.map((v, i) => (i % 2 === 0 ? v - a.x : v - a.y));
		// dashScale 只在虚线橡皮且 ≠1 时落盘（省 JSON 体积；渲染缺省即 1）
		const ds = dashedLine && isFiniteNum(dashScale) && dashScale !== 1
			? { dashScale: sane(dashScale, DASH_SCALE_MIN, DASH_SCALE_MAX) }
			: {};
		const mask: AnnoMask = { points: rel, width: maskWidth, ...(dashedLine ? { dashedLine: true as const } : {}), ...ds };
		changed = true;
		return { ...el, masks: [...(el.masks ?? []), mask] };
	});
	return changed ? out : null;
}

const sane = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** 蒙版清洗：坏蒙版丢弃、好蒙版保留（数量/点数收敛） */
function sanitizeMasks(raw: unknown): { masks: AnnoMask[] } | Record<string, never> {
	if (!Array.isArray(raw)) return {};
	const masks: AnnoMask[] = [];
	for (const m of raw) {
		if (masks.length >= MAX_MASKS_PER_ELEMENT) break;
		if (!m || typeof m !== "object") continue;
		const mm = m as Record<string, unknown>;
		if (!Array.isArray(mm.points) || mm.points.length < 4 || mm.points.length % 2 !== 0) continue;
		if (!mm.points.every(isFiniteNum)) continue;
		if (!isFiniteNum(mm.width)) continue;
		masks.push({
			points: (mm.points as number[]).slice(0, MAX_PEN_POINTS * 2),
			width: sane(mm.width, 1, 500),
			...(mm.dashedLine === true ? { dashedLine: true as const } : {}),
			...(mm.dashedLine === true && isFiniteNum(mm.dashScale)
				? { dashScale: sane(mm.dashScale, DASH_SCALE_MIN, DASH_SCALE_MAX) }
				: {}),
		});
	}
	return masks.length ? { masks } : {};
}

/** 变形清洗：quad 必须 8 个有限数，坏的整体丢弃（元素回到未变形渲染，数据仍在可再改） */
function sanitizeXform(raw: unknown): { xform: AnnoXform } | Record<string, never> {
	if (!raw || typeof raw !== "object") return {};
	const q = (raw as Record<string, unknown>).quad;
	if (!Array.isArray(q) || q.length !== 8 || !q.every(isFiniteNum)) return {};
	return { xform: { quad: (q as number[]).map((v) => sane(v, -1e6, 1e6)) } };
}

/** 单元素载入清洗：形状/数值不合法返回 null（宁可丢弃不渲染脏数据） */
function sanitizeElement(raw: unknown): AnnoElement | null {
	if (!raw || typeof raw !== "object") return null;
	const e = raw as Record<string, unknown>;
	const id = typeof e.id === "string" && e.id ? e.id.slice(0, 64) : newAnnoId();
	const color = typeof e.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(e.color) ? e.color : "#ff3b30";
	const width = isFiniteNum(e.width) ? sane(e.width, 1, 200) : 4;
	const dashed = e.dashed === true ? { dashed: true as const } : {};
	const masks = sanitizeMasks(e.masks);
	const xf = sanitizeXform(e.xform);
	switch (e.kind) {
		case "pen": {
			if (!Array.isArray(e.points) || e.points.length < 4 || e.points.length % 2 !== 0) return null;
			if (!e.points.every(isFiniteNum)) return null;
			const points = (e.points as number[]).slice(0, MAX_PEN_POINTS * 2);
			return { id, kind: "pen", points, color, width, ...dashed, ...masks, ...xf };
		}
		case "arrow": {
			if (!Array.isArray(e.points) || e.points.length !== 4 || !e.points.every(isFiniteNum)) return null;
			return { id, kind: "arrow", points: e.points as [number, number, number, number], color, width, ...dashed, ...masks, ...xf };
		}
		case "rect":
		case "ellipse": {
			if (!isFiniteNum(e.x) || !isFiniteNum(e.y) || !isFiniteNum(e.w) || !isFiniteNum(e.h)) return null;
			if (e.w <= 0 || e.h <= 0) return null;
			return { id, kind: e.kind, x: e.x, y: e.y, w: e.w, h: e.h, color, width, fill: e.fill === true, ...dashed, ...masks, ...xf };
		}
		case "stamp": {
			if (!isFiniteNum(e.x) || !isFiniteNum(e.y) || !isFiniteNum(e.w) || !isFiniteNum(e.h)) return null;
			if (e.w <= 0 || e.h <= 0) return null;
			const builtin = typeof e.builtin === "string" && e.builtin ? e.builtin.slice(0, 32) : undefined;
			const stampId = typeof e.stampId === "string" && e.stampId ? e.stampId.slice(0, 64) : undefined;
			if (!builtin && !stampId) return null; // 无章源的章没有意义
			return { id, kind: "stamp", x: e.x, y: e.y, w: e.w, h: e.h, color, width, fill: e.fill === true, builtin, stampId, ...dashed, ...masks, ...xf };
		}
		case "model3d": {
			if (!isFiniteNum(e.x) || !isFiniteNum(e.y) || !isFiniteNum(e.w) || !isFiniteNum(e.h)) return null;
			if (e.w <= 0 || e.h <= 0) return null;
			const cam = e.camera as Record<string, unknown> | undefined;
			const camera = {
				theta: isFiniteNum(cam?.theta) ? (cam!.theta as number) : 0,
				phi: isFiniteNum(cam?.phi) ? sane(cam!.phi as number, 0.15, Math.PI - 0.15) : 1.15,
				dist: isFiniteNum(cam?.dist) ? sane(cam!.dist as number, 0.6, 40) : 4.2,
				target: (Array.isArray(cam?.target) && (cam!.target as unknown[]).length === 3 && (cam!.target as unknown[]).every(isFiniteNum)
					? [...(cam!.target as number[])]
					: [0, 0.9, 0]) as [number, number, number],
			};
			const scene = sanitizeStageScene(e.scene);
			if (!scene.models.length) return null; // 空场景的模型层没有意义
			return { id, kind: "model3d", x: e.x, y: e.y, w: e.w, h: e.h, scene, camera, ...masks, ...xf };
		}
		case "text": {
			if (!isFiniteNum(e.x) || !isFiniteNum(e.y) || typeof e.text !== "string") return null;
			const text = e.text.slice(0, MAX_TEXT_LEN).trim();
			if (!text) return null;
			const fontSize = isFiniteNum(e.fontSize) ? sane(e.fontSize, 8, 400) : 24;
			return { id, kind: "text", x: e.x, y: e.y, text, color, fontSize, ...masks, ...xf };
		}
		default:
			return null;
	}
}

/**
 * 文档载入清洗：项目文件里的 annotation.doc 经手工编辑/版本演进后可能形状不对，
 * 逐元素白名单校验，坏的丢弃、好的保留；整体不合法返回 null（调用方按「无标注」处理）。
 */
export function sanitizeAnnotationDoc(raw: unknown): AnnotationDoc | null {
	if (!raw || typeof raw !== "object") return null;
	const d = raw as Record<string, unknown>;
	if (!isFiniteNum(d.imgW) || !isFiniteNum(d.imgH) || d.imgW <= 0 || d.imgH <= 0) return null;
	const list = Array.isArray(d.elements) ? d.elements : [];
	const elements: AnnoElement[] = [];
	for (const item of list) {
		if (elements.length >= MAX_ELEMENTS) break;
		const el = sanitizeElement(item);
		if (el) elements.push(el);
	}
	return { v: 1, imgW: d.imgW, imgH: d.imgH, elements };
}
