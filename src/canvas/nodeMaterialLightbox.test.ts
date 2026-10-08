import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "@/types";
import { useCanvasStore } from "@/store/canvasStore";
import { useProjectStore } from "@/store/projectStore";
import { useLibraryStore } from "@/store/libraryStore";
import { useUiStore } from "@/store/uiStore";
import { usePromptModalStore } from "@/store/promptModalStore";
import { uploadKeys, useUploadStore } from "@/store/uploadStore";
import { useLightboxStore } from "@/store/lightboxStore";
import { splitLegendPrompt } from "@/lib/shotMaterials";
import { compileNodeMaterialPrompt, listNodeMaterials, nodePromptMaterials, syncNodeLegend } from "./nodeMaterials";
import { reorderNodeMaterial } from "./nodeMaterialReorder";
import { createNodeMaterialLightboxSource, nodeMaterialGalleryEntries, openNodeMaterialLightbox } from "./nodeMaterialLightbox";

const image = (id: string, name: string, assetId?: string) => ({ id, name, assetId, url: `mem://${id}` });
const node = (id = "n"): CanvasNode => ({
    id, type: "video.gen", x: 0, y: 0, w: 240, h: 200, parentId: null, parentScriptId: null,
    data: {
        input: { images: [image("a", "刘备", "C1"), image("b", "曹操", "C2")], videos: [image("v", "镜头")], audios: [{ ...image("voice", "声音"), voiceForAssetId: "C1" }] },
        params: { prompt: "【素材图例】@Image1 是 刘备，身着红衣；@Image2 是 曹操，背对镜头；@Video1 是 镜头；@Image1的声音参考@Audio1；\n\n@Image1走向@Image2，参考@Video1和@Audio1。", method: "frames", officialAssetIndexes: [0], duration: 20 },
        resultAssetId: null,
    },
});
const save = vi.fn();
const key = (materialKey: string) => nodeMaterialGalleryEntries("n").find(it => it.entry.key === materialKey)!.id;
const swap = (source = createNodeMaterialLightboxSource("n")) => source.reorder!(key("s:b"), key("s:a"));

beforeEach(() => {
    useLightboxStore.getState().close();
    save.mockClear();
    useProjectStore.setState({ projectInstanceId: "owner-a", isProjectLoading: false, canvasEpisodeId: "ep1", episodes: [
        { id: "ep1", index: 1, title: "第一集", scriptText: "", shots: [] },
        { id: "ep2", index: 2, title: "第二集", scriptText: "", shots: [] },
    ], characters: [{ id: "C1", name: "刘备", image: "mem://a", variants: [] }, { id: "C2", name: "曹操", image: "mem://b", variants: [] }], crowds: [], scenes: [], organisms: [], items: [], assetBlobs: {}, savePath: null, scheduleAutoSave: save } as never);
    useCanvasStore.setState({ nodes: { n: node() }, edges: {}, runtime: {}, past: [], future: [] });
    useLibraryStore.setState({ assets: {} });
    useUiStore.setState({ canvasMode: null });
    useUploadStore.setState({ pending: {} });
    usePromptModalStore.getState().close();
});
afterEach(() => useLightboxStore.getState().close());

