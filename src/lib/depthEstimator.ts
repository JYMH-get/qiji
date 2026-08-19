/**
 * depthEstimator —— 图片 → 黑白深度图的本地推理（transformers.js + Depth Anything V2-Small）。
 *
 * ⚠ 体积重（onnxruntime-web wasm ~25MB + 模型 19+26MB 双档全部打进产物），**只能被动态
 * import**（depthify.ts 首次点「转深度」才加载）；纯像素换算在 [depthMap.ts](./depthMap.ts) 可单测。
 *
 * 路线（docs/画布新功能方案调研.md ②，license 已核：V2 只有 Small 是 Apache-2.0 可商用）：
 *  - ⚠ **完全嵌入客户端（第202轮用户定稿，勿回退成网关下发）**：模型文件（config/预处理配置/
 *    q4f16/q8 双档 onnx）打进安装包 `public/depth-model/`，经 localModelPath 同源加载——
 *    **零网络零服务端依赖**，断网/未登录都能转深度；allowRemoteModels=false 绝不出外网。
 *    （服务端 /v1/depth-model 网关路由保留给旧版打包客户端，本模块不再使用。）
 *  - 设备：WebGPU（q4f16，200–500ms）→ 失败自动降级 WASM（q8，1–3s）；
 *    「设置 → 生成偏好」可关闭 GPU（settingsStore.depthGpu=false 强制 WASM，兼容性兜底）。
 *  - wasm 运行时经 vite ?url 打进本地产物，不走 CDN。
 *  - 模型单例：首个调用触发加载，后续调用复用（含并发去重）；GPU 开关变化后下次调用自动重建。
 */
import { env, pipeline, RawImage, type DepthEstimationPipeline } from "@huggingface/transformers";
// ⚠ 相对路径直插 node_modules：onnxruntime-web 的 exports 表不放行 ./dist/* 深导入（build 报
// Missing specifier），文件路径 + ?url 绕开 exports 由 vite 打成本地资产。
// ⚠ 必须是 **asyncify** 变体——transformers v4 web 端就用它（Safari 才用 plain）；
// 错用 jsep 变体会「webgpuInit is not a function / no available backend found」（实测）。
import ortWasmUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url";
import ortMjsUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url";
import { grayToRgba, normalizeDepthToGray } from "@/lib/depthMap";
import { useSettingsStore } from "@/store/settingsStore";

const MODEL_ID = "onnx-community/depth-anything-v2-small";
// onnxruntime 的 wasm 运行时用本地打包产物（默认会去 jsdelivr CDN 拉，大陆不可靠）。
// ⚠ 必须转**绝对 URL**（第199轮真机实锤）：ort 对拿不准同源的 mjs 路径会「fetch 预载→blob: URL→
// 动态 import」，打包版 WebView2（SharedArrayBuffer 可用=多线程路径）必触发，而 blob: 模块导入
// 受 CSP script-src 管辖——相对路径判不出同源 = 「no available backend found …
// Failed to fetch dynamically imported module: blob:…」。绝对同源 URL 直接 import 不走 blob；
// tauri.conf.json 的 script-src 同时补了 blob: 作第二道保险（勿删任一）。
const absUrl = (u: string): string => (typeof location !== "undefined" ? new URL(u, location.href).href : u);
if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = { wasm: absUrl(ortWasmUrl), mjs: absUrl(ortMjsUrl) };

// 模型完全本地化：public/depth-model/ 随产物同源分发（dev=vite public、打包=tauri.localhost 资产），
// 取 `${localModelPath}/${MODEL_ID}/<file>`。
// ⚠ localModelPath 必须是**相对路径**（勿 absUrl）：transformers v4 的 get_file_metadata 对
// URL 形态的 localPath 会跳过本地存在性检查（`if (!isURL)` 才查），叠加 allowRemoteModels=false
// 即判 preprocessor_config.json 不存在 → 管线不装 processor →「this.processor is not a function」
// （实测踩坑）。相对路径在浏览器 fetch 里同样按当前 origin 解析，dev 与打包版都同源。
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = `${import.meta.env.BASE_URL ?? "/"}depth-model/`;

/** 进度回调：pct 0..100（下载占 0..88，推理占 88..99），stage 为用户可读的阶段文案 */
export type DepthProgress = (pct: number, stage: string) => void;

let pipePromise: Promise<DepthEstimationPipeline> | null = null;
/** 构建当前单例时的 GPU 开关值；设置变了（下次调用）就丢弃旧管线重建 */
let pipeGpuFlag: boolean | null = null;

/** 「设置 → 生成偏好」的 GPU 开关（缺省开；关=强制 WASM CPU） */
function gpuEnabled(): boolean {
	return useSettingsStore.getState().depthGpu !== false;
}

