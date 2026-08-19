/**
 * videoDepthCore —— 视频转深度的纯逻辑层（零 DOM/three/transformers 依赖，可单测）。
 *
 *  - 帧计划：按产物帧率把视频时长展开成逐帧时间戳（转深度逐帧推理，帧率=耗时的直接决定因子）。
 *  - 归一化标定：单帧 min/max 提取 + 跨帧指数平滑（防闪烁）+ 按固定标定范围映射灰度。
 *    图片转深度是「每帧独立归一化」（depthMap.normalizeDepthToGray）；视频逐帧独立会让远近
 *    标定范围逐帧跳动=可见闪烁，「时间平滑」把相邻帧的标定范围做 EMA——零额外推理成本，
 *    代价是转场镜头有约半秒的渐变适应（已知边界）。两种模式由 设置→生成偏好 切换（第206轮定稿）。
 */

/** 容器解析不出帧率时（webm/碎片化 mp4）的回退值（MediaRecorder captureStream 惯例 30） */
export const DEPTH_VIDEO_FPS_FALLBACK = 30;

/** 帧数安全上限（防超长视频把推理循环挂死几小时；超限明确报错让用户剪片段，绝不静默截断） */
export const MAX_DEPTH_FRAMES = 2400;

/**
 * 原帧率收敛（第206轮补充用户定稿：不抽帧、直接按源视频原帧率逐帧）：
 * 非法/解析失败 → 回退 30；夹到 [1,60]——>60fps 的深度视频无增益且耗时翻倍，60 内原样保留。
 */
export function clampSourceFps(fps: unknown): number {
	const n = typeof fps === "number" ? fps : Number(fps);
	if (!Number.isFinite(n) || n <= 0) return DEPTH_VIDEO_FPS_FALLBACK;
	return Math.min(60, Math.max(1, n));
}

/**
 * 帧计划：时长 duration（秒）@ fps → 逐帧采样时间戳（秒）。
 * 帧心采样（i+0.5）/fps 落在每帧区间中央，末帧钳在时长内侧防 seek 越界取不到帧。
 * 时长非法（0/NaN/Infinity）返回空数组；超过 maxFrames 也原样返回（由调用方明确报错，不静默截断）。
 */
export function planFrameTimes(duration: number, fps: number, maxFrames = MAX_DEPTH_FRAMES + 1): number[] {
	if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(fps) || fps <= 0) return [];
	const count = Math.min(Math.max(1, Math.round(duration * fps)), Math.max(1, maxFrames));
	const times: number[] = [];
	const safeEnd = Math.max(0, duration - 0.001);
	for (let i = 0; i < count; i++) times.push(Math.min((i + 0.5) / fps, safeEnd));
	return times;
}

/** 一帧深度数据的归一化标定范围（逆深度：值大=近） */
export interface DepthBounds {
	min: number;
	max: number;
}

/** 提取一帧的 min/max（全 NaN/空数据返回 null，调用方按无效帧处理） */
export function rawDepthBounds(data: ArrayLike<number>): DepthBounds | null {
	let min = Infinity;
	let max = -Infinity;
	for (let i = 0; i < data.length; i++) {
		const v = data[i];
		if (v < min) min = v;
		if (v > max) max = v;
	}
	if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
	return { min, max };
}

/**
 * 跨帧标定范围指数平滑（时间平滑归一化的核心）：
 * next = prev·alpha + cur·(1-alpha)。alpha=0（或 prev 为空）即每帧独立。
 * 默认 alpha 0.8：16fps 下约 0.2s 半衰期——单镜头内标定稳定、转场半秒内跟上。
 */
export function smoothDepthBounds(prev: DepthBounds | null, cur: DepthBounds, alpha = 0.8): DepthBounds {
	if (!prev || !(alpha > 0)) return cur;
	const a = Math.min(0.98, alpha);
	return {
		min: prev.min * a + cur.min * (1 - a),
		max: prev.max * a + cur.max * (1 - a),
	};
}