describe("画布素材排序", () => {
    it("图片调序同步正文、定制图例、声音配对和官方人像，首尾帧沿新图片1/2提交", () => {
        const original = useCanvasStore.getState().nodes.n;
        swap();
        const next = useCanvasStore.getState().nodes.n;
        expect(listNodeMaterials("n").filter(it => it.media === "image").map(it => [it.id, it.tag])).toEqual([["b", "@Image1"], ["a", "@Image2"]]);
        expect(splitLegendPrompt(String(next.data.params.prompt)).body).toBe("@Image2走向@Image1，参考@Video1和@Audio1。");
        expect(next.data.params.prompt).toContain("@Image2 是 刘备，身着红衣；");
        expect(next.data.params.prompt).toContain("@Image1 是 曹操，背对镜头；");
        expect(next.data.params.prompt).toContain("@Image2的声音参考@Audio1；");
        expect(next.data.params.officialAssetIndexes).toEqual([1]);
        expect(next.data.params.method).toBe("frames");
        expect(next.data.params.duration).toBe(20);
        expect(next.data.input).toBe(original.data.input);
        expect(save).toHaveBeenCalledExactlyOnceWith("canvas");
        // 保存再读回依旧走 matOrder，不改变 input 或上游连线的存储身份。
        useCanvasStore.setState({ nodes: { n: JSON.parse(JSON.stringify(next)) } });
        expect(listNodeMaterials("n").filter(it => it.media === "image").map(it => it.id)).toEqual(["b", "a"]);
    });

    it("连线素材与本地素材混排，不重排/断开边，视频和音频各自编号", () => {
        const n = node();
        n.data.params.prompt = "@Image1在左，@Image2居中，@Image3在右，@Video1配@Audio1。";
        n.data.params.officialAssetIndexes = [0];
        const up = node("up"); up.data.resultAssetId = "up-asset"; up.data.title = "上游参考";
        const edges = { edge: { id: "edge", kind: "dataflow" as const, source: "up", sourcePort: "out", target: "n", targetPort: "in" } };
        useLibraryStore.setState({ assets: { "up-asset": { id: "up-asset", kind: "image", uri: "mem://up", name: "图", serverAssetId: "up-server" } } as never });
        useCanvasStore.setState({ nodes: { n, up }, edges });
        const source = createNodeMaterialLightboxSource("n");
        source.reorder!(key("e:edge"), key("s:b"));
        expect(listNodeMaterials("n").map(it => [it.key, it.tag])).toEqual([["s:a", "@Image1"], ["s:b", "@Image2"], ["e:edge", "@Image3"], ["s:v", "@Video1"], ["s:voice", "@Audio1"]]);
        expect(splitLegendPrompt(String(useCanvasStore.getState().nodes.n.data.params.prompt)).body).toBe("@Image3在左，@Image1居中，@Image2在右，@Video1配@Audio1。");
        expect(useCanvasStore.getState().nodes.n.data.params.officialAssetIndexes).toEqual([2]);
        expect(useCanvasStore.getState().edges).toBe(edges);
    });

    it.each(["legend", "inline", "both"] as const)("%s 模式重排保留可逆正文和定制说明，后续图例同步不会回退", mode => {
        useCanvasStore.getState().updateNodeParams("n", { materialPrompt: { mode, retained: nodePromptMaterials("n"), previous: nodePromptMaterials("n") }, prompt: "【素材图例】@Image1 是 刘备，红衣；@Image2 是 曹操，黑衣；\n\n刘备走向曹操。" });
        swap();
        syncNodeLegend("n");
        const text = String(useCanvasStore.getState().nodes.n.data.params.prompt);
        expect(splitLegendPrompt(text).body).toBe("刘备走向曹操。");
        if (mode === "inline") expect(text).not.toContain("【素材图例】");
        else expect(text).toContain("@Image2 是 刘备，红衣；");
        expect(splitLegendPrompt(compileNodeMaterialPrompt("n", text)).body).toBe(mode === "legend" ? "刘备走向曹操。" : "@Image2走向@Image1。");
    });

    it("未配置人像索引仍未配置，明确空选择仍为空", () => {
        const n = node(); delete n.data.params.officialAssetIndexes;
        useCanvasStore.setState({ nodes: { n } });
        swap();
        expect(useCanvasStore.getState().nodes.n.data.params).not.toHaveProperty("officialAssetIndexes");
        useCanvasStore.getState().updateNodeParams("n", { officialAssetIndexes: [] });
        swap();
        expect(useCanvasStore.getState().nodes.n.data.params.officialAssetIndexes).toEqual([]);
    });

    it("PromptModal 使用最新未保存草稿重映射，不把草稿提前写入节点", () => {
        usePromptModalStore.getState().openPrompt({ nodeId: "n", value: "初始草稿" });
        let draft = "打开灯箱时的旧草稿";
        const source = createNodeMaterialLightboxSource("n", { promptApi: { insertAtCursor: vi.fn(), getValue: () => draft, setValue: value => { draft = value; } } });
        draft = "【素材图例】@Image1 是 刘备，草稿备注；@Image2 是 曹操；\n\n未保存：@Image1跑向@Image2！";
        swap(source);
        expect(splitLegendPrompt(draft).body).toBe("未保存：@Image2跑向@Image1！");
        expect(draft).toContain("@Image2 是 刘备，草稿备注；");
        expect(useCanvasStore.getState().nodes.n.data.params.prompt).not.toContain("未保存");
        expect(useCanvasStore.getState().nodes.n.data.params.prompt).not.toContain("草稿备注");
    });
});

