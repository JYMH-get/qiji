/**
 * annotationXform —— 涂鸦元素「选中框变形」的纯数学（无 DOM/Konva 依赖，可单测）。
 *
 * 统一变形表示：**quad（四角）**——元素几何外接矩形的四个角（TL,TR,BR,BL 顺序，原图像素坐标）
 * 变形后落在哪。移动=平移四角、旋转=绕质心转四角、翻转=绕质心镜像、透视=单独拖一角。
 * 渲染凭 base 矩形→quad 的**单应矩阵 H**（3×3 投影变换）：仿射（平移/旋转/翻转/缩放/斜切）时
 * H 底行≈[0,0,1]，透视时不然——渲染层据 isAffineH 选网格密度（仿射 1 格即精确）。
 * 只在 quad 明显偏离原位时才把 `xform:{quad}` 存进元素（withElementQuad），复位=quad 回到原位自动摘除。
 */
import type { AnnoElement, AnnoXform } from "@/lib/annotation";

/** 3×3 单应矩阵（行优先 9 元）；quad 为 [x0,y0, x1,y1, x2,y2, x3,y3]（TL,TR,BR,BL） */
export type Homography = number[];

/** 元素**几何**外接矩形（不含描边半宽——只是变形的参数化基准，与渲染裁剪无关）。
 *  退化维度（水平线高 0）撑到最小 1px，否则单应矩阵奇异。 */
export function geomBBox(el: AnnoElement): { x: number; y: number; w: number; h: number } {
	let x1: number;
	let y1: number;
	let x2: number;
	let y2: number;
	if (el.kind === "pen" || el.kind === "arrow") {
		x1 = Infinity; y1 = Infinity; x2 = -Infinity; y2 = -Infinity;
		for (let i = 0; i + 1 < el.points.length; i += 2) {
			x1 = Math.min(x1, el.points[i]);
			x2 = Math.max(x2, el.points[i]);
			y1 = Math.min(y1, el.points[i + 1]);
			y2 = Math.max(y2, el.points[i + 1]);
		}
	} else if (el.kind === "text") {
		const lines = el.text.split("\n");
		const w = Math.max(...lines.map((l) => l.length)) * el.fontSize * 0.6;
		const h = lines.length * el.fontSize * 1.2;
		x1 = el.x; y1 = el.y; x2 = el.x + w; y2 = el.y + h;
	} else {
		x1 = el.x; y1 = el.y; x2 = el.x + el.w; y2 = el.y + el.h;
	}
	let w = x2 - x1;
	let h = y2 - y1;
	if (w < 1) { x1 -= (1 - w) / 2; w = 1; }
	if (h < 1) { y1 -= (1 - h) / 2; h = 1; }
	return { x: x1, y: y1, w, h };
}

/** 元素的基准四角（未变形位置） */
export function baseQuadOf(el: AnnoElement): number[] {
	const b = geomBBox(el);
	return [b.x, b.y, b.x + b.w, b.y, b.x + b.w, b.y + b.h, b.x, b.y + b.h];
}

/** 元素当前显示四角：有变形取 xform.quad，否则基准四角 */
export function quadOfElement(el: AnnoElement): number[] {
	return el.xform ? el.xform.quad.slice() : baseQuadOf(el);
}

/** 8×8 高斯消元（单应求解用）；奇异返回 null */
function solve8(A: number[][], b: number[]): number[] | null {
	const n = 8;
	const M = A.map((row, i) => [...row, b[i]]);
	for (let col = 0; col < n; col++) {
		let piv = col;
		for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
		if (Math.abs(M[piv][col]) < 1e-12) return null;
		[M[col], M[piv]] = [M[piv], M[col]];
		for (let r = 0; r < n; r++) {
			if (r === col) continue;
			const f = M[r][col] / M[col][col];
			for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
		}
	}
	return M.map((row, i) => row[n] / M[i][i]);
}

/** 四点对应 → 单应矩阵（src 四角 → dst 四角）；退化（共线/重合）返回 null */
export function homographyFromQuads(src: number[], dst: number[]): Homography | null {
	const A: number[][] = [];
	const b: number[] = [];
	for (let i = 0; i < 4; i++) {
		const x = src[i * 2];
		const y = src[i * 2 + 1];
		const u = dst[i * 2];
		const v = dst[i * 2 + 1];
		A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
		b.push(u);
		A.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
		b.push(v);
	}
	const h = solve8(A, b);
	return h ? [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1] : null;
}

