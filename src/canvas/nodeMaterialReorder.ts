import { useCanvasStore } from "@/store/canvasStore";
import { useProjectStore } from "@/store/projectStore";
import type { ShotMaterial } from "@/services/projectFile";
import { applyLegend, buildLegend, remapBodyTags, TAG_KIND } from "@/lib/shotMaterials";
import { materialPromptState, syncMaterialPrompt } from "@/lib/materialPrompt";
import { listNodeMaterials, type NodeMatEntry } from "./nodeMaterials";

/** 排序只改既有 matOrder；连线、input 引用及首尾帧的“图片 1/2”约定仍由同一枚举消费。 */
export function reorderNodeMaterial(nodeId: string, fromKey: string, toKey: string, draft?: string): { draft?: string } | null {
    const cs = useCanvasStore.getState();
    const node = cs.nodes[nodeId];
    if (!node || fromKey === toKey) return null;
    const before = listNodeMaterials(nodeId);
    // 旧数据若有重复 key，matOrder 无法独立表示它们；继续允许查看，但不猜测要移动哪条引用。
    if (new Set(before.map(it => it.key)).size !== before.length) return null;
    const from = before.findIndex(it => it.key === fromKey);
    const to = before.findIndex(it => it.key === toKey);
    if (from < 0 || to < 0) return null;
    const after = [...before];
    const [moved] = after.splice(from, 1);
    after.splice(to, 0, moved);
    const counts = { image: 0, video: 0, audio: 0 };
    const mapping: Record<string, string> = {};
    const materials: ShotMaterial[] = after.map((it: NodeMatEntry) => {
        mapping[it.tag] = `@${TAG_KIND[it.media]}${++counts[it.media]}`;
        return { id: it.key, kind: "local", name: it.name, uri: it.uri || it.url, media: it.media, assetId: it.assetId, voiceForAssetId: it.voiceForAssetId };
    });
    const presentation = materialPromptState(node.data.params.materialPrompt);
    const transform = (text: string) => {
        const remapped = remapBodyTags(text, mapping);
        // 正文和图例先一起换编号，再按新引用解释；保留自定义图例及可逆人名状态。
        return presentation
            ? syncMaterialPrompt(remapped, materials, { ...presentation, previous: materials })
            : { prompt: applyLegend(remapped, buildLegend(materials, false)), state: undefined };
    };
    const saved = transform(String(node.data.params.prompt || ""));
    const selected = Array.isArray(node.data.params.officialAssetIndexes)
        ? new Set(before.filter(it => it.media === "image" && (node.data.params.officialAssetIndexes as number[]).includes(it.n - 1)).map(it => it.key))
        : null;
    const params = {
        ...node.data.params,
        prompt: saved.prompt,
        ...(saved.state ? { materialPrompt: saved.state } : {}),
        ...(selected ? { officialAssetIndexes: after.filter(it => it.media === "image").flatMap((it, i) => selected.has(it.key) ? [i] : []) } : {}),
    };
    const result = draft === undefined ? {} : { draft: transform(draft).prompt };
    useCanvasStore.setState({ nodes: { ...cs.nodes, [nodeId]: { ...node, data: { ...node.data, matOrder: after.map(it => it.key), params } } } });
    useProjectStore.getState().scheduleAutoSave("canvas");
    return result;
}
