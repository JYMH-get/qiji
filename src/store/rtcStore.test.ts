/**
 * rtcStore 项目隔离守卫单测（「每个项目独立实时剪辑模式，不要串项目」数据安全加固）：
 *  - commit/undo/redo 的项目身份守卫：切项目后的 stale 回写必须丢弃（新项目 rtcDoc 绝不被污染）
 *    并改从当前项目收编；
 *  - 模块级订阅：换项目全量重置；同项目外部 rtcDoc 写入（多窗口镜像直写）收编——
 *    选区剪枝/播放头钳位/清 undo 栈；自写防回声（commit 后 undo 栈不被订阅误清）；
 *  - patchSilent（AI 生成进度回填专用通道）：写 doc + 回写 projectStore 但**不推 undo 栈**，
 *    守卫与 no-op 语义与 commit 完全一致；
 *  - 纯函数 pruneSelection / clampPlayheadUs。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RtcDoc, RtcSegment } from "@/types/rtc";
import type { VideoEpisode } from "@/services/projectFile";
import { useProjectStore } from "./projectStore";
import { clampPlayheadUs, pruneSelection, useRtcStore } from "./rtcStore";

const SEC = 1_000_000;

function seg(id: string, startUs: number, durUs: number): RtcSegment {
  return { id, kind: "media", media: "video", targetStartUs: startUs, targetDurationUs: durUs };
}

function doc(id: string, segs: RtcSegment[]): RtcDoc {
  return { id, name: id, fps: 30, tracks: [{ id: `${id}-t1`, type: "video", segments: segs }] };
}

const EP1 = "ep-test-1";
const EP2 = "ep-test-2";
function episode(id: string, index: number): VideoEpisode {
  return { id, index, title: `00${index}-测试集${index}`, scriptText: "", shots: [] };
}

/** 模拟一次项目切换：newProject/loadFromPath/importProject 都在同一次 set 里换 身份/分集/rtcDocs（分集化） */
function switchProject(instanceId: string, rtcDoc: RtcDoc | null, eps: VideoEpisode[] = [episode(EP1, 1)]): void {
  useProjectStore.setState({
    projectInstanceId: instanceId,
    episodes: eps,
    rtcEpisodeId: eps[0]?.id ?? null,
    rtcDocs: rtcDoc && eps[0] ? { [eps[0].id]: rtcDoc } : {},
  });
}