/** 单应作用于一点 */
export function applyH(h: Homography, x: number, y: number): { x: number; y: number } {
	const w = h[6] * x + h[7] * y + h[8];
	return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

/** 是否纯仿射（平移/旋转/翻转/缩放/斜切——canvas 2D 原生可精确渲染，网格 1 格即可） */
export function isAffineH(h: Homography): boolean {
	return Math.abs(h[6]) < 1e-8 && Math.abs(h[7]) < 1e-8;
}

/** 3×3 求逆（伴随法，归一到 [8]=1）；奇异返回 null */
export function invertH(h: Homography): Homography | null {
	const [a, b, c, d, e, f, g, k, i] = h;
	const A = e * i - f * k;
	const B = -(d * i - f * g);
	const C = d * k - e * g;
	const det = a * A + b * B + c * C;
	if (Math.abs(det) < 1e-12) return null;
	const inv = [
		A / det, -(b * i - c * k) / det, (b * f - c * e) / det,
		B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
		C / det, -(a * k - b * g) / det, (a * e - b * d) / det,
	];
	const s = inv[8];
	return Math.abs(s) < 1e-12 ? inv : inv.map((v) => v / s);
}

/** 四角质心 */
export function quadCenter(quad: number[]): { x: number; y: number } {
	return {
		x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
		y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
	};
}

/** 四角外接盒 */
export function quadBBox(quad: number[]): { x1: number; y1: number; x2: number; y2: number } {
	return {
		x1: Math.min(quad[0], quad[2], quad[4], quad[6]),
		y1: Math.min(quad[1], quad[3], quad[5], quad[7]),
		x2: Math.max(quad[0], quad[2], quad[4], quad[6]),
		y2: Math.max(quad[1], quad[3], quad[5], quad[7]),
	};
}

/** 绕中心旋转四角（rad；center 缺省=质心） */
export function rotateQuad(quad: number[], rad: number, center?: { x: number; y: number }): number[] {
	const c = center ?? quadCenter(quad);
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	return quadMap(quad, (x, y) => ({
		x: c.x + (x - c.x) * cos - (y - c.y) * sin,
		y: c.y + (x - c.x) * sin + (y - c.y) * cos,
	}));
}

/** 绕质心翻转四角：axis="x"=水平翻转（左右镜像）、"y"=垂直翻转（上下镜像） */
export function flipQuad(quad: number[], axis: "x" | "y"): number[] {
	const c = quadCenter(quad);
	return quadMap(quad, (x, y) => (axis === "x" ? { x: 2 * c.x - x, y } : { x, y: 2 * c.y - y }));
}

/** 平移四角 */
export function translateQuad(quad: number[], dx: number, dy: number): number[] {
	return quadMap(quad, (x, y) => ({ x: x + dx, y: y + dy }));
}

function quadMap(quad: number[], f: (x: number, y: number) => { x: number; y: number }): number[] {
	const out: number[] = [];
	for (let i = 0; i < 8; i += 2) {
		const p = f(quad[i], quad[i + 1]);
		out.push(p.x, p.y);
	}
	return out;
}

/** 四边形面积（鞋带公式，绝对值） */
export function quadArea(quad: number[]): number {
	let s = 0;
	for (let i = 0; i < 4; i++) {
		const j = (i + 1) % 4;
		s += quad[i * 2] * quad[j * 2 + 1] - quad[j * 2] * quad[i * 2 + 1];
	}
	return Math.abs(s) / 2;
}

/** 变形整体缩放量（√面积比）：橡皮宽度换算/渲染分辨率选择用 */
export function quadScaleOf(el: AnnoElement): number {
	if (!el.xform) return 1;
	const a0 = quadArea(baseQuadOf(el));
	const a1 = quadArea(el.xform.quad);
	if (a0 < 1e-6 || a1 < 1e-6) return 1;
	return Math.sqrt(a1 / a0);
}

/**
 * 把 quad 写回元素：quad 基本回到原位（每角偏差 <0.5px）则**摘除 xform**（复位即还原为普通元素），
 * 否则存 `xform:{quad}`。返回新元素（不改入参）。
 */
export function withElementQuad<T extends AnnoElement>(el: T, quad: number[]): T {
	const base = baseQuadOf(el);
	const identical = quad.every((v, i) => Math.abs(v - base[i]) < 0.5);
	if (identical) {
		if (!el.xform) return el;
		const { xform: _drop, ...rest } = el;
		return rest as T;
	}
	const xform: AnnoXform = { quad: quad.map((v) => Math.round(v * 100) / 100) };
	return { ...el, xform };
}
