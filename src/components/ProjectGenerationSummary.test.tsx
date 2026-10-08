import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ project: {} as Record<string, any>, catalog: {} as any }));
vi.mock("@/store/projectStore", () => ({
    useProjectStore: Object.assign((select: any) => select(h.project), { getState: () => h.project }),
}));
vi.mock("@/store/catalogStore", () => ({
    useCatalogStore: Object.assign((select: any) => select({ catalog: h.catalog }), { getState: () => ({ catalog: h.catalog }) }),
}));
vi.mock("@/components/ModelPicker", () => ({
    default: ({ label }: { label: string }) => <span>{label}</span>,
    useEffectiveModelKey: (cap: string) => `${cap}-model`,
    useCapModelOptions: () => [{ id: "video-model", label: "视频模型" }],
}));
vi.mock("@/store/connectionStore", () => ({ useDualModeFeature: () => true }));
vi.mock("@/services/adapters/registry", () => ({ getAdapter: () => undefined }));
vi.mock("@/rtc/panel/shotWorkbenchParts", () => ({ JobChips: () => null, secTitle: {}, secBox: {} }));
vi.mock("@/rtc/panel/rtcShotSubmission", () => ({
    useShotPreparing: () => false,
    withCurrentOption: (values: unknown[], value: unknown) => values.includes(value) ? values : [...values, value],
}));

import ProjectGenerationSummary from "./ProjectGenerationSummary";
import { RtcShotWorkbench } from "@/rtc/panel/RtcShotWorkbench";
import { buildImageParams } from "@/lib/genParams";
import { imageResolutionOptionsForKey } from "@/lib/modelOptions";

beforeEach(() => {
    h.project = { projectInstanceId: "resolution-project", isProjectLoading: false, episodes: [], mediaSettings: {} };
    h.catalog = { version: 1, models: [] };
});

function setResolutionOptions(options: string[]) {
    h.catalog = { ...h.catalog, version: h.catalog.version + 1, models: [{ id: "image-model", label: "图片模型",
        params: [{ key: "resolution", type: "enum", options }] }] };
}

function renderedResolution(expected: string) {
    const before = h.project.mediaSettings;
    const submitted = buildImageParams(h.project.mediaSettings.imageResolution === undefined ? {} : {
        resolution: h.project.mediaSettings.imageResolution,
    }, imageResolutionOptionsForKey("image-model")).resolution;
    expect(submitted).toBe(expected);
    const summary = renderToStaticMarkup(<ProjectGenerationSummary />);
    expect(summary).toContain(`16:9 ${expected.toUpperCase()} 高画质`);
    const settings = renderToStaticMarkup(<RtcShotWorkbench />);
    expect(settings).toMatch(new RegExp(`<option[^>]*value="${expected}"[^>]*selected=""`));
    expect(settings).toContain(`16:9 · ${expected}`);
    expect(h.project.mediaSettings).toBe(before);
}

describe("项目图片默认分辨率与实际提交一致", () => {
    it.each([
        { options: ["1k", "2k", "4k"], expected: "2k" },
        { options: ["4k", "2k", "1k"], expected: "2k" },
        { options: ["1k", "4k"], expected: "1k" },
        { options: ["4k"], expected: "4k" },
        { options: [], expected: "2k" },
    ])("未设置时目录 $options 在摘要、设置和提交均使用 $expected", ({ options, expected }) => {
        setResolutionOptions(options);
        renderedResolution(expected);
        expect(h.project.mediaSettings).not.toHaveProperty("imageResolution");
    });

    it.each(["1k", "8k"])("显式 %s 保持原值，不被默认 2K 或目录覆盖", resolution => {
        setResolutionOptions(["2k", "4k"]);
        h.project.mediaSettings = { imageResolution: resolution };
        renderedResolution(resolution);
    });

    it("目录变动刷新未设置项目的默认值，不写入项目保存字段", () => {
        setResolutionOptions(["1k", "2k", "4k"]);
        renderedResolution("2k");
        setResolutionOptions(["4k"]);
        renderedResolution("4k");
        expect(h.project.mediaSettings).toEqual({});
    });
});
