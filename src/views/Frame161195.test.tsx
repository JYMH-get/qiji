import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/EditorHeader", () => ({ default: () => null }));
vi.mock("@/components/EditorSidebar", () => ({ default: () => null }));
// 富文本编辑器在 effect 中填入 DOM，SSR 用只读 textarea 验证工作台传入的当前提示词。
vi.mock("@/components/PromptMentionEditor", async () => {
    const { forwardRef } = await import("react");
    return { default: forwardRef((_props: { value: string }, _ref) => <textarea readOnly value={_props.value} />) };
});
vi.mock("@/hooks/useScrollSnapshot", () => ({ useScrollSnapshot: () => ({ ref: { current: null }, onScroll: () => {} }) }));
vi.mock("@/services/generationQueue", () => ({
    startShotGeneration: vi.fn(), startDerivedGeneration: vi.fn(), recallPendingGeneration: vi.fn(),
    subscribeJobProgress: () => () => {}, jobProgressVersion: () => 0, getJobProgress: () => undefined,
}));
// SSR 默认读取 store 首次快照；本测试读取当前会话，模拟心跳后的重新渲染。
vi.mock("@/store/connectionStore", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/store/connectionStore")>();
    return { ...actual, useAssetVideoFeature: actual.getAssetVideoFeature, useModeFeatures: actual.getModeFeatures };
});
vi.mock("@/store/projectStore", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/store/projectStore")>();
    const store = actual.useProjectStore;
    return { ...actual, useProjectStore: Object.assign((selector: (state: ReturnType<typeof store.getState>) => unknown) => selector(store.getState()), store) };
});

import Frame161195 from "./Frame161195";
import { useConnectionStore } from "@/store/connectionStore";
import { useProjectStore } from "@/store/projectStore";

beforeEach(() => {
    useProjectStore.setState({
        episodes: [{
            id: "episode", index: 1, title: "测试分集", scriptText: "测试原文",
            shots: [{ id: "shot", index: 1, title: "分镜1", scriptSegment: "测试原文", prompt: "", materials: [],
                storyboardPrompt: "用于生图的故事板提示词", videoPrompt: "原有视频提示词",
                storyboardUri: "https://example.test/story.png", videoUri: "https://example.test/video.mp4" }],
        }],
        uiSnapshot: { video: { episodeId: "episode", promptTab: { shot: "video" } } },
        mediaSettings: { imgVideoSameSource: false }, pendingGens: [], inferTasks: [],
    });
});
afterEach(() => {
    useConnectionStore.getState().setSession(false);
    useProjectStore.setState({ episodes: [], uiSnapshot: {}, mediaSettings: {} });
});

function render(assetMode: boolean) {
    useConnectionStore.getState().setSession(true, {
        id: "user", name: "用户", credits: 123, features: { assetMode },
    });
    return renderToStaticMarkup(<Frame161195 />);
}

describe("表格视频区显隐", () => {
    it("禁用后保留故事板图片和生图按钮，隐藏视频列、批量生成及逐镜视频选择", () => {
        const html = render(false);
        expect(html).toContain("故事板区");
        expect(html).toContain("https://example.test/story.png");
        expect(html).toContain("一键故事板");
        expect(html).toContain("用于生图的故事板提示词");
        expect(html).toContain("生成设置");
        expect(html).not.toContain("视频区");
        expect(html).not.toContain("https://example.test/video.mp4");
        expect(html).not.toContain("一键视频");
        expect(html).not.toContain("导出所有视频");
        expect(html).not.toContain("模型家族（模型种类，仅本分镜）");
        expect(html).not.toContain("视频比例（仅本分镜）");
    });

    it("重新启用后恢复视频列、历史结果、视频选择及原有提示词 tab", () => {
        render(false);
        const html = render(true);
        expect(html).toContain("视频区");
        // SSR has no visible viewport: keep the player, defer its media request.
        expect(html).toContain("<video");
        expect(html).not.toContain('src="https://example.test/video.mp4"');
        expect(useProjectStore.getState().episodes[0].shots[0].videoUri).toBe("https://example.test/video.mp4");
        expect(html).toContain("一键视频");
        expect(html).toContain("导出所有视频");
        expect(html).toContain("模型家族（模型种类，仅本分镜）");
        expect(html).toContain("原有视频提示词");
        expect(useProjectStore.getState().uiSnapshot?.video?.promptTab?.shot).toBe("video");
    });
});
