/**
 * videoThumb.ts —— 视频帧缩略图提取（供时间轴片段「平铺预览」与画布单帧缩略图用）。
 *
 * 【能力】
 *   - getVideoThumb(uri)      单帧（时长 10% 处），画布/兼容用途；
 *   - getVideoFrames(uri, ts) 批量按时间点取帧（时间轴片段平铺预览）；
 *   - getCachedFrame(uri, t)  同步读缓存（缩放时先铺已有帧，零闪烁）。
 *
 * 【缓存与性能策略（本文件的全部要点）】
 *   1. **模块级运行时缓存**：Map<`uri@t.toFixed(2)`, dataURL|null>。⚠ 红线：抽出的 dataURL
 *      只活在内存里，**绝不写进 RtcSegment / 项目文件**（项目文件禁 base64/data:，
 *      CLAUDE.md §7.1 有 161MB 撑爆事故先例）。切项目走 clearVideoThumbCache()。
 *   2. **一个 uri 一条抽帧队列，复用同一个 <video> 元素顺序 seek**——绝不为每帧新建元素
 *      （每个 <video> 都占一份解码器，几十段片段同时建元素会直接拖垮 WebView2）。
 *   3. **全局并发上限 MAX_PARALLEL_VIDEOS=2**：其余 uri 排队，避免同时解码多个大文件。
 *   4. **时间点量化**（planFrameTimes）：抽帧时刻落在按源时长决定的固定网格上，画布缩放
 *      导致张数变化时，多数时间点仍命中已有缓存，不重复抽帧。
 *   5. **张数上限 MAX_FRAMES_PER_SEG=14**，窄片段（<28px）不抽帧——防长片段/密集片段卡死。
 *   6. **失败分级**：元素级 error / 元数据加载不出 → 该 uri 进 deadUris 永不重试（缓存 null）；
 *      单帧 seek 超时 → 进 10s 冷却期，冷却内的请求直接回 null 不排队，冷却后可再试
 *      （避免一次冷启动超时把整段片段永久钉成空白）。
 */

/* ── 尺寸与配额 ── */
/** 帧位图尺寸（时间轴一张缩略图渲染宽度约 80px，96×54 足够且省内存） */
export const THUMB_W = 96;
export const THUMB_H = 54;
/** jpeg 质量（预览用途，压到 0.5 明显省内存/CPU） */
const THUMB_QUALITY = 0.5;
/** 每张缩略图约占的片段像素宽度 */
const PX_PER_THUMB = 80;
/** 单个片段最多抽多少帧 */
const MAX_FRAMES_PER_SEG = 14;
/** 窄于此宽度的片段不抽帧（看不清，纯浪费） */
const MIN_STRIP_PX = 28;
/** 同时抽帧的 uri 上限 */
const MAX_PARALLEL_VIDEOS = 2;
/** 单个 uri 一轮抽帧的总预算 */
const RUN_BUDGET_MS = 20_000;
/** 元数据加载超时 */
const META_TIMEOUT_MS = 8_000;
/** 单次 seek 超时 */
const SEEK_TIMEOUT_MS = 4_000;
/** seek 超时后的冷却期（期间该 uri 的请求直接回 null） */
const COOLDOWN_MS = 10_000;
/** 哨兵时间：按「时长 10% 处」取帧（getVideoThumb 的兼容语义） */
const AUTO_T = -1;

/* ══════════════════ 纯计算（零 DOM，可单测） ══════════════════ */

/** 缓存键：uri + 时间点（负数=自动 10% 处哨兵） */
export function frameCacheKey(uri: string, tSec: number): string {
	return tSec < 0 ? `${uri}@auto` : `${uri}@${tSec.toFixed(2)}`;
}

/** 片段宽度 → 平铺缩略图张数（0=不抽帧；上限 MAX_FRAMES_PER_SEG） */
export function thumbTileCount(widthPx: number): number {
	if (!Number.isFinite(widthPx) || widthPx < MIN_STRIP_PX) return 0;
	const n = Math.round(widthPx / PX_PER_THUMB);
	return Math.max(1, Math.min(MAX_FRAMES_PER_SEG, n));
}

/**
 * 抽帧时刻的量化步长（秒）——只与源时长有关，故缩放画布不改变网格、缓存可复用。
 * 短片段用细网格（否则多张缩略图全落同一格），长片段用粗网格（提高跨缩放命中率）。
 */
export function quantStepFor(durSec: number): number {
	if (!(durSec > 0)) return 0.1;
	if (durSec <= 2) return 0.1;
	if (durSec <= 10) return 0.25;
	return 0.5;
}

