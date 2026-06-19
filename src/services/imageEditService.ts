/**
 * imageEditService — 图像编辑工具集（客户端 Canvas API）
 *
 * 提供三种编辑操作：
 * 1. crop  — 裁剪：接收图片 URI + 裁剪区域矩形，返回裁剪后的 Blob
 * 2. rotate — 旋转：接收图片 URI + 角度，返回旋转后的 Blob
 * 3. upscale — 超分辨率占位：接收图片 URI，调用后端 API 或客户端插值
 *
 * 所有函数返回 { blob: Blob; objectUrl: string }
 * 调用方负责管理 objectUrl 的生命周期（revokeObjectURL）
 */

export interface EditResult {
	blob: Blob;
	objectUrl: string;
	width: number;
	height: number;
}

interface CropRect {
	/** 左上角 x（像素） */
	x: number;
	/** 左上角 y（像素） */
	y: number;
	/** 裁剪宽度（像素） */
	width: number;
	/** 裁剪高度（像素） */
	height: number;
}

/**
 * 加载图片到 HTMLImageElement
 */
function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.crossOrigin = "anonymous";
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
		img.src = src;
	});
}

/**
 * 将 canvas 内容导出为 Blob
 */
function canvasToBlob(
	canvas: HTMLCanvasElement,
	type = "image/png",
	quality = 0.92,
): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (blob) resolve(blob);
				else reject(new Error("canvas.toBlob failed"));
			},
			type,
			quality,
		);
	});
}

/**
 * 裁剪图片
 */
export async function cropImage(
	src: string,
	rect: CropRect,
	outputFormat: "image/png" | "image/jpeg" | "image/webp" = "image/png",
): Promise<EditResult> {
	const img = await loadImage(src);

	// 限制裁剪区域在图片范围内
	const sx = Math.max(0, Math.min(rect.x, img.naturalWidth));
	const sy = Math.max(0, Math.min(rect.y, img.naturalHeight));
	const sw = Math.min(rect.width, img.naturalWidth - sx);
	const sh = Math.min(rect.height, img.naturalHeight - sy);

	const canvas = document.createElement("canvas");
	canvas.width = sw;
	canvas.height = sh;
	const ctx = canvas.getContext("2d")!;
	ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

	const blob = await canvasToBlob(canvas, outputFormat);
	const objectUrl = URL.createObjectURL(blob);
	return { blob, objectUrl, width: sw, height: sh };
}

/**
 * 旋转图片
 */
export async function rotateImage(
	src: string,
	angleDeg: number,
	outputFormat: "image/png" | "image/jpeg" | "image/webp" = "image/png",
): Promise<EditResult> {
	const img = await loadImage(src);
	const rad = (angleDeg * Math.PI) / 180;
	const cos = Math.abs(Math.cos(rad));
	const sin = Math.abs(Math.sin(rad));

	// 旋转后画布尺寸需要容纳整个旋转图像
	const newW = Math.ceil(img.naturalWidth * cos + img.naturalHeight * sin);
	const newH = Math.ceil(img.naturalWidth * sin + img.naturalHeight * cos);

	const canvas = document.createElement("canvas");
	canvas.width = newW;
	canvas.height = newH;
	const ctx = canvas.getContext("2d")!;

	// 移到画布中心后旋转
	ctx.translate(newW / 2, newH / 2);
	ctx.rotate(rad);
	ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);

	const blob = await canvasToBlob(canvas, outputFormat);
	const objectUrl = URL.createObjectURL(blob);
	return { blob, objectUrl, width: newW, height: newH };
}

/**
 * 超分辨率（客户端双三次插值占位）
 * 实际生产环境应替换为后端超分 API 调用
 */
export async function upscaleImage(
	src: string,
	scale: 2 | 4 = 2,
	outputFormat: "image/png" | "image/jpeg" | "image/webp" = "image/png",
): Promise<EditResult> {
	const img = await loadImage(src);
	const newW = img.naturalWidth * scale;
	const newH = img.naturalHeight * scale;

	const canvas = document.createElement("canvas");
	canvas.width = newW;
	canvas.height = newH;
	const ctx = canvas.getContext("2d")!;

	// 使用高质量插值
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "high";
	ctx.drawImage(img, 0, 0, newW, newH);

	const blob = await canvasToBlob(canvas, outputFormat);
	const objectUrl = URL.createObjectURL(blob);
	return { blob, objectUrl, width: newW, height: newH };
}

/**
 * 释放 EditResult 的 Object URL
 */
export function releaseEditResult(result: EditResult): void {
	if (result.objectUrl) {
		URL.revokeObjectURL(result.objectUrl);
	}
}