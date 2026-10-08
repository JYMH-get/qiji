import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ project: {} as Record<string, any>, forms: {} as Record<string, string | null>,
    editorContainer: null as HTMLElement | null, workbench: vi.fn(), modelKey: "image-one", catalog: {} as any }));

vi.mock("@/store/projectStore", () => ({
    useProjectStore: Object.assign((select: any) => select(h.project), { getState: () => h.project }),
}));
vi.mock("@/store/assetFormStore", () => ({
    useAssetFormStore: Object.assign((select: any) => select({ selForm: h.forms }), { getState: () => ({ selForm: h.forms }) }),
}));
vi.mock("@/components/AssetWorkbench", () => ({
    default: (props: unknown) => { h.workbench(props); return <div data-shared-asset-workbench />; },
}));
vi.mock("./rtcAssetEditorSlotStore", () => ({
    useRtcAssetEditorSlotStore: (select: any) => select({ container: h.editorContainer }),
}));
vi.mock("./RtcAssetForms", () => ({
    RtcAssetForms: ({ cat, id }: { cat: string; id: string }) => <div data-asset-forms={`${cat}:${id}`} />,
}));
vi.mock("@/components/ModelPicker", () => ({ useEffectiveModelKey: () => h.modelKey, effectiveModelKey: () => h.modelKey }));
vi.mock("@/store/catalogStore", () => ({
    useCatalogStore: Object.assign((select: any) => select({ catalog: h.catalog }), {
        getState: () => ({ catalog: h.catalog, model: (id: string) => h.catalog.models.find((model: any) => model.id === id) }),
    }),
}));

import { RtcAssetWorkbench } from "./RtcAssetWorkbench";

const categories = [
    { cat: "characters", purpose: "asset.character.image", textField: "features", voice: true },
    { cat: "crowds", purpose: "asset.character.image", textField: "features", voice: true },
    { cat: "scenes", purpose: "asset.scene.image", textField: "description", voice: false },
    { cat: "organisms", purpose: "asset.creature.image", textField: "description", voice: false },
    { cat: "items", purpose: "asset.prop.image", textField: "description", voice: false },
] as const;

beforeEach(() => {
    h.workbench.mockClear();
    h.forms = {};
    h.modelKey = "image-one";
    h.catalog = { models: [
        { id: "image-one", params: [{ key: "resolution", type: "enum", options: ["2k", "4k"] }] },
        { id: "image-two", params: [{ key: "resolution", type: "enum", options: ["1k"] }] },
    ] };
    h.editorContainer = { id: "right-properties-editor-slot" } as HTMLElement;
    h.project = { projectInstanceId: "rtc-asset-project", isProjectLoading: false,
        mediaSettings: { imageAspect: "9:16", imageResolution: "4k", imageQuality: "medium" } };
    for (const { cat } of categories) h.project[cat] = [
        { id: `${cat}-first`, name: "另一资产", image: "mem://other", variants: [] },
        { id: `${cat}-target`, name: "待生成资产", prompt: "资产自身的生成提示词", variants: [
            { id: "form-ready", name: "已出图造型", image: "mem://form" },
            { id: "form-pending", name: "未出图造型", prompt: "造型生成提示词" },
        ] },
    ];
});

