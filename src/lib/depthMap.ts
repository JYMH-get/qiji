/**
 * depthMap —— 深度推理输出 → 黑白深度图像素的纯函数（无 DOM 依赖，可单测）。
 *
 * Depth Anything 输出**逆深度**（数值大=离相机近）：min-max 归一化后直接映射灰度，
 * 即得「近白远黑」的 ControlNet 深度图惯例。画布/上游模型垫图都按这个语义消费。
 */

/**
 * 深度值序列 → 0..255 灰度（min-max 拉伸；近=值大=白）。
 * 平坦输入（max≈min，如纯色图）返回全 128 中灰——避免除零放大噪声。
 */
export function normalizeDepthToGray(data: ArrayLike<number>): Uint8ClampedArray<ArrayBuffer> {
	const n = data.length;
	const out = new Uint8ClampedArray(n);
	let min = Infinity;
	let max = -Infinity;
	for (let i = 0; i < n; i++) {
		const v = data[i];
		if (v < min) min = v;
		if (v > max) max = v;
	}
	const range = max - min;
	if (!Number.isFinite(range) || range < 1e-6) {
		out.fill(128);
		return out;
	}
	const k = 255 / range;
	for (let i = 0; i < n; i++) out[i] = (data[i] - min) * k;
	return out;
}

/** 单通道灰度 → RGBA（putImageData 用；alpha 全 255） */
export function grayToRgba(gray: ArrayLike<number>): Uint8ClampedArray<ArrayBuffer> {
	const n = gray.length;
	const out = new Uint8ClampedArray(n * 4);
	for (let i = 0; i < n; i++) {
		const v = gray[i];
		const o = i * 4;
		out[o] = v;
		out[o + 1] = v;
		out[o + 2] = v;
		out[o + 3] = 255;
	}
	return out;
}
