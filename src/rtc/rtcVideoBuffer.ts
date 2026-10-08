import type { RtcVideoLayer } from "./rtcPlayback";

const FRAME_TOLERANCE_SEC = 0.04;
const PLAYING_TOLERANCE_SEC = 0.15;

interface BufferEntry {
	el: HTMLVideoElement;
	uri: string;
	loaded: boolean;
	targetSec: number;
}

/** 每个图层固定两个 video：备用元素先解码入点，当前元素保留画面直到交换。
 * 不创建 canvas 快照，保留带透明通道视频的原生合成；备用元素始终暂停、静音。
 */
export class RtcVideoBuffer {
	private entries: BufferEntry[];
	private visible: BufferEntry | null = null;
	private pending: BufferEntry | null = null;
	private visibleSegId: string | null = null;
	private removers: (() => void)[] = [];

	constructor(elements: [HTMLVideoElement, HTMLVideoElement], changed: () => void) {
		this.entries = elements.map((el) => ({ el, uri: "", loaded: false, targetSec: 0 }));
		for (const entry of this.entries) {
			entry.el.style.visibility = "hidden";
			entry.el.muted = true;
			const onMetadata = () => {
				entry.loaded = true;
				this.align(entry);
				changed();
			};
			const onFrame = () => {
				// seek 期间又拖动了播放头时，完成后继续对齐最新目标。
				if (entry !== this.visible) this.align(entry);
				changed();
			};
			for (const [event, fn] of [["loadedmetadata", onMetadata], ["loadeddata", onFrame], ["seeked", onFrame], ["error", changed]] as const) {
				entry.el.addEventListener(event, fn);
				this.removers.push(() => entry.el.removeEventListener(event, fn));
			}
		}
	}

	private align(entry: BufferEntry) {
		const el = entry.el;
		const target = this.mediaTime(entry, entry.targetSec);
		if (entry.loaded && el.readyState >= 1 && !el.seeking && Math.abs(el.currentTime - target) > FRAME_TOLERANCE_SEC) {
			el.currentTime = target;
		}
	}

	private mediaTime(entry: BufferEntry, requested: number): number {
		const duration = entry.el.duration;
		const time = Number.isFinite(requested) ? Math.max(0, requested) : 0;
		// 旧素材可能缺少准确 sourceDurationUs；用真实时长统一 seek/ready 口径，源耗尽保留末帧。
		return Number.isFinite(duration) && duration > 0 ? Math.min(time, Math.max(0, duration - 0.000001)) : time;
	}

	private prepare(entry: BufferEntry, layer: RtcVideoLayer) {
		entry.targetSec = layer.sourceSec;
		if (entry.uri !== layer.uri) {
			entry.el.pause();
			entry.el.muted = true;
			entry.loaded = false;
			entry.uri = layer.uri;
			entry.el.dataset.uri = layer.uri;
			entry.el.src = layer.uri;
		}
		this.align(entry);
	}

	private ready(entry: BufferEntry, time: number, tolerance = FRAME_TOLERANCE_SEC): boolean {
		return entry.loaded && entry.el.readyState >= 2 && !entry.el.seeking && Math.abs(entry.el.currentTime - this.mediaTime(entry, time)) <= tolerance;
	}

	/** 返回目标帧是否就绪；未就绪不改可见元素，不让换 src 清空旧帧。 */
	sync(layer: RtcVideoLayer | undefined, playing: boolean): boolean {
		if (!layer || layer.media !== "video" || !layer.uri) {
			this.pending = null;
			this.setPlaying(false);
			return true; // 空档的显隐由时间轴图层负责，不能用保留帧填补真实空档。
		}
		const tolerance = playing && !layer.frozen && this.visibleSegId === layer.seg.id ? PLAYING_TOLERANCE_SEC : FRAME_TOLERANCE_SEC;
		if (this.visible?.uri === layer.uri && this.ready(this.visible, layer.sourceSec, tolerance)) {
			this.pending = null;
			this.visibleSegId = layer.seg.id;
			return true; // 同源连续切分只换片段语义，不 reload，也不无条件 seek。
		}
		const candidate = this.pending?.uri === layer.uri ? this.pending :
			this.entries.find((e) => e !== this.visible && e.uri === layer.uri) ??
			this.entries.find((e) => e !== this.visible)!;
		this.pending = candidate;
		this.prepare(candidate, layer);
		if (!this.ready(candidate, layer.sourceSec)) return false;
		this.visible?.el.pause();
		if (this.visible) {
			this.visible.el.muted = true;
			this.visible.el.style.visibility = "hidden";
		}
		this.visible = candidate;
		this.visibleSegId = layer.seg.id;
		candidate.el.style.visibility = "visible";
		this.pending = null;
		return true;
	}

	warm(layer: RtcVideoLayer | undefined) {
		if (this.pending || !layer) return;
		const spare = this.entries.find((e) => e !== this.visible)!;
		this.prepare(spare, layer);
	}

	setPlaying(playing: boolean, layer?: RtcVideoLayer) {
		for (const entry of this.entries) {
			const active = entry === this.visible && !!layer && layer.media === "video";
			entry.el.muted = !active || layer.muted;
			if (active) {
				entry.el.volume = layer.volume;
				entry.el.playbackRate = layer.rate;
			}
			if (playing && active && !layer.frozen && !entry.el.ended && (!Number.isFinite(entry.el.duration) || layer.sourceSec < entry.el.duration)) {
				if (entry.el.paused) void entry.el.play().catch(() => {});
			} else if (!entry.el.paused) entry.el.pause();
		}
	}

	get error(): boolean { return !!this.pending?.el.error; }

	/** 项目/分集/子层变更是新的预览上下文，不能借用上一上下文的保留帧。 */
	reset() {
		this.visible = null;
		this.visibleSegId = null;
		this.pending = null;
		for (const entry of this.entries) {
			entry.el.pause();
			entry.el.muted = true;
			entry.el.style.visibility = "hidden";
			entry.uri = "";
			entry.loaded = false;
			entry.targetSec = 0;
			entry.el.removeAttribute("src");
			delete entry.el.dataset.uri;
			entry.el.load();
		}
	}

	retry() {
		if (!this.pending?.el.error) return;
		this.pending.loaded = false;
		this.pending.el.load();
	}

	dispose() {
		for (const remove of this.removers) remove();
		for (const { el } of this.entries) {
			el.pause();
			el.removeAttribute("src");
			el.load();
		}
	}
}