describe("RTC 资产预览与右侧编辑共用完整资产工作台", () => {
    it("分体窄栏位于中央资产预览工作区左缘，与当前资产使用同一目标", () => {
        const html = renderToStaticMarkup(<RtcAssetWorkbench cat="characters" id="characters-target" />);
        expect(html).toContain('aria-label="资产预览工作区"');
        expect(html).toContain('data-asset-forms="characters:characters-target"');
        expect(html.indexOf("data-asset-forms")).toBeLessThan(html.indexOf("data-shared-asset-workbench"));
    });

    it.each(categories)("$cat 未出图资产可进入，传递正确生成用途与字段", ({ cat, purpose, textField, voice }) => {
        const html = renderToStaticMarkup(<RtcAssetWorkbench cat={cat} id={`${cat}-target`} />);
        expect(html).toContain("data-shared-asset-workbench");
        expect(h.workbench).toHaveBeenCalledTimes(1);
        const props = h.workbench.mock.calls[0][0];
        expect(props).toMatchObject({ cat, imagePurpose: purpose, textField,
            embeddedTarget: { assetId: `${cat}-target`, formKey: "base" } });
        expect(!!props.showVoice).toBe(voice);
        expect(props.embeddedEditorPortal).toBe(h.editorContainer);
    });

    it("右栏插槽尚未挂载时显式传 null，编辑列不能退回中栏", () => {
        h.editorContainer = null;
        renderToStaticMarkup(<RtcAssetWorkbench cat="characters" id="characters-target" />);
        const props = h.workbench.mock.calls[0][0];
        expect(props).toHaveProperty("embeddedEditorPortal", null);
    });

    it("右栏插槽更换后使用当前容器，不继续挂到旧属性面板", () => {
        const previous = h.editorContainer;
        renderToStaticMarkup(<RtcAssetWorkbench cat="characters" id="characters-target" />);
        h.editorContainer = { id: "replacement-properties-slot" } as HTMLElement;
        renderToStaticMarkup(<RtcAssetWorkbench cat="characters" id="characters-target" />);
        expect(h.workbench.mock.calls[0][0].embeddedEditorPortal).toBe(previous);
        expect(h.workbench.mock.calls[1][0].embeddedEditorPortal).toBe(h.editorContainer);
    });

    it("资产使用底部项目图片设置，参数变化立即传入同一生成会话", () => {
        renderToStaticMarkup(<RtcAssetWorkbench cat="characters" id="characters-target" />);
        expect(h.workbench.mock.calls[0][0].embeddedImageParams).toEqual({ aspect: "9:16", aspect_ratio: "9:16", resolution: "4k", quality: "medium" });
        h.project.mediaSettings = { imageAspect: "1:1", imageResolution: "1k", imageQuality: "low" };
        renderToStaticMarkup(<RtcAssetWorkbench cat="characters" id="characters-target" />);
        expect(h.workbench.mock.calls[1][0].embeddedImageParams).toEqual({ aspect: "1:1", aspect_ratio: "1:1", resolution: "1k", quality: "low" });
    });

    it("未设项目分辨率时按底部当前图片模型取默认档位，切模型刷新", () => {
        h.project.mediaSettings = {};
        renderToStaticMarkup(<RtcAssetWorkbench cat="characters" id="characters-target" />);
        expect(h.workbench.mock.calls[0][0].embeddedImageParams).toMatchObject({ aspect_ratio: "16:9", resolution: "2k", quality: "high" });
        h.modelKey = "image-two";
        renderToStaticMarkup(<RtcAssetWorkbench cat="characters" id="characters-target" />);
        expect(h.workbench.mock.calls[1][0].embeddedImageParams).toMatchObject({ aspect_ratio: "16:9", resolution: "1k", quality: "high" });
    });

    it("显式项目规格不因当前目录不支持而被资产入口静默改写", () => {
        h.project.mediaSettings = { imageAspect: "3:2", imageResolution: "8k", imageQuality: "auto" };
        h.modelKey = "image-two";
        renderToStaticMarkup(<RtcAssetWorkbench cat="characters" id="characters-target" />);
        expect(h.workbench.mock.calls[0][0].embeddedImageParams).toMatchObject({ aspect_ratio: "3:2", resolution: "8k", quality: "auto" });
    });

    it.each(["form-ready", "form-pending"])("沿用当前选中造型 %s，包括尚未出图的造型", formKey => {
        h.forms["characters-target"] = formKey;
        renderToStaticMarkup(<RtcAssetWorkbench cat="characters" id="characters-target" />);
        expect(h.workbench.mock.calls[0][0].embeddedTarget).toEqual({ assetId: "characters-target", formKey });
    });

    it.each([null, "removed-form"])("造型选择 %s 回退基础形象，不借用其它资产的造型", selected => {
        h.forms["characters-target"] = selected;
        h.forms["characters-first"] = "form-ready";
        renderToStaticMarkup(<RtcAssetWorkbench cat="characters" id="characters-target" />);
        expect(h.workbench.mock.calls[0][0].embeddedTarget).toEqual({ assetId: "characters-target", formKey: "base" });
    });

    it("切换资产后传入新目标，已有主图不会阻止工作台挂载", () => {
        renderToStaticMarkup(<RtcAssetWorkbench cat="characters" id="characters-target" />);
        renderToStaticMarkup(<RtcAssetWorkbench cat="characters" id="characters-first" />);
        expect(h.workbench.mock.calls.map(([props]) => props.embeddedTarget.assetId)).toEqual(["characters-target", "characters-first"]);
    });

    it("资产已删除时不偷偷改为列表第一项", () => {
        expect(renderToStaticMarkup(<RtcAssetWorkbench cat="characters" id="deleted" />)).toBe("");
        expect(h.workbench).not.toHaveBeenCalled();
    });

    it("项目加载中不展示旧项目资产或创建生成入口", () => {
        h.project.isProjectLoading = true;
        expect(renderToStaticMarkup(<RtcAssetWorkbench cat="characters" id="characters-target" />)).toBe("");
        expect(h.workbench).not.toHaveBeenCalled();
    });
});
