import { describe, expect, it, vi } from "vitest";
import type { DragEvent } from "react";
import { QIJI_ASSET_MIME, promptMediaDropHandlers, readPromptMediaDrop } from "./promptMediaDrop";

function transfer(data: Record<string, string> = {}, files: File[] = []): DataTransfer {
	return { getData: (type: string) => data[type] || "", files, types: [...Object.keys(data), ...(files.length ? ["Files"] : [])], dropEffect: "none" } as unknown as DataTransfer;
}
const file = (name: string, type: string) => new File([name], name, { type });
const event = (dataTransfer: DataTransfer) => ({ dataTransfer, preventDefault: vi.fn(), stopPropagation: vi.fn() }) as unknown as DragEvent<HTMLElement>;

describe("prompt media drop protocol", () => {
	it("prefers the custom asset protocol and local display URI over its plain-text copy and public URL", () => {
		const dt = transfer({ [QIJI_ASSET_MIME]: JSON.stringify({ source: "qiji-asset", assetId: "C1", localUri: "local://portrait", url: "https://media.test/portrait", name: "角色", kind: "image", cat: "characters" }), "text/plain": "正文" });
		expect(readPromptMediaDrop(dt)).toEqual({ asset: { uri: "local://portrait", assetId: "C1", name: "角色", media: "image", cat: "characters" } });
	});
	it("supports marked plain-text compatibility payloads and legacy custom payloads without a source field", () => {
		expect(readPromptMediaDrop(transfer({ "text/plain": JSON.stringify({ source: "qiji-asset", uri: "local://plain", id: "P1" }) }))).toMatchObject({ asset: { uri: "local://plain", assetId: "P1", name: "素材", media: "image" } });
		expect(readPromptMediaDrop(transfer({ [QIJI_ASSET_MIME]: JSON.stringify({ url: "https://media.test/legacy" }) }))).toMatchObject({ asset: { uri: "https://media.test/legacy" } });
	});
	it.each(["video", "audio"] as const)("preserves %s media from the asset kind fallback", (kind) => {
		expect(readPromptMediaDrop(transfer({ [QIJI_ASSET_MIME]: JSON.stringify({ uri: "local://media", kind }) }))).toMatchObject({ asset: { media: kind } });
	});
	it("falls back to a valid URI and accepts only string IDs/names", () => {
		expect(readPromptMediaDrop(transfer({ [QIJI_ASSET_MIME]: JSON.stringify({ localUri: 99, uri: "", url: "https://media.test/fallback", assetId: 123, name: {} }) }))).toEqual({ asset: { uri: "https://media.test/fallback", assetId: undefined, name: "素材", media: "image", cat: undefined } });
	});
	it.each(["拖入的普通文字", "【预设:cinematic】", "@Image1", '{"uri":"https://example.test/not-an-asset"}', "null", "{"])("leaves ordinary text or capsule payload %s to the editor", (text) => {
		expect(readPromptMediaDrop(transfer({ "text/plain": text }))).toBeNull();
	});
	it("keeps every supported local media file in order and filters non-media files", () => {
		const image = file("image.png", "image/png"), pdf = file("notes.pdf", "application/pdf"), video = file("video.mp4", "video/mp4"), audio = file("audio.wav", "audio/wav"), unknown = file("unknown", "");
		expect(readPromptMediaDrop(transfer({}, [image, pdf, video, audio, unknown]))).toEqual({ files: [image, video, audio] });
		expect(readPromptMediaDrop(transfer({}, [pdf, unknown]))).toBeNull();
	});
	it("recovers media files from a malformed asset payload without throwing", () => {
		const image = file("fallback.png", "image/png");
		expect(readPromptMediaDrop(transfer({ [QIJI_ASSET_MIME]: "{" }, [image]))).toEqual({ files: [image] });
	});
});

describe("prompt drop event consumption", () => {
	it.each([QIJI_ASSET_MIME, "Files"])("allows %s dragging without invoking the drop write handler", (type) => {
		const handler = vi.fn(() => true), dt = transfer({ [type]: "" }), ev = event(dt);
		promptMediaDropHandlers(handler).onDragOverCapture(ev);
		expect(ev.preventDefault).toHaveBeenCalledOnce(); expect(dt.dropEffect).toBe("copy"); expect(handler).not.toHaveBeenCalled();
	});
	it("consumes a handled material drop once, preventing raw JSON insertion and outer timeline insertion", () => {
		const ev = event(transfer()), handler = vi.fn(() => true);
		promptMediaDropHandlers(handler).onDropCapture(ev);
		expect(handler).toHaveBeenCalledExactlyOnceWith(ev.dataTransfer);
		expect(ev.preventDefault).toHaveBeenCalledOnce(); expect(ev.stopPropagation).toHaveBeenCalledOnce();
	});
	it("leaves text and preset dragging untouched when the host declines the drop", () => {
		const ev = event(transfer({ "text/plain": "【预设:cinematic】" }));
		const handlers = promptMediaDropHandlers(dt => readPromptMediaDrop(dt) !== null);
		handlers.onDragOverCapture(ev); handlers.onDropCapture(ev);
		expect(ev.preventDefault).not.toHaveBeenCalled(); expect(ev.stopPropagation).not.toHaveBeenCalled(); expect(ev.dataTransfer.dropEffect).toBe("none");
	});
	it("does not change default behavior when the host has no media-drop handler", () => {
		const ev = event(transfer({ [QIJI_ASSET_MIME]: "{}" })), handlers = promptMediaDropHandlers();
		handlers.onDragOverCapture(ev); handlers.onDropCapture(ev);
		expect(ev.preventDefault).not.toHaveBeenCalled(); expect(ev.stopPropagation).not.toHaveBeenCalled();
	});
});
