import { describe, expect, it, vi } from "vitest";
import type { RtcVideoLayer } from "./rtcPlayback";
import { RtcVideoBuffer } from "./rtcVideoBuffer";

/** Media readiness is driven explicitly: assigning src or currentTime never manufactures a decoded frame. */
class FakeVideo {
	style = { visibility: "" };
	dataset: Record<string, string> = {};
	muted = false;
	paused = true;
	volume = 1;
	playbackRate = 1;
	duration = Number.NaN;
	ended = false;
	readyState = 0;
	seeking = false;
	error: { code: number } | null = null;
	srcWrites: string[] = [];
	seeks: number[] = [];
	playCalls = 0;
	pauseCalls = 0;
	loadCalls = 0;
	rejectPlay = false;
	private source = "";
	private time = 0;
	private listeners = new Map<string, Set<() => void>>();

	get src() { return this.source; }
	set src(value: string) {
		this.source = value; this.srcWrites.push(value); this.resetMedia();
	}
	get currentTime() { return this.time; }
	set currentTime(value: number) {
		this.time = Number.isFinite(this.duration) ? Math.min(this.duration, Math.max(0, value)) : Math.max(0, value);
		this.seeks.push(value); this.seeking = true; this.ended = false;
	}
	private resetMedia() { this.time = 0; this.duration = Number.NaN; this.ended = false; this.readyState = 0; this.seeking = false; this.error = null; this.paused = true; }
	addEventListener(event: string, listener: () => void) {
		if (!this.listeners.has(event)) this.listeners.set(event, new Set());
		this.listeners.get(event)!.add(listener);
	}
	removeEventListener(event: string, listener: () => void) { this.listeners.get(event)?.delete(listener); }
	emit(event: string) { for (const listener of this.listeners.get(event) ?? []) listener(); }
	metadata(duration = 60) { this.duration = duration; this.readyState = 1; this.emit("loadedmetadata"); }
	frame() { this.readyState = 2; this.seeking = false; this.emit("loadeddata"); }
	finishSeek() { this.readyState = 2; this.seeking = false; this.emit("seeked"); }
	advanceTo(time: number) { this.time = time; }
	endPlayback() { this.time = this.duration; this.ended = true; this.paused = true; this.emit("ended"); }
	fail() { this.error = { code: 3 }; this.emit("error"); }
	pause() { this.pauseCalls++; this.paused = true; }
	play(): Promise<void> {
		this.playCalls++;
		if (this.rejectPlay) return Promise.reject(new Error("play interrupted"));
		if (this.ended) { this.time = 0; this.ended = false; } // HTMLMediaElement.play() restarts an ended resource.
		this.paused = false; return Promise.resolve();
	}
	load() { this.loadCalls++; this.resetMedia(); }
	removeAttribute(name: string) { if (name === "src") { this.source = ""; this.resetMedia(); } }
}

function layer(uri: string, sourceSec = 0, extra: Partial<RtcVideoLayer> = {}): RtcVideoLayer {
	return {
		trackId: "v1", layerIndex: 0, uri, sourceSec, media: "video", muted: false, volume: 1, rate: 1, kfRelUs: 0,
		seg: { id: uri, kind: "media", media: "video", uri, targetStartUs: 0, targetDurationUs: 5_000_000 },
		...extra,
	};
}

function fixture() {
	const videos = [new FakeVideo(), new FakeVideo()] as const;
	const changed = vi.fn();
	const buffer = new RtcVideoBuffer(videos as unknown as [HTMLVideoElement, HTMLVideoElement], changed);
	const visible = () => videos.filter(video => video.style.visibility === "visible");
	const show = (target: RtcVideoLayer) => {
		expect(buffer.sync(target, false)).toBe(false);
		const video = videos.find(candidate => candidate.src === target.uri)!;
		video.metadata(); video.frame();
		expect(buffer.sync(target, false)).toBe(true);
		expect(visible()).toEqual([video]);
		return video;
	};
	return { videos, changed, buffer, visible, show };
}

