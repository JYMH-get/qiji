/**
 * audioPeaks.ts —— 音频波形峰值提取（供时间轴片段波形条与画布音频节点共用）。
 *
 * 逻辑源自 AudioWave.tsx：fetch 字节 → decodeAudioData → 分桶取峰值 → 归一化 + γ 提亮。
 * 视频片段的波形同样走这里（对视频 uri 直接 decodeAudioData——Chromium 一般能解 mp4 里的 AAC）。
 *
 * 【缓存与性能策略】
 *   1. **缓存键 = `uri@bars`**（同一素材不同桶数各缓存一份），配套同步读 getCachedPeaks(uri, bars)。
 *      调用方（时间轴）恒用**固定桶数**取一次（WAVE_BUCKETS），显示时用 resamplePeaks 本地降采样，
 *      这样画布缩放改变片段宽度时**不会重复解码整段音频**。
 *   2. **全局并发上限 MAX_PARALLEL_DECODES=2**：decodeAudioData 是 CPU 大户，同时几十段会卡死 UI。
 *   3. **体积闸 MAX_DECODE_BYTES**：超大文件（长视频）直接放弃解码回 null，由调用方用淡色占位波形兜底。
 *   4. 失败结果同样缓存（null），不反复重试；切项目走 clearAudioPeakCache()。
 *   ⚠ 红线：峰值数组只活在内存里，绝不写进 RtcSegment / 项目文件。
 */
const BARS = 48;
/** 时间轴统一按这个桶数解码一次，显示时本地降采样（见文件头策略 1） */
export const WAVE_BUCKETS = 256;
/** 超过此体积不解码（长视频整段解码会吃光内存） */
const MAX_DECODE_BYTES = 60 * 1024 * 1024;
/** 同时解码的上限 */
const MAX_PARALLEL_DECODES = 2;

const peakCache = new Map<string, number[] | null>();
const pending = new Map<string, Promise<number[] | null>>();
let activeDecodes = 0;
const decodeQueue: (() => void)[] = [];

/* ══════════════════ 纯计算（零 DOM，可单测） ══════════════════ */

/** 缓存键：uri + 桶数（桶数不同=不同的峰值数组，必须分开缓存） */
export function peakCacheKey(uri: string, bars: number): string {
	return `${uri}@${bars}`;
}

/** 片段像素宽度 → 显示用波形桶数（约每 3px 一根，收敛到 48..256） */
export function barsForWidth(widthPx: number): number {
	if (!Number.isFinite(widthPx) || widthPx <= 0) return 48;
	return Math.max(48, Math.min(256, Math.round(widthPx / 3)));
}

/**
 * 本地降采样：把高桶数峰值折算到显示桶数（取每段最大值，保住波形轮廓）。
 * 目标桶数 ≥ 源桶数时原样返回（不做插值放大，避免造出不存在的细节）。
 */
export function resamplePeaks(peaks: number[], bars: number): number[] {
	if (!peaks.length || !Number.isFinite(bars) || bars <= 0 || bars >= peaks.length) return peaks;
	const out: number[] = [];
	for (let i = 0; i < bars; i++) {
		const s = Math.floor((i * peaks.length) / bars);
		const e = Math.max(s + 1, Math.floor(((i + 1) * peaks.length) / bars));
		let max = 0;
		for (let j = s; j < e && j < peaks.length; j++) if (peaks[j] > max) max = peaks[j];
		out.push(max);
	}
	return out;
}

/** 确定性占位波形（按 uri 哈希）：解码失败/进行中显示，同一 uri 恒同形不跳变 */
export function pseudoPeaks(uri: string, bars = BARS): number[] {
	let h = 2166136261 >>> 0;
	const out: number[] = [];
	for (let i = 0; i < bars; i++) {
		h ^= (uri.charCodeAt(i % Math.max(1, uri.length)) || i + 1);
		h = Math.imul(h, 16777619);
		out.push(0.22 + 0.62 * (((h >>> 8) % 1000) / 1000));
	}
	return out;
}

/* ══════════════════ 解码 ══════════════════ */

async function computePeaks(uri: string, bars: number): Promise<number[] | null> {
	try {
		const resp = await fetch(uri);
		if (!resp.ok) return null;
		const len = Number(resp.headers?.get?.("content-length") ?? 0);
		if (len > MAX_DECODE_BYTES) return null;
		const buf = await resp.arrayBuffer();
		if (buf.byteLength > MAX_DECODE_BYTES) return null;
		const AC: typeof AudioContext | undefined =
			(window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
			(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
		if (!AC) return null;
		const ctx = new AC();
		try {
			const audio = await ctx.decodeAudioData(buf);
			const ch = audio.getChannelData(0);
			if (!ch.length) return null;
			const step = Math.max(1, Math.floor(ch.length / bars));
			const peaks: number[] = [];
			for (let i = 0; i < bars; i++) {
				const start = i * step;
				const end = Math.min(ch.length, start + step);
				const stride = Math.max(1, Math.floor((end - start) / 200));
				let max = 0;
				for (let j = start; j < end; j += stride) {
					const v = Math.abs(ch[j]);
					if (v > max) max = v;
				}
				peaks.push(max);
			}
			const top = Math.max(0.01, ...peaks);
			return peaks.map((p) => Math.pow(p / top, 0.7));
		} finally {
			void ctx.close?.().catch(() => {});
		}
	} catch {
		return null; // 无音轨 / 解码器不支持 / 取字节失败
	}
}

/** 并发闸：同时最多 MAX_PARALLEL_DECODES 个解码在跑 */
function withDecodeSlot<T>(fn: () => Promise<T>): Promise<T> {
	if (activeDecodes < MAX_PARALLEL_DECODES) {
		activeDecodes++;
		return fn().finally(releaseSlot);
	}
	return new Promise<T>((resolve, reject) => {
		decodeQueue.push(() => {
			activeDecodes++;
			fn().then(resolve, reject).finally(releaseSlot);
		});
	});
}

function releaseSlot() {
	activeDecodes--;
	const next = decodeQueue.shift();
	if (next) next();
}

/** 异步获取波形峰值（缓存优先；解码失败缓存 null 不重试） */
export function getAudioPeaks(uri: string, bars = BARS): Promise<number[] | null> {
	const key = peakCacheKey(uri, bars);
	const cached = peakCache.get(key);
	if (cached !== undefined) return Promise.resolve(cached);
	let p = pending.get(key);
	if (!p) {
		p = withDecodeSlot(() => computePeaks(uri, bars));
		pending.set(key, p);
	}
	return p.then((r) => {
		peakCache.set(key, r);
		pending.delete(key);
		return r;
	});
}

/** 同步读缓存（未就绪返回 undefined，解码失败返回 null） */
export function getCachedPeaks(uri: string, bars = BARS): number[] | null | undefined {
	return peakCache.get(peakCacheKey(uri, bars));
}

/** 清空缓存（切换项目时调用） */
export function clearAudioPeakCache() {
	peakCache.clear();
	pending.clear();
}
