import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGalleryIdentity } from "@/lib/materialGallery";

const h = vi.hoisted(() => ({ project: {} as any, rtc: {} as any, busy: false, listeners: new Set<() => void>() }));
vi.mock("./freeGenActions", () => ({ freeGenBusy: () => h.busy }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: { getState: () => h.project,
	subscribe: (listener: () => void) => { h.listeners.add(listener); return () => h.listeners.delete(listener); } } }));
vi.mock("@/store/rtcStore", () => ({ activeRtcDoc: (state: any) => state.doc, useRtcStore: { getState: () => h.rtc,
	subscribe: (listener: () => void) => { h.listeners.add(listener); return () => h.listeners.delete(listener); } } }));

import { freeRefGallery, reorderFreeRefs } from "./rtcFreeRefGallery";
import { useRtcFreeGenStore, type FreeGenRef } from "./rtcFreeGenStore";

const image = (name: string): FreeGenRef => ({ uri: `local:${name}`, name, media: "image" });
beforeEach(() => {
	h.project = { projectInstanceId: "owner", isProjectLoading: false };
	h.rtc = { ownerProjectId: "owner", ownerEpisodeKey: "ep", editingSubDocId: null,
		doc: { id: "doc", tracks: [{ id: "track", segments: [{ id: "seg", kind: "placeholder", status: "idle" }] }] } };
	h.listeners.clear();
	h.busy = false;
	useRtcFreeGenStore.setState({ drafts: {} });
});

describe("free reference gallery", () => {
	it("moves duplicate URI objects independently and remaps mixed media tags without changing prose", () => {
		const id = createGalleryIdentity<FreeGenRef>();
		const a = image("same"), b = image("same"), video: FreeGenRef = { uri: "v", media: "video" };
		const refs = [a, video, b];
		const next = reorderFreeRefs(refs, "正文 @Image1 与 @Image2 看 @Video1", id(b), id(a), id)!;
		expect(next.refs).toEqual([b, a, video]);
		expect(next.refs[0]).toBe(b);
		expect(next.prompt).toBe("正文 @Image2 与 @Image1 看 @Video1");
		expect(refs).toEqual([a, video, b]);
	});
	it("reads the latest draft and retains additions made after opening", () => {
		const id = createGalleryIdentity<FreeGenRef>(), a = image("a"), b = image("b"), c = image("c");
		const store = useRtcFreeGenStore.getState();
		store.patch("seg", { refs: [a, b], prompt: "@Image1" });
		const source = freeRefGallery("seg", id);
		expect(source.getItems()?.map(item => item.label)).toEqual(["图片1", "图片2"]);
		store.patch("seg", { refs: [a, b, c] });
		source.reorder!(id(b), id(a));
		expect(store.draftOf("seg").refs).toEqual([b, a, c]);
		expect(store.draftOf("seg").prompt).toBe("@Image2");
		expect(source.getItems()?.map(item => item.id)).toEqual([id(b), id(a), id(c)]);
	});
	it("numbers image, video and audio independently in a mixed list", () => {
		const id = createGalleryIdentity<FreeGenRef>();
		const refs: FreeGenRef[] = [image("a"), { uri: "v1", media: "video" }, { uri: "a1", media: "audio" }, image("b"), { uri: "v2", media: "video" }];
		useRtcFreeGenStore.getState().patch("seg", { refs });
		const source = freeRefGallery("seg", id);
		expect(source.getItems()?.map(item => item.label)).toEqual(["图片1", "视频1", "音频1", "图片2", "视频2"]);
		source.reorder!(id(refs[4]), id(refs[1]));
		expect(source.getItems()?.map(item => [item.uri, item.label])).toEqual([
			["local:a", "图片1"], ["v2", "视频1"], ["v1", "视频2"], ["a1", "音频1"], ["local:b", "图片2"],
		]);
	});
	it.each(["project", "loading", "episode", "compound", "document", "deleted"])("invalidates %s source without writing", reason => {
		const id = createGalleryIdentity<FreeGenRef>(), a = image("a"), b = image("b");
		useRtcFreeGenStore.getState().patch("seg", { refs: [a, b], prompt: "正文" });
		const source = freeRefGallery("seg", id);
		if (reason === "project") h.project = { ...h.project, projectInstanceId: "other" };
		if (reason === "loading") h.project = { ...h.project, isProjectLoading: true };
		if (reason === "episode") h.rtc = { ...h.rtc, ownerEpisodeKey: "other" };
		if (reason === "compound") h.rtc = { ...h.rtc, editingSubDocId: "sub" };
		if (reason === "document") h.rtc = { ...h.rtc, doc: { ...h.rtc.doc, id: "other" } };
		if (reason === "deleted") h.rtc = { ...h.rtc, doc: { ...h.rtc.doc, tracks: [] } };
		expect(source.getItems()).toBeNull(); expect(source.canReorder!()).toBe(false);
		source.reorder!(id(b), id(a));
		expect(useRtcFreeGenStore.getState().draftOf("seg").refs).toEqual([a, b]);
	});
	it.each(["locked", "running", "preparing", "result"])("keeps navigation but prevents reorder for %s target", reason => {
		const id = createGalleryIdentity<FreeGenRef>(), a = image("a"), b = image("b");
		useRtcFreeGenStore.getState().patch("seg", { refs: [a, b] });
		const source = freeRefGallery("seg", id), track = h.rtc.doc.tracks[0];
		if (reason === "locked") track.locked = true;
		if (reason === "running") track.segments[0].status = "running";
		if (reason === "preparing") h.busy = true;
		if (reason === "result") track.segments[0].kind = "video";
		expect(source.getItems()).toHaveLength(2); expect(source.canReorder!()).toBe(false);
		source.reorder!(id(b), id(a));
		expect(useRtcFreeGenStore.getState().draftOf("seg").refs).toEqual([a, b]);
	});
	it("notifies changes and detaches all subscribed stores", () => {
		const source = freeRefGallery("seg", createGalleryIdentity<FreeGenRef>()), listener = vi.fn();
		const stop = source.subscribe!(listener);
		useRtcFreeGenStore.getState().patch("seg", { refs: [image("a")] });
		expect(listener).toHaveBeenCalledTimes(1);
		stop(); listener.mockClear();
		useRtcFreeGenStore.getState().patch("seg", { prompt: "after" });
		expect(listener).not.toHaveBeenCalled(); expect(h.listeners.size).toBe(0);
	});
});
