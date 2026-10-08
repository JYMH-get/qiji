import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { resolveEpisodeKey, useProjectStore } from "@/store/projectStore";
import { useUiStore } from "@/store/uiStore";
import { uploadKeys, useUploadStore } from "@/store/uploadStore";
import { usePromptModalStore, type PromptModalApi } from "@/store/promptModalStore";
import { openLightboxGallery, type LightboxGallerySource } from "@/store/lightboxStore";
import { listNodeMaterials } from "./nodeMaterials";
import { reorderNodeMaterial } from "./nodeMaterialReorder";

export function nodeMaterialGalleryEntries(nodeId: string) {
    const entries = listNodeMaterials(nodeId);
    const totals = new Map<string, number>();
    const seen = new Map<string, number>();
    entries.forEach(it => totals.set(it.key, (totals.get(it.key) ?? 0) + 1));
    return entries.map(entry => {
        const occurrence = seen.get(entry.key) ?? 0;
        seen.set(entry.key, occurrence + 1);
        return { entry, id: JSON.stringify([entry.key, ...(totals.get(entry.key)! > 1 ? [entry.media, occurrence] : [])]) };
    });
}

interface MaterialLightboxOptions {
    owner?: string;
    canvasKey?: string;
    promptApi?: PromptModalApi;
}

/** 灯箱是当前节点的实时视图；旧项目、旧画布或旧提示词弹窗的回调都不能写到后来同名节点。 */
export function createNodeMaterialLightboxSource(nodeId: string, options: MaterialLightboxOptions = {}): LightboxGallerySource {
    const project = useProjectStore.getState();
    const owner = options.owner ?? project.projectInstanceId;
    const canvasKey = options.canvasKey ?? resolveEpisodeKey(project.canvasEpisodeId, project.episodes);
    const modalSession = options.promptApi ? usePromptModalStore.getState().sessionId : undefined;
    let invalidated = false;
    const current = () => {
        const ps = useProjectStore.getState();
        const modal = usePromptModalStore.getState();
        if (ps.projectInstanceId !== owner || ps.isProjectLoading
            || resolveEpisodeKey(ps.canvasEpisodeId, ps.episodes) !== canvasKey
            || !useCanvasStore.getState().nodes[nodeId]
            || (modalSession !== undefined && (!modal.open || modal.sessionId !== modalSession || modal.nodeId !== nodeId))) invalidated = true;
        return !invalidated;
    };
    const canReorder = () => {
        if (!current() || useUiStore.getState().canvasMode?.type === "asset-pick") return false;
        if (useUploadStore.getState().pending[uploadKeys.node(nodeId)]) return false;
        if (modalSession !== undefined && usePromptModalStore.getState().readOnly) return false;
        const cs = useCanvasStore.getState();
        if (cs.nodes[nodeId].data.task || ["running", "queued", "scheduled", "uploading"].includes(cs.runtime[nodeId]?.status ?? "")) return false;
        const entries = listNodeMaterials(nodeId);
        return entries.length > 1 && new Set(entries.map(it => it.key)).size === entries.length;
    };
    return {
        getItems: () => current() ? nodeMaterialGalleryEntries(nodeId).map(({ entry, id }) => ({
            id, uri: entry.uri || entry.url, media: entry.media, name: entry.name,
            label: `${({ image: "图片", video: "视频", audio: "音频" })[entry.media]}${entry.n}`,
        })) : null,
        canReorder,
        reorder: (fromId, toId) => {
            if (!canReorder()) return;
            const entries = nodeMaterialGalleryEntries(nodeId);
            const from = entries.find(it => it.id === fromId)?.entry;
            const to = entries.find(it => it.id === toId)?.entry;
            if (!from || !to) return;
            const result = reorderNodeMaterial(nodeId, from.key, to.key, options.promptApi?.getValue?.());
            if (result?.draft !== undefined && current()) options.promptApi?.setValue?.(result.draft);
        },
        subscribe: listener => {
            const notify = () => { current(); listener(); };
            const unsubscribes = [useCanvasStore.subscribe(notify), useProjectStore.subscribe(notify), useLibraryStore.subscribe(notify), useUiStore.subscribe(notify), usePromptModalStore.subscribe(notify), useUploadStore.subscribe(notify)];
            return () => unsubscribes.forEach(unsubscribe => unsubscribe());
        },
    };
}

export function openNodeMaterialLightbox(nodeId: string, activeId: string, options?: MaterialLightboxOptions): void {
    openLightboxGallery(createNodeMaterialLightboxSource(nodeId, options), activeId);
}