/**
 * 按固定标定范围把深度数据映射为 0..255 灰度（近白远黑；越界值钳到 0/255）。
 * 范围退化（max≈min）返回全 128 中灰，与图片侧 normalizeDepthToGray 同语义。
 */
export function grayWithBounds(data: ArrayLike<number>, bounds: DepthBounds): Uint8ClampedArray<ArrayBuffer> {
	const n = data.length;
	const out = new Uint8ClampedArray(n);
	const range = bounds.max - bounds.min;
	if (!Number.isFinite(range) || range < 1e-6) {
		out.fill(128);
		return out;
	}
	const k = 255 / range;
	for (let i = 0; i < n; i++) out[i] = (data[i] - bounds.min) * k; // Uint8ClampedArray 自钳 0..255
	return out;
}

/** H.264/yuv420 要求偶数边：向下取偶且不小于 2 */
export function evenDim(v: number): number {
	return Math.max(2, Math.floor(v / 2) * 2);
}

/** GPU 批量推理帧数（一次喂给模型的帧数——批越大 GPU 占用越满；WASM CPU 批量无增益恒 1） */
export const DEPTH_INFER_BATCH_GPU = 8;

/**
 * 有界异步队列（抽帧生产者 ↔ 推理消费者的流水线管道，第206轮补充2：GPU 吃满改造）。
 * push 在队满时等待（背压防内存堆积）；close 后 pull 排空剩余再返回 null；
 * fail 让两端的等待立即以同一错误终止。纯逻辑可单测。
 */
export class FrameQueue<T> {
	private items: T[] = [];
	private closed = false;
	private error: unknown = null;
	private pullWaiters: Array<() => void> = [];
	private pushWaiters: Array<() => void> = [];

	constructor(private capacity: number) {
		this.capacity = Math.max(1, capacity);
	}

	private wake(list: Array<() => void>): void {
		const w = list.splice(0, list.length);
		for (const fn of w) fn();
	}

	/** 入队；队满等待（背压）。close/fail 后 push 抛错。 */
	async push(item: T): Promise<void> {
		for (;;) {
			if (this.error) throw this.error;
			if (this.closed) throw new Error("队列已关闭");
			if (this.items.length < this.capacity) {
				this.items.push(item);
				this.wake(this.pullWaiters);
				return;
			}
			await new Promise<void>((r) => this.pushWaiters.push(r));
		}
	}

	/** 出队；空且未关闭则等待；关闭且排空后返回 null。fail 后抛错。 */
	async pull(): Promise<T | null> {
		for (;;) {
			if (this.error) throw this.error;
			if (this.items.length) {
				const item = this.items.shift() as T;
				this.wake(this.pushWaiters);
				return item;
			}
			if (this.closed) return null;
			await new Promise<void>((r) => this.pullWaiters.push(r));
		}
	}

	/** 非阻塞出队：有缓冲即取，否则 null（消费者凑批用——不为凑满批而干等生产者） */
	pullImmediate(): T | null {
		if (this.error || !this.items.length) return null;
		const item = this.items.shift() as T;
		this.wake(this.pushWaiters);
		return item;
	}

	/** 生产完毕：消费者排空剩余后收到 null */
	close(): void {
		this.closed = true;
		this.wake(this.pullWaiters);
		this.wake(this.pushWaiters);
	}

	/** 任一端出错：两端等待立即以该错误终止 */
	fail(err: unknown): void {
		this.error = err instanceof Error ? err : new Error(String(err));
		this.wake(this.pullWaiters);
		this.wake(this.pushWaiters);
	}

	get size(): number {
		return this.items.length;
	}
}

/**
 * 推理输入降采样尺寸：模型内部按 518 系处理，超大帧原图喂入纯属浪费内存——
 * 长边压到 maxEdge（默认 1036 = 2×518 供采样上限，精度零损失；保持比例），已小于上限则原尺寸。
 */
export function inferSize(w: number, h: number, maxEdge = 1036): { w: number; h: number } {
	if (!(w > 0) || !(h > 0)) return { w: 2, h: 2 };
	const edge = Math.max(w, h);
	if (edge <= maxEdge) return { w, h };
	const s = maxEdge / edge;
	return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}
