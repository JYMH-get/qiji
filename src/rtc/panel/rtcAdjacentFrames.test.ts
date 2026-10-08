import { describe, expect, it } from "vitest";
import type { RtcDoc, RtcSegment, RtcTrack } from "@/types/rtc";
import { activeViewDoc } from "@/lib/rtcCompound";
import { resolveAdjacentFrame } from "./rtcAdjacentFrames";

const SEC = 1_000_000;
const seg = (id: string, start: number, duration: number, extra: Partial<RtcSegment> = {}): RtcSegment => ({
 id, kind: "media", media: "video", uri: "asset://" + id + ".mp4", targetStartUs: start * SEC, targetDurationUs: duration * SEC, ...extra,
});
const track = (id: string, segments: RtcSegment[], type: RtcTrack["type"] = "video"): RtcTrack => ({ id, type, segments });
const doc = (...tracks: RtcTrack[]): RtcDoc => ({ id: "main", name: "main", fps: 30, tracks });
const target = (start = 13, duration = 3) => seg("target", start, duration, { kind: "placeholder", uri: undefined });

describe("相邻可见素材取帧", () => {
 it("15秒原片裁至13秒，前邻取13秒边界前最后有效帧", () => {
  const d = doc(track("main", [seg("trimmed", 0, 13, { sourceDurationUs: 13 * SEC }), target()]));
  const result = resolveAdjacentFrame(d, "target", "first")!;
  expect(result.sourceSegId).toBe("trimmed");
  expect(result.sourceSec).toBeCloseTo(13 - 1 / 30, 6);
  expect(result.sourceSec).toBeLessThan(13);
 });
 it("源裁剪起点和倍速共同换算，不取素材原末尾", () => {
  const d = doc(track("main", [seg("fast", 0, 5, { sourceStartUs: 5 * SEC, sourceDurationUs: 10 * SEC, speed: 2 }), target(5)]));
  expect(resolveAdjacentFrame(d, "target", "first")?.sourceSec).toBeCloseTo(15 - 2 / 30, 6);
 });
 it("尾帧垫图取下一段源裁剪首帧，不受其播放速度影响", () => {
  const d = doc(track("main", [target(0, 3), seg("next", 3, 4, { sourceStartUs: 6 * SEC, speed: 0.5 })]));
  expect(resolveAdjacentFrame(d, "target", "last")).toMatchObject({ sourceSegId: "next", sourceSec: 6, timeUs: 3 * SEC });
 });
 it("跨过空隙、占位和缺失媒体，音频不作为画面", () => {
  const d = doc(track("main", [seg("a", 0, 2), seg("pending", 3, 2, { kind: "placeholder" }),
   seg("missing", 5, 2, { uri: undefined }), target(8), seg("next", 13, 2)]), track("audio", [seg("sound", 7, 1, { media: "audio" })], "audio"));
  expect(resolveAdjacentFrame(d, "target", "first")?.sourceSegId).toBe("a");
  expect(resolveAdjacentFrame(d, "target", "last")?.sourceSegId).toBe("next");
 });
 it("上层新版本遮盖旧版本，待生成上层透出下层", () => {
  const d = doc(track("main", [seg("old", 0, 13), target()]), track("version", [seg("new", 0, 13)]),
   track("pending", [seg("pending", 0, 13, { kind: "placeholder" })]));
  expect(resolveAdjacentFrame(d, "target", "first")?.sourceSegId).toBe("new");
 });
 it("当前镜头裁短后排除原镜头及其兄弟/后代版本，不能把旧版剩余画面当邻镜", () => {
  const d = doc(track("main", [seg("before", 0, 5), seg("origin", 5, 20), seg("after", 25, 3)]),
   track("v2", [seg("sibling", 5, 20, { originSegId: "origin" })]),
   track("v3", [{ ...target(10, 10), originSegId: "origin" }]),
   track("v4", [seg("descendant", 7, 17, { originSegId: "sibling" })]));
  expect(resolveAdjacentFrame(d, "target", "first")?.sourceSegId).toBe("before");
  expect(resolveAdjacentFrame(d, "target", "last")?.sourceSegId).toBe("after");
 });
 it("同素材的相邻分割片段没有重生成血缘，仍是有效邻镜", () => {
  const d = doc(track("main", [seg("split-a", 0, 5, { uri: "asset://same.mp4" }),
   seg("target", 5, 5, { uri: "asset://same.mp4", sourceStartUs: 5 * SEC }),
   seg("split-b", 10, 5, { uri: "asset://same.mp4", sourceStartUs: 10 * SEC })]));
  expect(resolveAdjacentFrame(d, "target", "first")?.sourceSegId).toBe("split-a");
  expect(resolveAdjacentFrame(d, "target", "last")?.sourceSec).toBe(10);
 });
 it("完全透明上层不遮挡实际参考素材，边界前短暂可见上层仍会命中", () => {
  const d = doc(track("main", [seg("old", 0, 13), target()]), track("top", [seg("tiny", 12.99, 0.01)]));
  expect(resolveAdjacentFrame(d, "target", "first")?.sourceSegId).toBe("tiny");
  d.tracks[1].segments[0].keyframes = { opacity: [{ t: 0, v: 0 }] };
  expect(resolveAdjacentFrame(d, "target", "first")?.sourceSegId).toBe("old");
 });
 it("取图片引用；转场幽灵不抢相邻素材来源", () => {
  const d = doc(track("main", [seg("picture", 0, 13, { media: "image", uri: "asset://still.png", transitionAfter: { effectId: "dissolve", resourceId: "", name: "叠化", durationUs: SEC } }), target()]));
  expect(resolveAdjacentFrame(d, "target", "first")).toMatchObject({ media: "image", uri: "asset://still.png", sourceSegId: "picture" });
 });
 it("复合宿主裁剪和倍速映射到子素材帧", () => {
  const d = doc(track("main", [seg("compound", 0, 3, { kind: "compound", subDocId: "sub", sourceStartUs: SEC, sourceDurationUs: 6 * SEC, speed: 2 }), target(3)]));
  d.subDocs = { sub: { id: "sub", name: "sub", tracks: [track("child", [seg("child-a", 0, 2), seg("child-b", 2, 5, { sourceStartUs: 7 * SEC, speed: 0.5 })])] } };
  const result = resolveAdjacentFrame(d, "target", "first")!;
  expect(result).toMatchObject({ sourceSegId: "child-b", trackId: "compound/child" });
  expect(result.sourceSec).toBeCloseTo(7 + (7 - 2 / 30 - 2) * 0.5, 6);
 });
 it("子时间轴编辑只在当前子层找邻居，不把主层相邻镜头混入", () => {
  const d = doc(track("main", [seg("outside", 0, 10), seg("compound", 10, 3, { kind: "compound", subDocId: "sub" })]));
  d.subDocs = { sub: { id: "sub", name: "sub", tracks: [track("child", [target(0, 1), seg("inside", 1, 2, { sourceStartUs: 4 * SEC })])] } };
  const active = activeViewDoc(d, "sub")!;
  expect(resolveAdjacentFrame(active, "target", "first")).toBeNull();
  expect(resolveAdjacentFrame(active, "target", "last")).toMatchObject({ sourceSegId: "inside", sourceSec: 4 });
 });
 it("存量源短于目标时钳到源窗口最后一帧，首尾无邻居返回null", () => {
  const d = doc(track("main", [seg("short", 0, 13, { sourceStartUs: 2 * SEC, sourceDurationUs: 3 * SEC }), target()]));
  expect(resolveAdjacentFrame(d, "target", "first")?.sourceSec).toBeCloseTo(5 - 1 / 30, 6);
  expect(resolveAdjacentFrame(d, "target", "last")).toBeNull();
  expect(resolveAdjacentFrame(d, "missing", "first")).toBeNull();
 });
});
