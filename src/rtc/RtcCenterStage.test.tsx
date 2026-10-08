import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    project: {} as Record<string, any>, rtc: {} as Record<string, any>, center: {} as Record<string, any>,
    assets: {} as Record<string, any>, target: null as any, assetWorkbench: vi.fn(),
}));

// Root component tree checks exercise stable player placement without a DOM renderer.
// Effects are inert, matching SSR; nested useState remains the real React implementation.
vi.mock("react", async original => ({ ...await original<object>(), useEffect: () => undefined }));
vi.mock("@/store/projectStore", () => ({
    useProjectStore: Object.assign((select: any) => select(h.project), { getState: () => h.project }),
    resolveEpisodeKey: (id: string, episodes: any[]) => id || episodes[0]?.id || "",
}));
vi.mock("@/store/rtcStore", () => ({ useRtcStore: Object.assign((select: any) => select(h.rtc), { getState: () => h.rtc }) }));
vi.mock("@/store/assetFormStore", () => ({ useAssetFormStore: (select: any) => select({ selForm: {} }) }));
vi.mock("@/store/lightboxStore", () => ({ openLightbox: vi.fn() }));
vi.mock("./rtcAssetSelStore", () => ({ useRtcAssetSelStore: Object.assign((select: any) => select(h.assets), { getState: () => h.assets }) }));
vi.mock("./panel/rtcCenterTabStore", () => ({ useRtcCenterTabStore: Object.assign((select: any) => select(h.center), { getState: () => h.center }) }));
vi.mock("./RtcSequencePlayer", () => ({ RtcSequencePlayer: () => <div data-sequence-player /> }));
vi.mock("./panel/useRtcSelected", () => ({ useWorkbenchTarget: () => h.target }));
vi.mock("./panel/RtcShotAiWorkbench", () => ({ RtcShotAiWorkbench: () => <div data-shot-workbench /> }));
vi.mock("./panel/RtcFreeGenWorkbench", () => ({ RtcFreeGenWorkbench: () => <div data-free-workbench /> }));
vi.mock("./flow/RtcEpisodeWorkbench", () => ({ RtcEpisodeWorkbench: () => <div data-episode-workbench /> }));
vi.mock("./flow/rtcEpisodeWorkbenchView", () => ({ openRtcEpisodeShot: vi.fn() }));
vi.mock("./flow/RtcScriptEditorPane", () => ({ RtcScriptEditorPane: () => <div data-script-editor /> }));
vi.mock("./panel/segShotBinding", () => ({ ensureShotForPlaceholder: vi.fn() }));
vi.mock("./asset/RtcAssetWorkbench", () => ({ RtcAssetWorkbench: (props: any) => {
    h.assetWorkbench(props); return <div data-asset-workbench={props.id} />;
} }));
vi.mock("./asset/rtcAssetData", () => ({ collectProjectImageItems: (assets: any[]) => assets.filter(asset => asset.image).map(asset => ({ uri: asset.image, name: asset.name })) }));

import { RtcCenterStage } from "./RtcCenterStage";
import { RtcAssetWorkbench } from "./asset/RtcAssetWorkbench";

beforeEach(() => {
    h.assetWorkbench.mockClear();
    const seg = { id: "shot-segment", kind: "placeholder", targetStartUs: 0, targetDurationUs: 8_000_000,
        shotRef: { episodeId: "episode", shotId: "shot" } };
    const track = { id: "track", type: "video", segments: [seg] };
    h.rtc = { doc: { id: "doc", name: "剪辑", fps: 30, tracks: [track] }, playheadUs: 0 };
    h.target = { seg, track, segIndex: 0 };
    h.project = { projectInstanceId: "project", isProjectLoading: false, rtcEpisodeId: "episode", episodes: [{ id: "episode", shots: [] }],
        characters: [{ id: "character-a", name: "未出图角色", prompt: "提示词", variants: [] },
            { id: "character-b", name: "已出图角色", image: "mem://character-b", images: [] }] };
    h.assets = { selected: null, mediaSel: null };
    h.center = { tab: "preview", scriptEditorOpen: false, scriptEditorHidden: false, initTab: vi.fn() };
});

const html = () => renderToStaticMarkup(<RtcCenterStage />);

function assetSessionPath(node: ReactNode, ancestors: ReactElement<any>[] = []): ReactElement<any>[] | null {
    if (!isValidElement(node)) return null;
    const element = node as ReactElement<any>;
    const path = [...ancestors, element];
    if (element.type === RtcAssetWorkbench) return path;
    for (const child of Children.toArray(element.props.children)) {
        const found = assetSessionPath(child, path);
        if (found) return found;
    }
    return null;
}

