/**
 * imageTrim —— 宫格切分「去白边」的纯函数（不碰 DOM/store；shotGroupOps 与单测共用）。
 *
 * 背景：AI 生成的宫格图自带 外边距/格间分隔缝/面板描边，均分裁剪后每格四周残留白边。
 * 算法（等价 ImageMagick -trim -fuzz）：
 *   1) 背景色 = 四角像素均值（不假设纯白——米色/浅灰边框同样适用）；
 *   2) 从四边向内逐行/列扫描：该行「与背景差异超过 fuzz 的像素占比」< contentRatio 即视为边框行继续内缩，
 *      遇到内容行即停（左右扫描只在已裁掉上下边的行区间内做，格缝角落噪点不干扰）；
 *   3) 单边内缩上限 maxTrimRatio（防内容本身接近背景色被裁穿：雪景/亮天）；
 *   4) 空白格（全图皆背景）/裁后尺寸退化 → 原样返回不裁（宁可留边不裁穿）。
 *
 * ⚠ 局限（第164轮补充2 分析定稿）：圆角面板会留四个小白角（只裁到内容外接矩形）；
 *   装饰性/多彩边框（非均匀色）不在本算法能力内——切分弹窗「去白边」开关关掉按原样切。
 */

/** ImageData 的结构子集（node 单测环境无 DOM ImageData，用结构类型兼容两者） */
export interface PixelGrid {
	data: Uint8ClampedArray;
	width: number;
	height: number;
}

export interface TrimOptions {
	/** 与背景色的通道最大差容差（0-255）：吸收 JPEG 压缩噪点/渐变边。缺省 28 */
	fuzz?: number;
	/** 单边内缩上限（占该边尺寸比例）：防止内容接近背景色时裁穿。缺省 0.2 */
	maxTrimRatio?: number;
	/** 行/列判定为「内容行」所需的差异像素占比。缺省 0.02 */
	contentRatio?: number;
}

export interface TrimRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** 裁后任一边小于该值视为退化，放弃裁剪 */
const MIN_KEEP = 8;

/** 检测去边矩形：返回内容外接矩形（含 fuzz 容差与单边上限）；不可裁/空白格返回全幅 */
export function detectTrimRect(img: PixelGrid, opts: TrimOptions = {}): TrimRect {
	const fuzz = opts.fuzz ?? 28;
	const maxTrimRatio = opts.maxTrimRatio ?? 0.2;
	const contentRatio = opts.contentRatio ?? 0.02;
	const { data, width: w, height: h } = img;
	const full: TrimRect = { x: 0, y: 0, w, h };
	if (w < MIN_KEEP || h < MIN_KEEP || data.length < w * h * 4) return full;

	// 背景色 = 四角像素均值
	const at = (x: number, y: number) => (y * w + x) * 4;
	const corners = [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)];
	const bgR = corners.reduce((s, i) => s + data[i], 0) / 4;
	const bgG = corners.reduce((s, i) => s + data[i + 1], 0) / 4;
	const bgB = corners.reduce((s, i) => s + data[i + 2], 0) / 4;
	const isContentPx = (i: number) =>
		Math.max(Math.abs(data[i] - bgR), Math.abs(data[i + 1] - bgG), Math.abs(data[i + 2] - bgB)) > fuzz;

	/** 行 y 在列区间 [x0,x1] 内是否为内容行（差异像素占比 ≥ contentRatio） */
	const rowIsContent = (y: number, x0: number, x1: number) => {
		const len = x1 - x0 + 1;
		const need = Math.max(1, Math.ceil(len * contentRatio));
		let cnt = 0;
		for (let x = x0; x <= x1; x++) {
			if (isContentPx(at(x, y)) && ++cnt >= need) return true;
		}
		return false;
	};
	const colIsContent = (x: number, y0: number, y1: number) => {
		const len = y1 - y0 + 1;
		const need = Math.max(1, Math.ceil(len * contentRatio));
		let cnt = 0;
		for (let y = y0; y <= y1; y++) {
			if (isContentPx(at(x, y)) && ++cnt >= need) return true;
		}
		return false;
	};

	const capY = Math.floor(h * maxTrimRatio);
	const capX = Math.floor(w * maxTrimRatio);

	let top = 0;
	while (top < capY && !rowIsContent(top, 0, w - 1)) top++;
	let bottom = h - 1;
	while (h - 1 - bottom < capY && !rowIsContent(bottom, 0, w - 1)) bottom--;
	// 全图皆背景（上下扫描都顶到上限也没见到内容）→ 空白格，不裁
	if (top >= capY && h - 1 - bottom >= capY && !rowIsContent(Math.floor(h / 2), 0, w - 1)) return full;

	let left = 0;
	while (left < capX && !colIsContent(left, top, bottom)) left++;
	let right = w - 1;
	while (w - 1 - right < capX && !colIsContent(right, top, bottom)) right--;

	const outW = right - left + 1;
	const outH = bottom - top + 1;
	if (outW < MIN_KEEP || outH < MIN_KEEP) return full;
	if (left === 0 && top === 0 && outW === w && outH === h) return full;
	return { x: left, y: top, w: outW, h: outH };
}
