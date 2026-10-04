import { beforeEach, describe, expect, it } from "vitest";
import { useProjectStore } from "@/store/projectStore";
import { useCanvasStore } from "@/store/canvasStore";
import { useAssetFormStore } from "@/store/assetFormStore";
import { useLibraryStore } from "@/store/libraryStore";
import { compileMaterialPrompt, materialPromptTokens, syncMaterialPrompt, type MaterialPromptState } from "./materialPrompt";
import { addNodeMaterialFromAsset, compileNodeMaterialPrompt, cycleNodeMaterialPrompt, removeNodeMaterial, syncNodeLegend } from "@/canvas/nodeMaterials";
import { stripLegend } from "./shotMaterials";
import type { ShotMaterial } from "@/services/projectFile";
const liu: ShotMaterial = { id: "l", assetId: "C1", name: "刘备", uri: "mem://liu", kind: "character" };
const cao: ShotMaterial = { id: "c", assetId: "C2", name: "曹操", uri: "mem://cao", kind: "character" };
const body = "记忆梳理：刘备与曹操站定，玄德转身。\n刘备：曹操去了医院。";
const initial: MaterialPromptState = { mode: "legend", retained: [], previous: [liu, cao] };
beforeEach(() => {
    useProjectStore.setState({ characters: [
        { id: "C1", name: "刘备/玄德", image: liu.uri, variants: [] },
        { id: "C2", name: "曹操", image: cao.uri, variants: [] },
    ], crowds: [], scenes: [], organisms: [], items: [], assetBlobs: {}, savePath: null } as never);
    useAssetFormStore.setState({ selForm: {} });
    useLibraryStore.setState({ assets: {} });
});
describe("三种素材图例转换模式", () => {
    it("成对白结束后的文字恢复高亮与正文引用转换", () => {
        const text = "刘备说：{曹操快来！}对白结束后，曹操转身。";
        for (const mode of ["inline", "both"] as const) {
            const next = syncMaterialPrompt(text, [liu, cao], initial, mode);
            const compiled = stripLegend(compileMaterialPrompt(next.prompt, [liu, cao], next.state));
            expect(compiled).toBe("@Image1说：{曹操快来！}对白结束后，@Image2转身。");
        }
    });
    it("图例前缀保留正文与改过的资产说明", () => {
        const text = `【素材图例】@Image1 是 刘备，身穿战甲；\n\n${body}`;
        const next = syncMaterialPrompt(text, [liu, cao], initial);
        expect(next.prompt).toContain("是 刘备，身穿战甲；");
        expect(next.prompt).toContain("@Image2 是 曹操；");
        expect(stripLegend(next.prompt)).toBe(body);
        expect(materialPromptTokens(next.prompt, [liu, cao], next.state)).toEqual([]);
    });
    it("正文替换无图例，同一角色别名保留还原文字，排除对白", () => {
        const next = syncMaterialPrompt(body, [liu, cao], initial, "inline");
        expect(next.prompt).toBe(body);
        expect(materialPromptTokens(next.prompt, [liu, cao], next.state).map(t => [t.original, t.tag])).toEqual([
            ["刘备", "@Image1"], ["曹操", "@Image2"], ["玄德", "@Image1"], ["刘备", "@Image1"],
        ]);
        expect(compileMaterialPrompt(next.prompt, [liu, cao], next.state)).toBe("记忆梳理：@Image1与@Image2站定，@Image1转身。\n@Image1：曹操去了医院。");
    });
    it("正文模式删除素材保留灰色引用及主体，剩余素材按身份重编号", () => {
        const next = syncMaterialPrompt(body, [liu, cao], initial, "inline");
        const removed = syncMaterialPrompt(next.prompt, [cao], next.state);
        const tokens = materialPromptTokens(removed.prompt, [cao], removed.state);
        expect(tokens.map(t => t.tag)).toEqual([undefined, "@Image1", undefined, undefined]);
        expect(removed.prompt).toBe(body);
        expect(compileMaterialPrompt(removed.prompt, [cao], removed.state)).toBe("记忆梳理：刘备与@Image1站定，玄德转身。\n刘备：曹操去了医院。");
        const readded = syncMaterialPrompt(removed.prompt, [cao, liu], removed.state);
        expect(materialPromptTokens(readded.prompt, [cao, liu], readded.state).map(t => t.tag)).toEqual(["@Image2", "@Image1", "@Image2", "@Image2"]);
    });
    it("两者都要：图例随增删，正文引用消失后还原、加回后转换", () => {
        const next = syncMaterialPrompt(body, [liu, cao], initial, "both");
        const removed = syncMaterialPrompt(next.prompt, [cao], next.state);
        expect(removed.prompt).toBe(`【素材图例】@Image1 是 曹操；\n\n${body}`);
        expect(materialPromptTokens(removed.prompt, [cao], removed.state).map(t => t.original)).toEqual(["曹操"]);
        const readded = syncMaterialPrompt(removed.prompt, [cao, liu], removed.state);
        expect(materialPromptTokens(readded.prompt, [cao, liu], readded.state).map(t => t.tag)).toEqual(["@Image2", "@Image1", "@Image2", "@Image2"]);
    });
    it("来回切换、清空素材及重复同步不删标点、不丢句子、不堆叠图例", () => {
        let next = syncMaterialPrompt(body, [liu, cao], initial, "inline");
        for (const mode of ["both", "legend", "inline", "both", "legend"] as const) {
            next = syncMaterialPrompt(next.prompt, [liu, cao], next.state, mode);
            expect(stripLegend(next.prompt)).toBe(body);
            expect(syncMaterialPrompt(next.prompt, [liu, cao], next.state)).toEqual(next);
        }
        expect(syncMaterialPrompt(next.prompt, [], next.state).prompt).toBe(body);
    });
    it("手输的旧编号引用绑定原资产，删除后保留名称不会变成其他角色", () => {
        const next = syncMaterialPrompt("@Image1带@Image2进入院子", [cao], { ...initial, mode: "both" });
        expect(stripLegend(next.prompt)).toBe("刘备带曹操进入院子");
        expect(compileMaterialPrompt(next.prompt, [cao], next.state)).toContain("刘备带@Image1进入院子");
    });
    it("状态经过项目JSON持久化后仍能恢复缺失素材样式和原始人名", () => {
        const next = syncMaterialPrompt(body, [liu, cao], initial, "inline");
        const restored = JSON.parse(JSON.stringify(syncMaterialPrompt(next.prompt, [], next.state)));
        expect(materialPromptTokens(restored.prompt, [], restored.state)).toHaveLength(4);
        expect(compileMaterialPrompt(restored.prompt, [], restored.state)).toBe(body);
    });
});
describe("画布模式存储和素材入口", () => {
    beforeEach(() => useCanvasStore.setState({ nodes: { n: { id: "n", type: "video.gen", x: 0, y: 0, w: 240, h: 200, parentId: null, parentScriptId: null, data: { params: { prompt: body }, input: { images: [{ assetId: "C1", url: liu.uri, name: liu.name }, { assetId: "C2", url: cao.uri, name: cao.name }] }, resultAssetId: null } } }, edges: {}, matOrder: [], runtime: {} } as never));
    it("1→2→3→1 持久化，删除与重加沿用当前模式", () => {
        cycleNodeMaterialPrompt("n");
        expect(useCanvasStore.getState().nodes.n.data.params.materialPrompt).toMatchObject({ mode: "inline" });
        removeNodeMaterial("n", "images", 0);
        expect(useCanvasStore.getState().nodes.n.data.params.prompt).toBe(body);
        expect(compileNodeMaterialPrompt("n", body)).toContain("刘备与@Image1");
        cycleNodeMaterialPrompt("n");
        expect(useCanvasStore.getState().nodes.n.data.params.prompt).toContain("@Image1 是 曹操；");
        addNodeMaterialFromAsset("n", { assetId: "C1", url: liu.uri, name: liu.name });
        expect(compileNodeMaterialPrompt("n", body)).toContain("@Image2与@Image1");
        cycleNodeMaterialPrompt("n");
        expect(useCanvasStore.getState().nodes.n.data.params.materialPrompt).toMatchObject({ mode: "legend" });
        expect(stripLegend(String(useCanvasStore.getState().nodes.n.data.params.prompt))).toBe(body);
        expect(syncNodeLegend("n")).toBe(false);
    });
});
