import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RtcDoc } from "@/types/rtc";
const h = vi.hoisted(() => ({ project: {} as any, rtc: {} as any, capture: vi.fn(), save: vi.fn() }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: { getState: () => h.project } }));
vi.mock("@/store/rtcStore", () => ({
 useRtcStore: { getState: () => h.rtc },
 activeRtcDoc: (state: any) => state.editingSubDocId ? state.doc?.subDocs?.[state.editingSubDocId] : state.doc,
}));
vi.mock("@/canvas/videoCapture", () => ({ captureFromUri: h.capture }));
vi.mock("@/canvas/nodeUpload", () => ({ newLocalAssetId: () => "LC-captured" }));
vi.mock("@/services/assetPersist", () => ({ saveUploadedLocal: h.save }));
import { insertAdjacentFrame } from "./rtcAdjacentFrameCapture";

const SEC = 1_000_000;
const frameBlob = () => new Blob(["frame"], { type: "image/png" });
const saved = () => ({ id: "LC-captured", localUri: "asset://saved.png", localPath: "C:/project/assets/saved.png" });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const target = () => h.rtc.doc.tracks[0].segments[1];
const previous = () => h.rtc.doc.tracks[0].segments[0];
const params = (extra: Record<string, unknown> = {}) => ({ segId: "target", edge: "first" as const, onInsert: vi.fn(), ...extra });
beforeEach(() => {
 vi.clearAllMocks();
 h.project = { projectInstanceId: "project-A", isProjectLoading: false, blobByUri: vi.fn() };
 const doc: RtcDoc = { id: "doc-A", name: "doc-A", fps: 30, tracks: [{ id: "video", type: "video", segments: [
  { id: "previous", kind: "media", media: "video", uri: "asset://previous.mp4", targetStartUs: 0, targetDurationUs: 13 * SEC, sourceDurationUs: 13 * SEC },
  { id: "target", kind: "placeholder", targetStartUs: 13 * SEC, targetDurationUs: 3 * SEC },
 ] }] };
 h.rtc = { doc, ownerProjectId: "project-A", ownerEpisodeKey: "ep-A", editingSubDocId: null };
 h.capture.mockResolvedValue({ blob: frameBlob() });
 h.save.mockResolvedValue(saved());
});

describe("相邻取帧持久化与异步目标守卫", () => {
 it("截取13秒裁剪边界前帧，保存本地PNG后才提交持久引用", async () => {
  const args = params();
  expect(await insertAdjacentFrame(args)).toBe(true);
  expect(h.capture).toHaveBeenCalledWith("asset://previous.mp4", "frame", { timeSec: 13 - 1 / 30 });
  expect(h.save.mock.calls[0][0]).toBeInstanceOf(File);
  expect(h.save.mock.calls[0][0].type).toBe("image/png");
  expect(args.onInsert).toHaveBeenCalledWith(expect.objectContaining({ assetId: "LC-captured", uri: "asset://saved.png", sourceSegId: "previous" }), "first");
 });
 it.each(["project", "episode", "subdoc", "target-deleted", "target-trimmed", "source-replaced", "source-trimmed"])("抽帧等待中%s变化，不保存或写入其它目标", async change => {
  const pending = deferred<{ blob: Blob }>(); h.capture.mockReturnValueOnce(pending.promise);
  const args = params(), result = insertAdjacentFrame(args);
  if (change === "project") h.project.projectInstanceId = "project-B";
  if (change === "episode") h.rtc.ownerEpisodeKey = "ep-B";
  if (change === "subdoc") h.rtc.editingSubDocId = "other";
  if (change === "target-deleted") h.rtc.doc.tracks[0].segments.pop();
  if (change === "target-trimmed") target().targetStartUs += SEC;
  if (change === "source-replaced") previous().uri = "asset://replacement.mp4";
  if (change === "source-trimmed") previous().sourceStartUs = SEC;
  pending.resolve({ blob: frameBlob() });
  expect(await result).toBe(false);
  expect(h.save).not.toHaveBeenCalled(); expect(args.onInsert).not.toHaveBeenCalled();
 });
 it("等待中只更新生成进度不取消当前有效相邻帧", async () => {
  const pending = deferred<{ blob: Blob }>(); h.capture.mockReturnValueOnce(pending.promise);
  const args = params(), result = insertAdjacentFrame(args);
  target().progress = 73;
  pending.resolve({ blob: frameBlob() });
  expect(await result).toBe(true); expect(args.onInsert).toHaveBeenCalledOnce();
 });
 it("落盘等待中切项目，落盘函数守卫失效且不写垫图", async () => {
  const pending = deferred<ReturnType<typeof saved>>(); h.save.mockReturnValueOnce(pending.promise);
  const args = params(), result = insertAdjacentFrame(args);
  await vi.waitFor(() => expect(h.save).toHaveBeenCalledOnce());
  h.project.projectInstanceId = "project-B";
  expect(h.save.mock.calls[0][4].shouldContinue()).toBe(false);
  pending.resolve(saved());
  expect(await result).toBe(false); expect(args.onInsert).not.toHaveBeenCalled();
 });
 it.each([null, { id: "bad", localUri: "blob:temporary", localPath: "C:/bad" }, { id: "bad", localUri: "data:image/png;base64,x", localPath: "C:/bad" }])("没有可靠本地文件时不把临时引用写进项目", async value => {
  h.save.mockResolvedValueOnce(value);
  const args = params();
  await expect(insertAdjacentFrame(args)).rejects.toThrow("未能保存到本地");
  expect(args.onInsert).not.toHaveBeenCalled();
 });
 it("相邻图片直接复用已有持久引用，不抽视频帧或重复落盘", async () => {
  Object.assign(previous(), { media: "image", uri: "asset://existing.png", assetId: "image-existing" });
  const args = params();
  expect(await insertAdjacentFrame(args)).toBe(true);
  expect(h.capture).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled();
  expect(args.onInsert).toHaveBeenCalledWith(expect.objectContaining({ uri: "asset://existing.png", assetId: "image-existing" }), "first");
 });
 it("宿主卸载/切换目标由shouldContinue取消迟到取帧", async () => {
  const pending = deferred<{ blob: Blob }>(); h.capture.mockReturnValueOnce(pending.promise);
  let mounted = true; const args = params({ shouldContinue: () => mounted }), result = insertAdjacentFrame(args);
  mounted = false; pending.resolve({ blob: frameBlob() });
  expect(await result).toBe(false); expect(args.onInsert).not.toHaveBeenCalled();
 });
 it("没有相邻媒体不触发抽帧或持久化", async () => {
  h.rtc.doc.tracks[0].segments.shift();
  const args = params();
  await expect(insertAdjacentFrame(args)).rejects.toThrow("前方没有");
  expect(h.capture).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled();
 });
});
