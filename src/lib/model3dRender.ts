/**
 * model3dRender —— 涂鸦「3D 模型层」元素的离屏重渲（doc 只存场景 JSON，位图现渲现用）。
 *
 * ⚠ 内部动态 import modelStage（three）——本模块可被 AnnotationEditor（已 lazy）静态引用，
 * 但 three 只在真的有 model3d 元素需要渲染时才加载。渲染完立即 destroy 释放 WebGL context
 * （WebView2 上限）；结果按「场景+相机+尺寸」签名缓存，同一元素反复重渲零成本。
 */
import type { AnnoModel3d } from "./annotation";

const cache = new Map<string, ImageBitmap>();
const CACHE_MAX = 24;

function sigOf(el: AnnoModel3d, w: number, h: number): string {
	return `${w}x${h}|${JSON.stringify(el.camera)}|${JSON.stringify(el.scene)}`;
}

/** 渲染分辨率：元素外接矩形尺寸，最长边收敛到 2048 */
export function renderSizeOf(el: AnnoModel3d): { w: number; h: number } {
	const cap = 2048 / Math.max(el.w, el.h);
	const k = Math.min(1, cap);
	return { w: Math.max(2, Math.round(el.w * k)), h: Math.max(2, Math.round(el.h * k)) };
}

/**
 * 渲染模型层透明位图（失败返回 null——渲染层显示虚线占位框，不阻塞其它元素）。
 * glbBytes：GLB 字节解析器（元素里引用了 glb 资产时必传，取不到的模型跳过）。
 */
export async function renderModel3dBitmap(
	el: AnnoModel3d,
	glbBytes?: (assetId: string) => Promise<ArrayBuffer | null>,
): Promise<ImageBitmap | null> {
	const { w, h } = renderSizeOf(el);
	const sig = sigOf(el, w, h);
	const hit = cache.get(sig);
	if (hit) return hit;
	try {
		const { ModelStage } = await import("./modelStage");
		const canvas = document.createElement("canvas");
		canvas.width = w;
		canvas.height = h;
		const stage = new ModelStage(canvas, { mode: "stage" });
		try {
			await stage.setSceneDoc(el.scene, glbBytes);
			stage.setCameraState(el.camera);
			stage.setSize(w, h);
			const blob = await stage.captureComposite(w, h, true);
			const bmp = await createImageBitmap(blob);
			if (cache.size >= CACHE_MAX) {
				const first = cache.keys().next().value;
				if (first) { cache.get(first)?.close(); cache.delete(first); }
			}
			cache.set(sig, bmp);
			return bmp;
		} finally {
			stage.destroy();
		}
	} catch {
		return null;
	}
}
