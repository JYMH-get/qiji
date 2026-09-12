/**
 * HTML 媒体元素与时间轴播放头的对时工具。
 * 播放头是唯一主时钟；媒体尚未拿到 metadata 时也要持续记住最新目标，不能让一次性回调捕获旧值。
 */

const PLAYING_DRIFT_SEC = 0.15;
const PAUSED_DRIFT_SEC = 0.033;
const DESIRED_TIME_KEY = "rtcDesiredTime";
const PENDING_SEEK_KEY = "rtcPendingSeek";

export interface MediaTimeElement {
	readyState: number;
	currentTime: number;
	dataset: Record<string, string | undefined>;
	addEventListener(type: string, listener: EventListener, options?: boolean | AddEventListenerOptions): void;
}

function safeTime(sec: number): number {
	return Number.isFinite(sec) ? Math.max(0, sec) : 0;
}

/** 只更新“播放头此刻要求媒体到哪里”，供 metadata 延迟到达时读取。 */
export function rememberMediaTime(el: MediaTimeElement, sec: number): void {
	el.dataset[DESIRED_TIME_KEY] = String(safeTime(sec));
}

function applyRememberedMediaTime(el: MediaTimeElement): void {
	const sec = Number(el.dataset[DESIRED_TIME_KEY]);
	try { el.currentTime = safeTime(sec); } catch { /* 媒体解码异常时交给下一轮同步重试 */ }
}

/**
 * 立即对时；metadata 未就绪时只挂一个监听，并在事件发生时读取最新目标而不是旧闭包值。
 */
export function seekMediaTime(el: MediaTimeElement, sec: number): void {
	rememberMediaTime(el, sec);
	if (el.readyState >= 1) {
		applyRememberedMediaTime(el);
		return;
	}
	if (el.dataset[PENDING_SEEK_KEY] === "1") return;
	el.dataset[PENDING_SEEK_KEY] = "1";
	el.addEventListener("loadedmetadata", () => {
		delete el.dataset[PENDING_SEEK_KEY];
		applyRememberedMediaTime(el);
	}, { once: true });
}

/** 播放时容忍 150ms 自然漂移，暂停拖动按约一帧阈值精确跟随。 */
export function shouldResyncMedia(currentSec: number, desiredSec: number, playing: boolean): boolean {
	if (!Number.isFinite(currentSec)) return true;
	return Math.abs(currentSec - safeTime(desiredSec)) > (playing ? PLAYING_DRIFT_SEC : PAUSED_DRIFT_SEC);
}