/** 当前激活分集档位（断言辅助） */
function slotDoc(epId: string = EP1): RtcDoc | undefined {
  return useProjectStore.getState().rtcDocs[epId];
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  switchProject("pi-test-A", null); // 订阅联动：rtcStore 全量重置到项目 A 的空状态
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("rtcStore 项目身份守卫", () => {
  it("同项目 commit 正常回写 projectStore，且自写不触发订阅误清 undo 栈（防回声）", () => {
    const docA = doc("dA", [seg("s1", 0, 10 * SEC)]);
    useRtcStore.getState().loadDoc(docA);
    expect(useRtcStore.getState().ownerProjectId).toBe("pi-test-A");

    useRtcStore.getState().commit((d) => ({ ...d, name: "改名" }));
    const st = useRtcStore.getState();
    expect(st.doc?.name).toBe("改名");
    expect(slotDoc()).toBe(st.doc); // 回写落到当前项目当前分集档位
    expect(st.past).toHaveLength(1); // 自写防回声：undo 栈未被订阅清空

    useRtcStore.getState().undo();
    expect(useRtcStore.getState().doc).toBe(docA);
    expect(slotDoc()).toBe(docA);
  });

  it("切项目后 stale commit：丢弃回写、新项目 rtcDoc 不被污染、改为收编当前项目（warn 留痕）", () => {
    const docA = doc("dA", [seg("s1", 0, 10 * SEC)]);
    useRtcStore.getState().loadDoc(docA);

    const docB = doc("dB", [seg("b1", 0, 5 * SEC)]);
    switchProject("pi-test-B", docB);
    // 模拟「订阅尚未生效」的竞态窗口：rtcStore 仍端着项目 A 的 doc 与身份
    useRtcStore.setState({ doc: docA, ownerProjectId: "pi-test-A", ownerEpisodeKey: EP1, past: [], future: [] });

    useRtcStore.getState().commit((d) => ({ ...d, name: "旧项目污染" }));

    expect(slotDoc()).toBe(docB); // 新项目分集档位未被污染
    expect(useRtcStore.getState().doc).toBe(docB); // 已收编当前项目文档
    expect(useRtcStore.getState().ownerProjectId).toBe("pi-test-B");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[rtc] commit 丢弃"));
  });

  it("切项目后 stale undo/redo：同样丢弃并收编", () => {
    const docA = doc("dA", [seg("s1", 0, 10 * SEC)]);
    const docA2 = { ...docA, name: "dA-v2" };
    const docB = doc("dB", [seg("b1", 0, 5 * SEC)]);
    switchProject("pi-test-B", docB);

    useRtcStore.setState({ doc: docA2, ownerProjectId: "pi-test-A", ownerEpisodeKey: EP1, past: [docA], future: [] });
    useRtcStore.getState().undo();
    expect(slotDoc()).toBe(docB);
    expect(useRtcStore.getState().doc).toBe(docB);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[rtc] undo 丢弃"));

    useRtcStore.setState({ doc: docA, ownerProjectId: "pi-test-A", ownerEpisodeKey: EP1, past: [], future: [docA2] });
    useRtcStore.getState().redo();
    expect(slotDoc()).toBe(docB);
    expect(useRtcStore.getState().doc).toBe(docB);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[rtc] redo 丢弃"));
  });
});

describe("rtcStore 项目切换/外部变更收编（模块级订阅）", () => {
  it("换项目 → 全量重置：doc=新项目 rtcDoc，selection/playhead/undo 栈清零", () => {
    const docA = doc("dA", [seg("s1", 0, 10 * SEC)]);
    useRtcStore.getState().loadDoc(docA);
    useRtcStore.getState().commit((d) => ({ ...d, name: "v2" }));
    useRtcStore.getState().setSelection(["s1"]);
    useRtcStore.getState().setPlayhead(5 * SEC);

    const docB = doc("dB", [seg("b1", 0, 3 * SEC)]);
    switchProject("pi-test-B", docB);

    const st = useRtcStore.getState();
    expect(st.doc).toBe(docB);
    expect(st.ownerProjectId).toBe("pi-test-B");
    expect(st.selection).toEqual([]);
    expect(st.playheadUs).toBe(0);
    expect(st.past).toEqual([]);
    expect(st.future).toEqual([]);
  });

  it("换到无 rtcDoc 的项目 → 建全新空文档（勿留 null：null→null 切换时时间轴引导 effect 不重跑）", () => {
    const docA = doc("dA", [seg("s1", 0, SEC)]);
    useRtcStore.getState().loadDoc(docA);
    switchProject("pi-test-B", null, [episode("ep-b-1", 1)]);
    const st = useRtcStore.getState();
    expect(st.doc).not.toBeNull();
    expect(st.doc).not.toBe(docA); // 绝不是旧项目的 doc
    expect(st.doc?.tracks.every((t) => t.segments.length === 0)).toBe(true); // 全新空文档
    expect(st.ownerProjectId).toBe("pi-test-B");
    expect(slotDoc("ep-b-1")).toBeUndefined(); // 空文档不落盘（首次 commit 才落）
  });

  it("同项目外部 rtcDoc 写入（多窗口镜像直写）→ 收编：选区剪枝、播放头钳位、清 undo 栈、不回写", () => {
    const docA = doc("dA", [seg("s1", 0, 10 * SEC), seg("s2", 10 * SEC, 10 * SEC)]);
    useRtcStore.getState().loadDoc(docA);
    useRtcStore.getState().commit((d) => ({ ...d, name: "v2" }));
    useRtcStore.getState().setSelection(["s1", "s2"]);
    useRtcStore.getState().setPlayhead(15 * SEC);

    // 外部写入（projectSync fields/full 镜像是 setState 直写，不经 setRtcDoc）：s2 已被另一窗口删除
    const external = doc("dA-ext", [seg("s1", 0, 4 * SEC)]);
    useProjectStore.setState({ rtcDocs: { [EP1]: external } });

    const st = useRtcStore.getState();
    expect(st.doc).toBe(external);
    expect(st.selection).toEqual(["s1"]); // 剪枝掉已不存在的 s2
    expect(st.playheadUs).toBe(4 * SEC); // 钳到新时长内
    expect(st.past).toEqual([]); // 基座变了：旧 undo 会覆盖外部变更，必须清空
    expect(st.future).toEqual([]);
    expect(slotDoc()).toBe(external); // 收编不回写（引用未被换掉）
  });
});

describe("patchSilent（AI 生成进度回填专用的静默写入通道）", () => {
  it("写 doc + 回写 projectStore，但**不推 undo 栈**（进度帧不该把 Ctrl+Z 冲成废物）", () => {
    const docA = doc("dA", [seg("s1", 0, 10 * SEC)]);
    useRtcStore.getState().loadDoc(docA);
    useRtcStore.getState().commit((d) => ({ ...d, name: "用户动作" })); // 先来一条真正的用户动作
    const afterCommit = useRtcStore.getState().doc;
    expect(useRtcStore.getState().past).toHaveLength(1);

    // 模拟 10 帧进度回填
    for (let i = 1; i <= 10; i++) {
      useRtcStore.getState().patchSilent((d) => ({ ...d, name: `进度 ${i}` }));
    }
    const st = useRtcStore.getState();
    expect(st.doc?.name).toBe("进度 10");
    expect(slotDoc()).toBe(st.doc); // 照常回写（去抖落盘）
    expect(st.past).toHaveLength(1); // ⚠ 撤销栈分毫未动
    expect(st.past[0]).toBe(docA);

    // 撤销仍然回到用户动作之前，而不是回到某一帧进度
    useRtcStore.getState().undo();
    expect(useRtcStore.getState().doc).toBe(docA);
    expect(useRtcStore.getState().future[0]?.name).toBe("进度 10"); // 当前态整体进 redo
    expect(afterCommit?.name).toBe("用户动作"); // 不可变：旧快照没被就地改写
  });

  it("mutator 返回原引用 = no-op（值没变的进度帧不落盘）", () => {
    const docA = doc("dA", [seg("s1", 0, 10 * SEC)]);
    useRtcStore.getState().loadDoc(docA);
    useProjectStore.setState({ rtcDocs: { [EP1]: docA } });
    useRtcStore.getState().patchSilent((d) => d);
    expect(useRtcStore.getState().doc).toBe(docA);
    expect(useRtcStore.getState().past).toEqual([]);
  });

  it("切项目后的 stale 进度回填一律丢弃，新项目 rtcDoc 不被污染（与 commit 同一守卫）", () => {
    const docA = doc("dA", [seg("s1", 0, 10 * SEC)]);
    useRtcStore.getState().loadDoc(docA);

    const docB = doc("dB", [seg("s9", 0, 4 * SEC)]);
    switchProject("pi-test-B", docB); // 用户切到项目 B
    // 模拟「订阅尚未生效」的竞态窗口：rtcStore 仍端着项目 A 的 doc 与身份（与 commit 用例同款构造）
    useRtcStore.setState({ doc: docA, ownerProjectId: "pi-test-A", ownerEpisodeKey: EP1, past: [], future: [] });

    useRtcStore.getState().patchSilent((d) => ({ ...d, name: "A 项目的迟到进度" }));
    expect(slotDoc()).toBe(docB); // B 的文档分毫未动
    expect(useRtcStore.getState().doc).toBe(docB); // 改为收编当前项目
    expect(useRtcStore.getState().ownerProjectId).toBe("pi-test-B");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[rtc] patchSilent 丢弃"));
  });

  it("片段被删时选区同步剪枝（与 commit 同尺）", () => {
    const docA = doc("dA", [seg("s1", 0, 4 * SEC), seg("s2", 4 * SEC, 4 * SEC)]);
    useRtcStore.getState().loadDoc(docA);
    useRtcStore.getState().setSelection(["s1", "s2"]);
    useRtcStore.getState().patchSilent((d) => ({
      ...d,
      tracks: d.tracks.map((t) => ({ ...t, segments: t.segments.filter((s) => s.id !== "s2") })),
    }));
    expect(useRtcStore.getState().selection).toEqual(["s1"]);
  });
});

describe("分集化：每分集独立时间轴（rtcDocs 档位 + 切分集换档）", () => {
  it("切分集 → 全量重置载入该集档位；切回 → 上一集编辑成果仍在（各集互不串）", () => {
    const d1 = doc("d1", [seg("s1", 0, 10 * SEC)]);
    const d2 = doc("d2", [seg("x1", 0, 3 * SEC)]);
    switchProject("pi-eps", d1, [episode(EP1, 1), episode(EP2, 2)]);
    useProjectStore.setState({ rtcDocs: { [EP1]: d1, [EP2]: d2 } });
    expect(useRtcStore.getState().doc).toBe(d1);

    useRtcStore.getState().commit((d) => ({ ...d, name: "ep1-edit" }));
    useRtcStore.getState().setSelection(["s1"]);
    useRtcStore.getState().setPlayhead(5 * SEC);
    const edited1 = useRtcStore.getState().doc;

    useProjectStore.getState().switchRtcEpisode(EP2);
    const st = useRtcStore.getState();
    expect(st.doc).toBe(d2); // 换档载入第二集
    expect(st.ownerEpisodeKey).toBe(EP2);
    expect(st.selection).toEqual([]); // 换时间轴=换坐标系：全量重置
    expect(st.playheadUs).toBe(0);
    expect(st.past).toEqual([]);
    expect(slotDoc(EP1)).toBe(edited1); // 第一集编辑成果留在档位里

    useRtcStore.getState().commit((d) => ({ ...d, name: "ep2-edit" }));
    expect(slotDoc(EP2)?.name).toBe("ep2-edit"); // 第二集 commit 落第二集档位
    expect(slotDoc(EP1)).toBe(edited1); // 第一集分毫未动

    useProjectStore.getState().switchRtcEpisode(EP1);
    expect(useRtcStore.getState().doc).toBe(edited1); // 切回：编辑成果还原
  });

  it("切到无档位的分集 → 建空文档（首次 commit 才落档）", () => {
    const d1 = doc("d1", [seg("s1", 0, SEC)]);
    switchProject("pi-eps2", d1, [episode(EP1, 1), episode(EP2, 2)]);
    useProjectStore.getState().switchRtcEpisode(EP2);
    const st = useRtcStore.getState();
    expect(st.doc?.tracks.every((t) => t.segments.length === 0)).toBe(true);
    expect(slotDoc(EP2)).toBeUndefined(); // 空文档未落档
    useRtcStore.getState().commit((d) => ({ ...d, name: "首笔" }));
    expect(slotDoc(EP2)?.name).toBe("首笔"); // 首次 commit 落进自己的档位
  });

  it("激活分集被删 → 回退到余下分集并换档；被删集档位清除", () => {
    const d1 = doc("d1", [seg("s1", 0, SEC)]);
    const d2 = doc("d2", [seg("x1", 0, SEC)]);
    switchProject("pi-eps3", null, [episode(EP1, 1), episode(EP2, 2)]);
    useProjectStore.setState({ rtcDocs: { [EP1]: d1, [EP2]: d2 }, rtcEpisodeId: EP2 });
    expect(useRtcStore.getState().doc).toBe(d2);
    useProjectStore.getState().deleteEpisode(EP2);
    expect(useRtcStore.getState().doc).toBe(d1); // 回退第一集
    expect(slotDoc(EP2)).toBeUndefined(); // 被删集时间轴一并丢弃
  });

  it("setRtcEpisodeDoc 对已删分集丢弃（不重建孤儿档位）", () => {
    switchProject("pi-eps4", null, [episode(EP1, 1)]);
    useProjectStore.getState().setRtcEpisodeDoc("ep-ghost", doc("g", []));
    expect(slotDoc("ep-ghost")).toBeUndefined();
  });
});

describe("纯函数", () => {
  const d = doc("d", [seg("s1", 0, 2 * SEC), seg("s2", 2 * SEC, 3 * SEC)]);

  it("pruneSelection：剔除不存在的 id；无变化时保持原引用", () => {
    expect(pruneSelection(["s1", "dead"], d)).toEqual(["s1"]);
    const keep = ["s1", "s2"];
    expect(pruneSelection(keep, d)).toBe(keep);
    const empty: string[] = [];
    expect(pruneSelection(empty, d)).toBe(empty);
  });

  it("clampPlayheadUs：负值归零、超时长钳到时长、doc 为空归零、界内原样", () => {
    expect(clampPlayheadUs(-1, d)).toBe(0);
    expect(clampPlayheadUs(99 * SEC, d)).toBe(5 * SEC);
    expect(clampPlayheadUs(3 * SEC, null)).toBe(0);
    expect(clampPlayheadUs(3 * SEC, d)).toBe(3 * SEC);
  });
});