describe("画布素材灯箱来源", () => {
    it("打开指定素材、左右切换、拖后保持当前素材，实时编号与图片/视频/音频标签一致", () => {
        const activeId = key("s:b");
        openNodeMaterialLightbox("n", activeId);
        expect(useLightboxStore.getState().item).toMatchObject({ id: activeId, name: "曹操", label: "图片2" });
        useLightboxStore.getState().move(1);
        expect(useLightboxStore.getState().item?.label).toBe("视频1");
        useLightboxStore.getState().move(1);
        expect(useLightboxStore.getState().item?.label).toBe("音频1");
        useLightboxStore.getState().select(activeId);
        useLightboxStore.getState().reorder(activeId, key("s:a"));
        expect(useLightboxStore.getState().item).toMatchObject({ id: activeId, name: "曹操", label: "图片1" });
        expect(useLightboxStore.getState().index).toBe(0);
    });

    it("订阅实时本地映射更新，关闭后解除来源订阅", () => {
        const source = createNodeMaterialLightboxSource("n");
        const notify = vi.fn();
        const dispose = source.subscribe!(notify);
        useProjectStore.setState({ assetBlobs: { a: { id: "a", localUri: "mem://repaired", url: "https://example.test/a" } } as never });
        expect(source.getItems()?.[0].uri).toBe("mem://repaired");
        expect(notify).toHaveBeenCalled();
        dispose(); notify.mockClear();
        useUiStore.setState({ canvasMode: null });
        expect(notify).not.toHaveBeenCalled();
    });

    it.each(["project", "canvas", "delete", "loading"])("%s 失效立即关闭，旧回调不能改同名节点", reason => {
        const source = createNodeMaterialLightboxSource("n");
        const fromId = key("s:b"), toId = key("s:a");
        useLightboxStore.getState().openGallery(source, fromId);
        if (reason === "project") useProjectStore.setState({ projectInstanceId: "owner-b" });
        if (reason === "canvas") useProjectStore.setState({ canvasEpisodeId: "ep2" });
        if (reason === "delete") useCanvasStore.setState({ nodes: {} });
        if (reason === "loading") useProjectStore.setState({ isProjectLoading: true });
        expect(useLightboxStore.getState().item).toBeNull();
        useProjectStore.setState({ projectInstanceId: "owner-a", canvasEpisodeId: "ep1", isProjectLoading: false });
        useCanvasStore.setState({ nodes: { n: node() } });
        source.reorder!(fromId, toId);
        expect(source.getItems()).toBeNull();
        expect(useCanvasStore.getState().nodes.n.data.matOrder).toBeUndefined();
    });

    it("已有素材仍可预览，生成忙碌/待受理/多选/上传期间拒绝重排，结束后可恢复", () => {
        const source = createNodeMaterialLightboxSource("n");
        for (const status of ["running", "queued", "scheduled", "uploading"] as const) {
            useCanvasStore.setState({ runtime: { n: { status, progress: 0, taskId: null, scheduledAt: null, error: null } } });
            swap(source);
            expect(source.canReorder!()).toBe(false);
            expect(source.getItems()).toHaveLength(4);
            expect(useCanvasStore.getState().nodes.n.data.matOrder).toBeUndefined();
        }
        useCanvasStore.setState({ runtime: {} });
        useUiStore.setState({ canvasMode: { type: "asset-pick", targetNodeId: "n", materialGroupId: null } });
        swap(source); expect(source.canReorder!()).toBe(false);
        useUiStore.setState({ canvasMode: null });
        useUploadStore.getState().begin(uploadKeys.node("n"));
        swap(source); expect(source.canReorder!()).toBe(false);
        useUploadStore.getState().end(uploadKeys.node("n"));
        expect(source.canReorder!()).toBe(true);
        swap(source); expect(save).toHaveBeenCalledOnce();
    });

    it("PromptModal 换次打开后旧灯箱不能写新草稿或节点", () => {
        usePromptModalStore.getState().openPrompt({ nodeId: "n", value: "原稿" });
        const setValue = vi.fn();
        const source = createNodeMaterialLightboxSource("n", { promptApi: { insertAtCursor: vi.fn(), getValue: () => "旧草稿", setValue } });
        usePromptModalStore.getState().openPrompt({ nodeId: "n", value: "新稿" });
        swap(source);
        expect(source.getItems()).toBeNull();
        expect(setValue).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
    });

    it("相同 URI 的不同引用不合并；异常重复 key 仍显示独立卡但禁重排", () => {
        const n = node();
        n.data.input.images = [image("a", "刘备"), { ...image("b", "曹操"), url: "mem://a" }];
        useCanvasStore.setState({ nodes: { n } });
        const source = createNodeMaterialLightboxSource("n");
        expect(source.getItems()?.filter(it => it.media === "image")).toHaveLength(2);
        expect(source.canReorder!()).toBe(true);
        n.data.input.images = [image("a", "刘备"), image("a", "重复旧数据")];
        useCanvasStore.setState({ nodes: { n: { ...n } } });
        const items = source.getItems()!;
        expect(new Set(items.map(it => it.id)).size).toBe(items.length);
        expect(source.canReorder!()).toBe(false);
        expect(reorderNodeMaterial("n", "s:a", "s:v")).toBeNull();
        expect(save).not.toHaveBeenCalled();
    });
});