/**
 * 计算一个片段要抽哪些时间点（秒，绝对时间轴 = 源素材内的时间）。
 * ⚠ 时刻必须落在片段的 **source 窗口** [start, start+dur) 内——裁剪过的片段才显示正确的帧。
 * 返回数组长度 == 缩略图张数（量化后可能出现重复时刻，重复项直接命中缓存，不重复抽帧）。
 */
export function planFrameTimes(widthPx: number, sourceStartSec: number, sourceDurationSec: number): number[] {
	const n = thumbTileCount(widthPx);
	if (n <= 0) return [];
	const start = Math.max(0, Number.isFinite(sourceStartSec) ? sourceStartSec : 0);
	const dur = Math.max(0, Number.isFinite(sourceDurationSec) ? sourceDurationSec : 0);
	const round2 = (x: number) => Math.round(x * 100) / 100;
	if (dur <= 0) return new Array(n).fill(round2(start));
	const step = quantStepFor(dur);
	// 上界略微内缩，防最后一帧落在片段末尾（多数解码器在 duration 处取不到画面）
	const hi = Math.max(start, start + dur - Math.min(0.05, dur / 10));
	const out: number[] = [];
	for (let i = 0; i < n; i++) {
		const t = start + ((i + 0.5) / n) * dur;
		const q = Math.round(t / step) * step;
		out.push(round2(Math.min(Math.max(q, start), hi)));
	}
	return out;
}

/* ══════════════════ 运行时缓存与抽帧队列 ══════════════════ */

const frameCache = new Map<string, string | null>();
/** 缓存条目上限（96×54 jpeg 约 3~5KB/张，1200 张 ≈ 5MB；超出按插入序淘汰最旧） */
const MAX_CACHE_ENTRIES = 1200;

function putFrame(key: string, url: string | null) {
	frameCache.set(key, url);
	while (frameCache.size > MAX_CACHE_ENTRIES) {
		const oldest = frameCache.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		frameCache.delete(oldest);
	}
}

/** 每个 uri 的待抽队列（key → 等待中的 resolve 列表，天然去重） */
const queues = new Map<string, Map<number, ((v: string | null) => void)[]>>();
/** 正在抽帧的 uri */
const running = new Set<string>();
/** 排队等待并发名额的 uri */
const waiting: string[] = [];
/** 明确失败的 uri（元素 error / 元数据取不到）：不再重试 */
const deadUris = new Set<string>();
/** seek 超时冷却：uri → 冷却截止时间戳 */
const cooldown = new Map<string, number>();

/** 同步读缓存：命中返回 dataURL|null，未抽过返回 undefined */
export function getCachedFrame(uri: string, tSec: number): string | null | undefined {
	return frameCache.get(frameCacheKey(uri, tSec));
}

/** 批量取帧：时间点顺序与返回数组一一对应；取不到的位置为 null */
export function getVideoFrames(uri: string, timesSec: number[]): Promise<(string | null)[]> {
	return Promise.all(timesSec.map((t) => requestFrame(uri, t)));
}

/** 单帧（时长 10% 处）——画布/兼容调用点用 */
export function getVideoThumb(uri: string): Promise<string | null> {
	return requestFrame(uri, AUTO_T);
}

function requestFrame(uri: string, tSec: number): Promise<string | null> {
	const key = frameCacheKey(uri, tSec);
	const cached = frameCache.get(key);
	if (cached !== undefined) return Promise.resolve(cached);
	if (!uri || typeof document === "undefined" || deadUris.has(uri)) return Promise.resolve(null);
	const cd = cooldown.get(uri);
	if (cd !== undefined) {
		if (Date.now() < cd) return Promise.resolve(null); // 冷却期内不排队，冷却后自然可再试
		cooldown.delete(uri);
	}
	let q = queues.get(uri);
	if (!q) { q = new Map(); queues.set(uri, q); }
	const waiters = q.get(tSec);
	if (waiters) return new Promise((res) => waiters.push(res));
	return new Promise<string | null>((res) => {
		q!.set(tSec, [res]);
		schedule(uri);
	});
}

function schedule(uri: string) {
	if (running.has(uri) || waiting.includes(uri)) return;
	if (running.size >= MAX_PARALLEL_VIDEOS) { waiting.push(uri); return; }
	void runQueue(uri);
}

function pumpWaiting() {
	while (running.size < MAX_PARALLEL_VIDEOS && waiting.length) {
		const next = waiting.shift()!;
		if (queues.get(next)?.size) void runQueue(next);
	}
}

