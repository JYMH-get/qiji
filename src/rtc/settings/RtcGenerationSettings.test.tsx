import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RtcDoc, RtcSegment, RtcTrack } from "@/types/rtc";

// SSR 读取测试当前快照；保留真实 stores/actions，避免服务端固定初始快照掩盖当前选区。
vi.mock("@/store/projectStore", async importActual => {
    const real = await importActual<typeof import("@/store/projectStore")>();
    return { ...real, useProjectStore: Object.assign((select: any) => select(real.useProjectStore.getState()), real.useProjectStore) };
});
vi.mock("@/store/rtcStore", async importActual => {
    const real = await importActual<typeof import("@/store/rtcStore")>();
    return { ...real, useRtcStore: Object.assign((select: any) => select(real.useRtcStore.getState()), real.useRtcStore) };
});
vi.mock("../rtcAssetSelStore", async importActual => {
    const real = await importActual<typeof import("../rtcAssetSelStore")>();
    return { ...real, useRtcAssetSelStore: Object.assign((select: any) => select(real.useRtcAssetSelStore.getState()), real.useRtcAssetSelStore) };
});
vi.mock("@/components/ModelPicker", () => ({
    default: ({ label }: { label: string }) => <span>{label}</span>,
    useEffectiveModelKey: (cap: string) => `${cap}-default`,
    useCapModelOptions: () => [{ id: "video-override", label: "单镜指定模型" }],
}));
vi.mock("@/hooks/useScopedLightboxGallery", () => ({ useScopedLightboxGallery: () => vi.fn() }));
vi.mock("@/store/connectionStore", async importActual => ({ ...await importActual<object>(), useDualModeFeature: () => true }));

import { useProjectStore } from "@/store/projectStore";
import { useRtcStore } from "@/store/rtcStore";
import { useRtcAssetSelStore } from "../rtcAssetSelStore";
import { useRtcShotNavigation } from "../flow/rtcShotNavigation";
import { RtcGenerationSettings, rtcGenerationSettingsTarget } from "./RtcGenerationSettings";
import { RtcPropertyPanel } from "../RtcPropertyPanel";
import { RtcAssetProps } from "../asset/RtcAssetProps";
import { useRtcSettingsModal } from "./rtcSettingsModalStore";

const seg = (id: string, patch: Partial<RtcSegment> = {}): RtcSegment => ({ id, kind: "placeholder", name: id, targetStartUs: 0, targetDurationUs: 8_000_000, ...patch });
const track = (segments: RtcSegment[], type: RtcTrack["type"] = "video"): RtcTrack => ({ id: "track", type, name: "主轨", segments });
const doc = (tracks: RtcTrack[]): RtcDoc => ({ id: "doc", name: "剪辑", fps: 30, tracks });
const shotSeg = seg("shot-seg", { shotRef: { episodeId: "ep", shotId: "shot" } });
const defaultFields = ["生图要求（故事板）", "生图模型", "图像比例", "画质", "生视频项目默认", "生视频模型", "时长(秒)", "分辨率", "比例", "带资产", "带故事板", "图视同源"];

beforeEach(() => {
    useProjectStore.setState({ projectInstanceId: "p", isProjectLoading: false, rtcEpisodeId: "ep", pendingGens: [], inferTasks: [],
        mediaSettings: { maxDuration: 20, imageAspect: "3:2", imageResolution: "8k", imageQuality: "high", resolution: "4k", aspect: "9:16", videoMethod: "frames", genWithAsset: false, genWithStory: true, imgVideoSameSource: false },
        episodes: [{ id: "ep", index: 1, title: "第一集", scriptText: "", shots: [{ id: "shot", index: 1, title: "镜头甲", prompt: "", materials: [], durationSec: 7, overrides: { videoModelKey: "video-override", duration: 11, resolution: "1080p", aspect: "4:3" } }] }],
        characters: [{ id: "C1", name: "角色甲", features: "", philosophy: "", prompt: "资产的出图提示词", image: "mem://base", variants: [] }],
    });
    useRtcStore.setState({ ownerProjectId: "p", ownerEpisodeKey: "ep", editingSubDocId: null, selection: [], workbenchFocus: null, doc: doc([track([shotSeg])]), playheadUs: 0 });
    useRtcAssetSelStore.getState().clear();
    useRtcShotNavigation.setState({ listSelection: null, reveal: null });
    useRtcSettingsModal.getState().close();
});