/** 模型加载（本地产物字节读入）单例；progress_callback 聚合各文件字节数为总百分比 */
function getPipe(onProgress: DepthProgress): Promise<DepthEstimationPipeline> {
	const wantGpu = gpuEnabled();
	if (pipePromise && pipeGpuFlag === wantGpu) return pipePromise;
	if (pipePromise) {
		// GPU 开关切换：丢弃旧管线（尽力释放，失败不影响新建）
		void pipePromise.then((p) => (p as { dispose?: () => Promise<void> }).dispose?.()).catch(() => {});
		pipePromise = null;
	}
	const files = new Map<string, { loaded: number; total: number }>();
	const report = () => {
		let loaded = 0;
		let total = 0;
		for (const f of files.values()) {
			loaded += f.loaded;
			total += f.total;
		}
		if (total > 0) onProgress(Math.min(88, (loaded / total) * 88), "加载模型");
	};
	const progress_callback = (p: { status: string; file?: string; loaded?: number; total?: number }) => {
		if (p.status === "progress" && p.file && typeof p.loaded === "number" && typeof p.total === "number" && p.total > 0) {
			files.set(p.file, { loaded: p.loaded, total: p.total });
			report();
		} else if (p.status === "done" && p.file) {
			const f = files.get(p.file);
			if (f) { f.loaded = f.total; report(); }
		}
	};
	const create = async (): Promise<DepthEstimationPipeline> => {
		// WebGPU（核显即可，快一个量级）优先；设置关 GPU / 不可用 / 初始化失败 → 纯 WASM CPU
		if (wantGpu && (navigator as { gpu?: unknown }).gpu) {
			try {
				return await pipeline("depth-estimation", MODEL_ID, { device: "webgpu", dtype: "q4f16", progress_callback });
			} catch {
				files.clear();
			}
		}
		return await pipeline("depth-estimation", MODEL_ID, { device: "wasm", dtype: "q8", progress_callback });
	};
	pipeGpuFlag = wantGpu;
	pipePromise = create().catch((err) => {
		pipePromise = null; // 失败不缓存：下次点击可重试
		throw err;
	});
	return pipePromise;
}

/**
 * 预热模型（视频转深度用：先带进度加载模型，再进逐帧循环——帧循环内取管线即秒回）。
 * 与 estimateDepthPng 共享同一单例（含 GPU 开关重建语义）。
 */
export async function preloadDepthModel(onProgress: DepthProgress): Promise<void> {
	await getPipe(onProgress);
}

export interface RawDepthFrame {
	data: ArrayLike<number>;
	width: number;
	height: number;
}

/** 批量推理是否可用（首次失败=模型批维为静态，之后恒走逐帧，不再反复试错） */
let batchSupported: boolean | null = null;

/** 只读探针（QA/端到端用）：null=还没试过批量、true=批量生效、false=模型批维静态已回退逐帧 */
export function depthBatchSupported(): boolean | null {
	return batchSupported;
}

function toRawImage(frame: ImageData): RawImage {
	// RGBA → RawImage（4 通道）→ rgb()：与 fromBlob 路径同形态喂给管线预处理器
	return new RawImage(new Uint8ClampedArray(frame.data), frame.width, frame.height, 4).rgb();
}

function pickDepth(one: { depth: { data: unknown; width: number; height: number } }): RawDepthFrame {
	return { data: one.depth.data as ArrayLike<number>, width: one.depth.width, height: one.depth.height };
}

/**
 * 多帧 ImageData → 原始深度数据（逆深度：值大=近；尺寸=模型处理分辨率，与入帧不同）。
 * 视频转深度按批调用（GPU 吃满改造，第206轮补充2）：**整批拼成一个 batch 张量一次推理**——
 * 逐帧单调用时 518 系 ViT-S 的算子太小喂不满 GPU（用户实测占用 ~20%），批量是把 GPU 拉满的正解。
 * 模型批维若为静态（batch>1 报错）自动回退逐帧并记忆，功能不损。
 * 归一化/灰度映射由调用方按「时间平滑/每帧独立」策略处理，这里只回吐原始数据。
 */
export async function estimateDepthRawFrames(frames: ImageData[]): Promise<RawDepthFrame[]> {
	const pipe = await getPipe(() => {});
	if (!frames.length) return [];
	const images = frames.map(toRawImage);
	if (images.length > 1 && batchSupported !== false) {
		try {
			const out = await pipe(images);
			const arr = Array.isArray(out) ? out : [out];
			if (arr.length === images.length) {
				batchSupported = true;
				return arr.map(pickDepth);
			}
			batchSupported = false; // 形状不符：按不支持处理走逐帧
		} catch {
			batchSupported = false;
		}
	}
	const results: RawDepthFrame[] = [];
	for (const image of images) {
		const out = await pipe(image);
		results.push(pickDepth(Array.isArray(out) ? out[0] : out));
	}
	return results;
}

/** 单帧便捷封装（estimateDepthRawFrames 批 1） */
export async function estimateDepthRawFrame(frame: ImageData): Promise<RawDepthFrame> {
	return (await estimateDepthRawFrames([frame]))[0];
}

/**
 * 图片字节 → 黑白深度 PNG（近白远黑，尺寸=原图）。
 * 深度输出经 depthMap 的 min-max 归一化重拉（比管线自带的除 max 更稳，纯函数已单测）；
 * 推理分辨率（518 系）与原图不一致时平滑放大回原尺寸。
 */
export async function estimateDepthPng(imageBlob: Blob, onProgress: DepthProgress): Promise<Blob> {
	const pipe = await getPipe(onProgress);
	const image = await RawImage.fromBlob(imageBlob);
	onProgress(90, "推理中");
	const out = await pipe(image);
	const one = Array.isArray(out) ? out[0] : out;
	const depth = one.depth; // RawImage 单通道
	onProgress(96, "合成图像");

	const gray = normalizeDepthToGray(depth.data);
	const rgba = grayToRgba(gray);
	const src = document.createElement("canvas");
	src.width = depth.width;
	src.height = depth.height;
	src.getContext("2d")!.putImageData(new ImageData(rgba, depth.width, depth.height), 0, 0);

	let final = src;
	if (depth.width !== image.width || depth.height !== image.height) {
		final = document.createElement("canvas");
		final.width = image.width;
		final.height = image.height;
		const ctx = final.getContext("2d")!;
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = "high";
		ctx.drawImage(src, 0, 0, image.width, image.height);
	}
	const blob = await new Promise<Blob>((resolve, reject) =>
		final.toBlob((b) => (b ? resolve(b) : reject(new Error("深度图导出失败"))), "image/png"),
	);
	onProgress(99, "完成");
	return blob;
}
