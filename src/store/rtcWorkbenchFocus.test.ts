import { beforeEach, describe, expect, it } from "vitest";
import type { RtcDoc, RtcSegment } from "@/types/rtc";
import { useProjectStore } from "./projectStore";
import { activeRtcDoc, useRtcStore } from "./rtcStore";
import { mainTrackSegAt } from "@/rtc/panel/rtcCenterTabCore";
import { chooseWorkbenchSegment, workbenchFocusMatches, workbenchSelectedId } from "@/rtc/panel/rtcWorkbenchTargetCore";

const SEC = 1_000_000;
const segment = (id: string, start: number, duration: number): RtcSegment => ({
  id, kind: "media", media: "video", targetStartUs: start * SEC, targetDurationUs: duration * SEC,
  shotRef: { episodeId: "ep1", shotId: id },
});
const makeDoc = (): RtcDoc => ({ id: "focus-doc", name: "focus", fps: 30, tracks: [
  { id: "main", type: "video", segments: [segment("main1", 0, 5), segment("main2", 5, 5)] },
  { id: "upper", type: "video", segments: [segment("upper10", 2, 6)] },
] });

function targetId() {
  const s = useRtcStore.getState();
  const d = activeRtcDoc(s);
  const selected = d?.tracks.flatMap(t => t.segments).find(seg => seg.id === workbenchSelectedId(s)) ?? null;
  return chooseWorkbenchSegment(selected, mainTrackSegAt(d, s.playheadUs)?.seg ?? null, workbenchFocusMatches(s.workbenchFocus, s))?.id;
}

beforeEach(() => {
  useProjectStore.setState({ projectInstanceId: "focus-project", savePath: null,
    episodes: [{ id: "ep1", index: 1, title: "test", scriptText: "", shots: [] }], rtcEpisodeId: "ep1", rtcDocs: {} });
  useRtcStore.getState().loadDoc(makeDoc());
  useRtcStore.getState().setPlayhead(3 * SEC);
});

describe("工作台临时选中优先（实际 RTC store）", () => {
  it("单击上层10覆盖播放头下主轨1，不改文档/播放头/撤销", async () => {
    const before = useRtcStore.getState();
    before.setSelection(["upper10"]);
    await Promise.resolve();
    expect(targetId()).toBe("upper10");
    const after = useRtcStore.getState();
    expect(after.playheadUs).toBe(before.playheadUs);
    expect(after.doc).toBe(before.doc);
    expect(after.past).toBe(before.past);
  });

  it("下一次播放/寻址移动即恢复主轨，旧选中不阻止跨镜", async () => {
    useRtcStore.getState().setSelection(["upper10"]);
    await Promise.resolve();
    useRtcStore.getState().setPlayhead(3 * SEC + 1);
    expect(targetId()).toBe("main1");
    useRtcStore.getState().setPlayhead(6 * SEC);
    expect(targetId()).toBe("main2");
    expect(useRtcStore.getState().selection).toEqual(["upper10"]);
  });

  it("双击同步选中再定位上层起点仍选上层，随后移动恢复跟随", async () => {
    const s = useRtcStore.getState();
    s.setSelection(["upper10"]);
    s.setPlayhead(2 * SEC);
    expect(targetId()).toBe("upper10");
    await Promise.resolve();
    s.setPlayhead(2 * SEC + 1);
    expect(targetId()).toBe("main1");
  });

  it("寻址同位置不取消临时优先，重复选择同一片段可再次接管", async () => {
    const s = useRtcStore.getState();
    s.setSelection(["upper10"]);
    await Promise.resolve();
    s.setPlayhead(3 * SEC);
    expect(targetId()).toBe("upper10");
    s.setPlayhead(4 * SEC);
    expect(targetId()).toBe("main1");
    s.setSelection(["upper10"]);
    expect(targetId()).toBe("upper10");
  });

  it("同一同步窗口寻址到选中范围之外不保留选中优先", () => {
    const s = useRtcStore.getState();
    s.setSelection(["upper10"]);
    s.setPlayhead(9 * SEC);
    expect(targetId()).toBe("main2");
  });

  it("取消选择/重载文档清临时优先，旧microtask不恢复", async () => {
    const s = useRtcStore.getState();
    s.setSelection(["upper10"]);
    s.setSelection([]);
    await Promise.resolve();
    expect(useRtcStore.getState().workbenchFocus).toBeNull();
    expect(targetId()).toBe("main1");
    s.setSelection(["upper10"]);
    s.loadDoc(makeDoc());
    await Promise.resolve();
    expect(useRtcStore.getState().workbenchFocus).toBeNull();
  });

  it("项目/分集切换清临时优先，同名seg不会沿用旧目标", async () => {
    useRtcStore.getState().setSelection(["upper10"]);
    useProjectStore.setState({ projectInstanceId: "other-project", rtcDocs: { ep1: makeDoc() } });
    await Promise.resolve();
    expect(useRtcStore.getState().workbenchFocus).toBeNull();
    useRtcStore.getState().setSelection(["upper10"]);
    useProjectStore.setState({ episodes: [
      { id: "ep1", index: 1, title: "1", scriptText: "", shots: [] },
      { id: "ep2", index: 2, title: "2", scriptText: "", shots: [] },
    ], rtcEpisodeId: "ep2", rtcDocs: { ep1: makeDoc(), ep2: makeDoc() } });
    await Promise.resolve();
    expect(useRtcStore.getState().workbenchFocus).toBeNull();
  });

  it("复合进出清优先，子层可临时选中但不会带回主层", async () => {
    const d = makeDoc();
    d.tracks[0].segments.push({ id: "compound", kind: "compound", subDocId: "child", targetStartUs: 10 * SEC, targetDurationUs: 10 * SEC });
    d.subDocs = { child: { id: "child", name: "child", tracks: makeDoc().tracks } };
    useRtcStore.getState().loadDoc(d);
    const s = useRtcStore.getState();
    s.setSelection(["upper10"]);
    s.enterCompound("child");
    expect(useRtcStore.getState().workbenchFocus).toBeNull();
    s.setSelection(["upper10"]);
    expect(targetId()).toBe("upper10");
    s.exitCompound();
    await Promise.resolve();
    expect(useRtcStore.getState().workbenchFocus).toBeNull();
  });

  it("显式点击没有分镜的普通素材不显示另一镜的工作台", () => {
    const d = makeDoc();
    d.tracks[1].segments[0].shotRef = undefined;
    useRtcStore.getState().loadDoc(d);
    useRtcStore.getState().setSelection(["upper10"]);
    expect(targetId()).toBeUndefined();
  });

  it("点击多选或组内第二段只更换工作台焦点，保持多选集合与顺序", () => {
    const selection = ["main1", "upper10"];
    useRtcStore.getState().setSelection(selection, "upper10");
    expect(useRtcStore.getState().selection).toBe(selection);
    expect(targetId()).toBe("upper10");
    useRtcStore.getState().setSelection(selection, "main1");
    expect(useRtcStore.getState().selection).toBe(selection);
    expect(targetId()).toBe("main1");
  });

  it("组内焦点的同步定位按被点段范围锚定，后续播放恢复主轨", async () => {
    useRtcStore.getState().setSelection(["main1", "upper10"], "upper10");
    useRtcStore.getState().setPlayhead(6 * SEC);
    expect(targetId()).toBe("upper10");
    await Promise.resolve();
    useRtcStore.getState().setPlayhead(6 * SEC + 1);
    expect(targetId()).toBe("main2");
  });
});