describe("RtcVideoBuffer decoded-frame handoff", () => {
	it("prewarms another URI while keeping the current source/frame and the spare paused and muted", () => {
		const f = fixture(), a = layer("a.mp4", 2), current = f.show(a);
		f.buffer.setPlaying(true, a);
		const before = { writes: current.srcWrites.length, seeks: current.seeks.length };
		f.buffer.warm(layer("b.mp4", 4));
		const spare = f.videos.find(video => video !== current)!;
		expect(current.src).toBe("a.mp4"); expect(current.currentTime).toBe(2); expect(current.paused).toBe(false);
		expect(current.srcWrites).toHaveLength(before.writes); expect(current.seeks).toHaveLength(before.seeks);
		expect(spare.src).toBe("b.mp4"); expect(spare.paused).toBe(true); expect(spare.muted).toBe(true);
		spare.metadata(); spare.frame();
		expect(spare.currentTime).toBe(4); expect(spare.playCalls).toBe(0); expect(f.visible()).toEqual([current]);
	});

	it("does not expose a replacement until metadata, decoded data and the requested seek are all ready", () => {
		const f = fixture(), current = f.show(layer("a.mp4")), next = layer("b.mp4", 8);
		expect(f.buffer.sync(next, false)).toBe(false);
		const spare = f.videos.find(video => video !== current)!;
		spare.readyState = 2; spare.emit("loadeddata"); // Data alone cannot stand in for metadata.
		expect(f.buffer.sync(next, false)).toBe(false); expect(f.visible()).toEqual([current]);
		spare.metadata();
		expect(spare.currentTime).toBe(8); expect(spare.seeking).toBe(true);
		expect(f.buffer.sync(next, false)).toBe(false); expect(f.visible()).toEqual([current]);
		spare.readyState = 2;
		expect(f.buffer.sync(next, false)).toBe(false); // A time assignment still has an unfinished seek.
		spare.seeking = false; spare.readyState = 1;
		expect(f.buffer.sync(next, false)).toBe(false); // Metadata alone has no displayable frame.
		spare.frame();
		expect(f.buffer.sync(next, false)).toBe(true); expect(f.visible()).toEqual([spare]);
	});

	it("swaps only a ready frame and allows only the visible element to play with the layer audio settings", () => {
		const f = fixture(), a = layer("a.mp4"), current = f.show(a), next = layer("b.mp4", 3, { volume: 0.35, rate: 1.5 });
		f.buffer.setPlaying(true, a);
		f.buffer.warm(next);
		const spare = f.videos.find(video => video !== current)!; spare.metadata(); spare.frame();
		expect(f.buffer.sync(next, true)).toBe(true);
		f.buffer.setPlaying(true, next);
		expect(f.visible()).toEqual([spare]); expect(current.paused).toBe(true); expect(current.muted).toBe(true);
		expect(spare.paused).toBe(false); expect(spare.muted).toBe(false); expect(spare.volume).toBe(0.35); expect(spare.playbackRate).toBe(1.5);
		f.buffer.setPlaying(true, { ...next, muted: true }); expect(spare.muted).toBe(true);
	});

	it("keeps continuous splits of one source on the same element without seeking or reloading", () => {
		const f = fixture(), current = f.show(layer("same.mp4", 2));
		f.buffer.setPlaying(true, layer("same.mp4", 2));
		const writes = current.srcWrites.length, seeks = current.seeks.length;
		current.advanceTo(5);
		const split = layer("same.mp4", 5, { seg: { id: "split-2", kind: "media", media: "video", uri: "same.mp4", targetStartUs: 5_000_000, targetDurationUs: 5_000_000 } });
		expect(f.buffer.sync(split, true)).toBe(true);
		expect(f.visible()).toEqual([current]); expect(current.currentTime).toBe(5);
		expect(current.srcWrites).toHaveLength(writes); expect(current.seeks).toHaveLength(seeks); expect(current.loadCalls).toBe(0);
		expect(f.videos.find(video => video !== current)!.src).toBe("");
	});

	it("decodes a distant seek on the spare even for the same URI, retaining the old visible frame", () => {
		const f = fixture(), current = f.show(layer("same.mp4", 2)), target = layer("same.mp4", 20);
		expect(f.buffer.sync(target, false)).toBe(false);
		const spare = f.videos.find(video => video !== current)!;
		expect(current.currentTime).toBe(2); expect(current.seeking).toBe(false); expect(f.visible()).toEqual([current]);
		expect(spare.src).toBe("same.mp4"); spare.metadata();
		expect(spare.currentTime).toBe(20); expect(f.buffer.sync(target, false)).toBe(false);
		spare.finishSeek(); expect(f.buffer.sync(target, false)).toBe(true); expect(f.visible()).toEqual([spare]);
	});

	it("treats a 100ms source jump in a new split as a seek, not normal playback drift", () => {
		const f = fixture(), current = f.show(layer("same.mp4", 2));
		f.buffer.setPlaying(true, layer("same.mp4", 2));
		const oldSeeks = current.seeks.length;
		const target = layer("same.mp4", 2.1, { seg: { id: "jumped-split", kind: "media", media: "video", uri: "same.mp4", targetStartUs: 2_000_000, targetDurationUs: 3_000_000 } });
		expect(f.buffer.sync(target, true)).toBe(false);
		const spare = f.videos.find(video => video !== current)!;
		expect(f.visible()).toEqual([current]); expect(current.currentTime).toBe(2); expect(current.seeks).toHaveLength(oldSeeks);
		spare.metadata(); expect(spare.currentTime).toBe(2.1); expect(f.buffer.sync(target, true)).toBe(false);
		spare.finishSeek(); expect(f.buffer.sync(target, true)).toBe(true); expect(f.visible()).toEqual([spare]);
	});

	it.each([5, 25])("resolves requested time %ss at a 5s resource end without repeated seeks, playback or endless buffering", (requested) => {
		const f = fixture(), current = f.show(layer("a.mp4")), target = layer("short.mp4", requested);
		expect(f.buffer.sync(target, true)).toBe(false);
		const spare = f.videos.find(video => video !== current)!;
		spare.metadata(5);
		expect(spare.currentTime).toBeGreaterThan(4.96); expect(spare.currentTime).toBeLessThanOrEqual(5);
		expect(f.visible()).toEqual([current]); expect(f.buffer.sync(target, true)).toBe(false);
		spare.finishSeek(); expect(f.buffer.sync(target, true)).toBe(true); expect(f.visible()).toEqual([spare]);
		const seeks = spare.seeks.length;
		for (const sourceSec of [requested, requested + 1, requested + 10]) {
			const exhausted = { ...target, sourceSec };
			expect(f.buffer.sync(exhausted, true)).toBe(true);
			f.buffer.setPlaying(true, exhausted);
		}
		expect(spare.seeks).toHaveLength(seeks); expect(spare.paused).toBe(true); expect(spare.playCalls).toBe(0);
		expect(spare.currentTime).toBeGreaterThan(4.96); expect(f.visible()).toEqual([spare]);
	});

	it("does not restart a naturally ended source while a near-end timeline frame remains active", () => {
		const f = fixture(), a = layer("a.mp4", 2), current = f.show(a);
		f.buffer.setPlaying(true, a); current.endPlayback();
		const playCalls = current.playCalls, seeks = current.seeks.length;
		const lastFrame = { ...a, sourceSec: current.duration - 0.01 };
		expect(f.buffer.sync(lastFrame, true)).toBe(true);
		f.buffer.setPlaying(true, lastFrame);
		expect(current.ended).toBe(true); expect(current.paused).toBe(true); expect(current.currentTime).toBe(current.duration);
		expect(current.playCalls).toBe(playCalls); expect(current.seeks).toHaveLength(seeks); expect(f.visible()).toEqual([current]);
	});

	it("ignores late B events after a rapid A to B to C target change", () => {
		const f = fixture(), current = f.show(layer("a.mp4")), b = layer("b.mp4", 2), c = layer("c.mp4", 7);
		f.buffer.sync(b, false);
		const spare = f.videos.find(video => video !== current)!; spare.metadata();
		expect(spare.seeking).toBe(true);
		expect(f.buffer.sync(c, false)).toBe(false); expect(spare.src).toBe("c.mp4");
		spare.emit("seeked"); spare.emit("loadeddata"); // Queued B events arrive after src has reset readiness.
		expect(f.buffer.sync(c, false)).toBe(false); expect(f.visible()).toEqual([current]);
		spare.metadata(); spare.frame();
		expect(f.buffer.sync(c, false)).toBe(true); expect(f.visible()).toEqual([spare]); expect(spare.src).toBe("c.mp4"); expect(spare.currentTime).toBe(7);
	});

	it("finishes an in-flight seek at the latest target before making it visible", () => {
		const f = fixture(), current = f.show(layer("a.mp4"));
		f.buffer.sync(layer("b.mp4", 2), false);
		const spare = f.videos.find(video => video !== current)!; spare.metadata();
		f.buffer.sync(layer("b.mp4", 9), false);
		expect(spare.currentTime).toBe(2); expect(f.visible()).toEqual([current]);
		spare.finishSeek(); // Completing 2s schedules the latest 9s seek; it is not the final frame.
		expect(spare.currentTime).toBe(9); expect(spare.seeking).toBe(true);
		expect(f.buffer.sync(layer("b.mp4", 9), false)).toBe(false); expect(f.visible()).toEqual([current]);
		spare.finishSeek(); expect(f.buffer.sync(layer("b.mp4", 9), false)).toBe(true); expect(f.visible()).toEqual([spare]);
	});

	it("pauses and mutes both elements in a real gap without manufacturing another visible frame", () => {
		const f = fixture(), a = layer("a.mp4"), current = f.show(a);
		f.buffer.setPlaying(true, a); f.buffer.sync(layer("b.mp4", 4), true);
		expect(f.buffer.sync(undefined, true)).toBe(true);
		expect(f.videos.every(video => video.paused && video.muted)).toBe(true);
		const spare = f.videos.find(video => video !== current)!; spare.metadata(); spare.frame();
		expect(f.buffer.sync(undefined, true)).toBe(true); expect(f.visible()).toEqual([current]);
		// The timeline hides the entire layer in a gap; cached visibility alone must not restart media.
		expect(f.videos.every(video => video.paused)).toBe(true);
	});

	it("keeps frozen transition frames paused even when timeline playback is active", () => {
		const f = fixture(), frozen = layer("ghost.mp4", 3, { frozen: true, muted: true }), current = f.show(frozen);
		f.buffer.setPlaying(true, frozen);
		expect(current.paused).toBe(true); expect(current.muted).toBe(true); expect(current.playCalls).toBe(0);
	});

	it("retries only the failed pending source and retains the old visible frame until the retry is decoded", () => {
		const f = fixture(), current = f.show(layer("a.mp4")), target = layer("b.mp4", 6);
		f.buffer.retry(); expect(f.videos.every(video => video.loadCalls === 0)).toBe(true);
		f.buffer.sync(target, false);
		const spare = f.videos.find(video => video !== current)!; spare.fail();
		expect(f.buffer.error).toBe(true); expect(f.visible()).toEqual([current]);
		f.buffer.retry(); expect(spare.loadCalls).toBe(1); expect(current.loadCalls).toBe(0); expect(spare.src).toBe("b.mp4");
		expect(f.buffer.error).toBe(false); expect(f.buffer.sync(target, false)).toBe(false); expect(f.visible()).toEqual([current]);
		spare.metadata(); spare.frame(); expect(f.buffer.sync(target, false)).toBe(true); expect(f.visible()).toEqual([spare]);
	});

	it("removes listeners and releases both media sources on dispose", () => {
		const f = fixture(), a = layer("a.mp4"); f.show(a); f.buffer.setPlaying(true, a); f.buffer.warm(layer("b.mp4"));
		const notifications = f.changed.mock.calls.length;
		f.buffer.dispose();
		expect(f.videos.every(video => video.paused && video.src === "" && video.loadCalls === 1)).toBe(true);
		for (const video of f.videos) { video.metadata(); video.frame(); video.fail(); video.emit("seeked"); }
		expect(f.changed).toHaveBeenCalledTimes(notifications);
	});

	it("reset removes old-context frames and sources but keeps the buffer usable for a new project", () => {
		const f = fixture(), a = layer("old-project.mp4", 3);
		f.show(a); f.buffer.setPlaying(true, a); f.buffer.warm(layer("old-next.mp4", 4));
		f.buffer.reset();
		expect(f.visible()).toEqual([]); expect(f.buffer.error).toBe(false);
		expect(f.videos.every(video => video.paused && video.muted && video.src === "" && video.dataset.uri === undefined)).toBe(true);
		for (const video of f.videos) { video.emit("loadedmetadata"); video.emit("loadeddata"); video.emit("seeked"); }
		expect(f.buffer.sync(undefined, false)).toBe(true); expect(f.visible()).toEqual([]);
		const next = layer("new-project.mp4", 8);
		expect(f.buffer.sync(next, true)).toBe(false); expect(f.visible()).toEqual([]);
		const video = f.videos.find(candidate => candidate.src === next.uri)!;
		video.metadata(); video.frame();
		expect(f.buffer.sync(next, true)).toBe(true); f.buffer.setPlaying(true, next);
		expect(f.visible()).toEqual([video]); expect(video.currentTime).toBe(8); expect(video.paused).toBe(false);
		expect(f.videos.filter(candidate => candidate.src.startsWith("old-"))).toHaveLength(0);
	});

	it("absorbs an interrupted play promise while retaining the ready frame", async () => {
		const f = fixture(), a = layer("a.mp4"), current = f.show(a); current.rejectPlay = true;
		expect(() => f.buffer.setPlaying(true, a)).not.toThrow(); await Promise.resolve();
		expect(current.paused).toBe(true); expect(f.visible()).toEqual([current]);
		current.rejectPlay = false; f.buffer.setPlaying(true, a); expect(current.paused).toBe(false);
	});
});