describe("生成设置迁入工具栏设置窗口", () => {
    it("无选中也提供完整项目默认，保留不在目录内的显式参数", () => {
        const settings = useProjectStore.getState().mediaSettings;
        const html = renderToStaticMarkup(<RtcGenerationSettings />);
        defaultFields.forEach(label => expect(html).toContain(label));
        for (const value of ["20", "8k", "4k", "3:2", "9:16", "frames"]) expect(html).toMatch(new RegExp(`<option[^>]*value="${value}"[^>]*selected=""`));
        expect(html).not.toContain("镜头甲"); // 不从播放头推导另一镜。
        expect(useProjectStore.getState().mediaSettings).toBe(settings);
    });

    it("单镜覆盖仅作生效摘要，项目默认和覆盖字段均不被显示动作改写", () => {
        useRtcStore.setState({ selection: [shotSeg.id] });
        const before = structuredClone(useProjectStore.getState().episodes[0].shots[0].overrides);
        const html = renderToStaticMarkup(<RtcGenerationSettings />);
        expect(html).toContain("本镜生效：单镜指定模型 · 11s · 1080p · 4:3");
        expect(html).toMatch(/<option[^>]*value="20"[^>]*selected=""/);
        expect(useProjectStore.getState().episodes[0].shots[0].overrides).toEqual(before);
    });

    it("多选集合不变时设置摘要跟随明确点击的那一镜", () => {
        const second = seg("second", { shotRef: { episodeId: "ep", shotId: "shot-2" } });
        const ep = useProjectStore.getState().episodes[0];
        useProjectStore.setState({ episodes: [{ ...ep, shots: [...ep.shots, { ...ep.shots[0], id: "shot-2", title: "镜头乙" }] }] });
        useRtcStore.setState({ doc: doc([track([shotSeg, second])]), selection: [shotSeg.id, second.id],
            workbenchFocus: { ownerProjectId: "p", ownerEpisodeKey: "ep", editingSubDocId: null, segId: second.id, playheadUs: 0, revision: 1, allowImmediateSeek: false } });
        const html = renderToStaticMarkup(<RtcGenerationSettings />);
        expect(html).toContain("镜头乙"); expect(html).not.toContain("镜头甲");
    });

    it.each(["placeholder", "media"] as const)("%s 分镜的属性页不再混入生成设置", kind => {
        const s = { ...shotSeg, kind, media: "image" as const, uri: "mem://image" };
        useRtcStore.setState({ doc: doc([track([s])]), selection: [s.id] });
        const html = renderToStaticMarkup(<RtcPropertyPanel />);
        expect(html).toContain("主轨");
        ["生图要求（故事板）", "生图模型", "生视频项目默认", "生视频模型", "带资产", "带故事板", "图视同源"].forEach(label => expect(html).not.toContain(label));
        expect(html).not.toContain("AI 生成属性");
    });

    it("资产属性只提供编辑器插槽，底部设置仅保留项目图片与视频默认", () => {
        const props = renderToStaticMarkup(<RtcAssetProps cat="characters" id="C1" />);
        expect(props).toContain("data-rtc-asset-editor-slot");
        expect(props).not.toContain("角色甲"); expect(props).not.toContain("分体选择"); expect(props).not.toContain("编号：");
        expect(props).not.toContain("出图提示词"); expect(props).not.toContain("生图模型"); expect(props).not.toContain("重新生成");
        useRtcAssetSelStore.setState({ selected: { cat: "characters", id: "C1" } });
        const settings = renderToStaticMarkup(<RtcGenerationSettings />);
        defaultFields.forEach(label => expect(settings).toContain(label));
        expect(settings).not.toContain("当前资产生成设置"); expect(settings).not.toContain("资产的出图提示词"); expect(settings).not.toContain("重新生成");
        expect(settings).not.toContain("角色甲");
    });

    it("生成入口与原快捷键/预览入口共用同一弹窗状态", () => {
        useRtcSettingsModal.getState().openModal("generation");
        expect(useRtcSettingsModal.getState()).toMatchObject({ open: true, tab: "generation" });
        useRtcSettingsModal.getState().openModal("keys");
        expect(useRtcSettingsModal.getState()).toMatchObject({ open: true, tab: "keys" });
        useRtcSettingsModal.getState().close();
        expect(useRtcSettingsModal.getState().open).toBe(false);
    });

    it.each(["plain", "text", "compound"])("明确选择%s时只展示项目默认，不借用列表/播放头的分镜", kind => {
        const selected = seg("selected", { kind: kind === "compound" ? "compound" : "media", ...(kind === "text" ? { shotRef: shotSeg.shotRef } : {}) });
        const t = track([selected], kind === "text" ? "text" : "video");
        expect(rtcGenerationSettingsTarget(doc([t]), selected.id, { seg: shotSeg, track: track([shotSeg]), segIndex: 0 })).toBeNull();
    });
    it("列表目标可在无时间轴选区时提供原分镜设置；已删除的明确目标不回退", () => {
        const t = track([shotSeg]), listed = { seg: shotSeg, track: t, segIndex: 0 };
        expect(rtcGenerationSettingsTarget(doc([t]), undefined, listed)).toBe(listed);
        expect(rtcGenerationSettingsTarget(doc([t]), "deleted", listed)).toBeNull();
    });
});