/** 结算一个时间点：写缓存（cache=false 时不写，留给冷却后重试）并唤醒等待者 */
function settle(uri: string, tSec: number, url: string | null, cache = true) {
	const q = queues.get(uri);
	const waiters = q?.get(tSec);
	q?.delete(tSec);
	if (q && q.size === 0) queues.delete(uri);
	if (cache) putFrame(frameCacheKey(uri, tSec), url);
	waiters?.forEach((fn) => fn(url));
}

/** 抽干一个 uri 的队列：复用同一个 <video>，顺序 seek + 截帧 */
async function runQueue(uri: string) {
	running.add(uri);
	const video = document.createElement("video");
	video.crossOrigin = "anonymous";
	video.preload = "metadata";
	video.muted = true;
	video.playsInline = true;
	const release = () => {
		try {
			video.removeAttribute("src");
			video.load();
		} catch {
			/* 释放解码器，失败无碍 */
		}
	};
	const drainAll = (url: string | null, cache: boolean) => {
		const q = queues.get(uri);
		if (!q) return;
		for (const t of [...q.keys()]) settle(uri, t, url, cache);
	};
	try {
		video.src = uri;
		const ok = await waitMetadata(video);
		if (!ok) {
			deadUris.add(uri); // 明确失败：整段不可解码，不再重试
			drainAll(null, true);
			return;
		}
		const duration = Number.isFinite(video.duration) ? video.duration : 0;
		const deadline = Date.now() + RUN_BUDGET_MS;
		for (;;) {
			const q = queues.get(uri);
			if (!q || q.size === 0) break;
			const t = q.keys().next().value as number;
			if (Date.now() > deadline) { cooldown.set(uri, Date.now() + COOLDOWN_MS); drainAll(null, false); break; }
			const at = t < 0 ? Math.max(0, duration * 0.1) : Math.max(0, Math.min(t, Math.max(0, duration - 0.05)));
			const seeked = await seekTo(video, at);
			if (!seeked) {
				cooldown.set(uri, Date.now() + COOLDOWN_MS);
				settle(uri, t, null, false); // 超时不写缓存，冷却后可再试
				continue;
			}
			settle(uri, t, capture(video));
		}
	} catch {
		drainAll(null, true);
	} finally {
		release();
		running.delete(uri);
		if (queues.get(uri)?.size) schedule(uri);
		pumpWaiting();
	}
}

function waitMetadata(video: HTMLVideoElement): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			video.removeEventListener("loadeddata", onData);
			video.removeEventListener("error", onErr);
			resolve(ok);
		};
		const onData = () => done(video.readyState >= 2);
		const onErr = () => done(false);
		const timer = setTimeout(() => done(false), META_TIMEOUT_MS);
		video.addEventListener("loadeddata", onData);
		video.addEventListener("error", onErr);
		try {
			video.load();
		} catch {
			done(false);
		}
	});
}

function seekTo(video: HTMLVideoElement, t: number): Promise<boolean> {
	return new Promise((resolve) => {
		// 已经停在目标帧：seeked 不会再触发，直接放行（否则白等一次超时）
		if (video.readyState >= 2 && Math.abs(video.currentTime - t) < 0.02) { resolve(true); return; }
		let settled = false;
		const done = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			video.removeEventListener("seeked", onSeeked);
			video.removeEventListener("error", onErr);
			resolve(ok);
		};
		const onSeeked = () => done(video.readyState >= 2);
		const onErr = () => done(false);
		const timer = setTimeout(() => done(false), SEEK_TIMEOUT_MS);
		video.addEventListener("seeked", onSeeked);
		video.addEventListener("error", onErr);
		try {
			video.currentTime = t;
		} catch {
			done(false);
		}
	});
}

function capture(video: HTMLVideoElement): string | null {
	try {
		const cv = document.createElement("canvas");
		cv.width = THUMB_W;
		cv.height = THUMB_H;
		const ctx = cv.getContext("2d");
		if (!ctx) return null;
		ctx.drawImage(video, 0, 0, THUMB_W, THUMB_H);
		return cv.toDataURL("image/jpeg", THUMB_QUALITY);
	} catch {
		return null; // 跨域污染 canvas 等
	}
}

/** 清空缓存（切换项目时调用，防 uri/位图泄漏到新项目） */
export function clearVideoThumbCache() {
	frameCache.clear();
	queues.clear();
	running.clear();
	waiting.length = 0;
	deadUris.clear();
	cooldown.clear();
}