function currentAssetSession() {
    const path = assetSessionPath(RtcCenterStage());
    expect(path).not.toBeNull();
    return path!;
}

describe("RTC 中栏按用户当前页面和资产目标分派", () => {
    it.each(["character-a", "character-b"])("预览页选中 %s 时显示共享资产预览，不残留播放头分镜内容", id => {
        h.assets.selected = { cat: "characters", id };
        const result = html();
        expect(result).toContain(`data-asset-workbench="${id}"`);
        expect(result).not.toContain("data-shot-workbench");
        expect(result).not.toContain("data-free-workbench");
        expect(result).toContain("data-sequence-player");
        expect(currentAssetSession().some(node => node.props.style?.display === "none")).toBe(false);
    });

    it("资产 A 切到 B 后中栏立即使用新 ID，取消资产后恢复时间轴预览", () => {
        h.assets.selected = { cat: "characters", id: "character-a" };
        expect(html()).toContain('data-asset-workbench="character-a"');
        h.assets.selected = { cat: "characters", id: "character-b" };
        const second = html();
        expect(second).toContain('data-asset-workbench="character-b"');
        expect(second).not.toContain('data-asset-workbench="character-a"');
        h.assets.selected = null;
        const cleared = html();
        expect(cleared).toContain("data-sequence-player");
        expect(cleared).not.toContain("data-shot-workbench");
        expect(cleared).not.toContain("data-asset-workbench");
    });

    it.each(["overview", "workbench"])("显式选择 %s 页后隐藏资产预览并保留会话，播放器仍在", tab => {
        h.assets.selected = { cat: "characters", id: "character-b" };
        h.center.tab = tab;
        const result = html();
        expect(result).toContain("data-sequence-player");
        expect(result).toContain("data-asset-workbench");
        expect(currentAssetSession().some(node => node.props.style?.display === "none")).toBe(true);
        expect(result).not.toContain("data-free-workbench");
        if (tab === "overview") {
            expect(result).toContain("data-episode-workbench");
            expect(result).not.toContain("data-shot-workbench");
        } else {
            expect(result).toContain("data-shot-workbench");
            expect(result).not.toContain("data-episode-workbench");
        }
    });

    it("同一资产切总览和 AI 页时会话位置/type/key不变，回预览重新显示", () => {
        h.assets.selected = { cat: "characters", id: "character-a" };
        const snapshots = ["preview", "overview", "workbench", "preview"].map(tab => {
            h.center.tab = tab;
            const path = currentAssetSession();
            expect(path.some(node => node.props.style?.display === "none")).toBe(tab !== "preview");
            return path.map(node => ({ type: node.type, key: node.key }));
        });
        for (const snapshot of snapshots.slice(1)) expect(snapshot).toEqual(snapshots[0]);
    });

    it("没有时间轴片段时预览页仍能挂载未出图资产的共享生成会话", () => {
        h.rtc.doc.tracks[0].segments = [];
        h.target = null;
        h.assets.selected = { cat: "characters", id: "character-a" };
        const result = html();
        expect(result).toContain('data-asset-workbench="character-a"');
        expect(result).not.toContain("data-shot-workbench");
        expect(result).not.toContain("data-sequence-player");
    });

    it("素材视频仍沿用媒体预览，不能误挂资产编辑会话", () => {
        h.assets.mediaSel = { key: "video", uri: "mem://video", media: "video", name: "视频素材" };
        const result = html();
        expect(result).toContain('<video');
        expect(result).toContain('src="mem://video"');
        expect(result).toContain("data-sequence-player");
        expect(result).not.toContain("data-asset-workbench");
        expect(result).not.toContain("data-shot-workbench");
    });

    it("工作台、总览、预览共用相同位置和 key 的播放器挂载槽", () => {
        const snapshots = ["workbench", "overview", "preview", "workbench"].map((tab, index) => {
            h.center.tab = tab;
            h.assets.selected = index === 3 ? null : { cat: "characters", id: "character-a" };
            const root = RtcCenterStage() as ReactElement<{ children: ReactNode }>;
            const stage = Children.toArray(root.props.children).find(isValidElement) as ReactElement<{ children: ReactNode }>;
            const first = Children.toArray(stage.props.children).find(isValidElement) as ReactElement;
            expect(renderToStaticMarkup(first)).toContain("data-sequence-player");
            return { type: first.type, key: first.key };
        });
        for (const snapshot of snapshots.slice(1)) {
            expect(snapshot.type).toBe(snapshots[0].type);
            expect(snapshot.key).toBe(snapshots[0].key);
        }
    });
});
