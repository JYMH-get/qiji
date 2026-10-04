import { useCanvasStore } from "@/store/canvasStore";
import { useProjectStore } from "@/store/projectStore";

/** Runtime progress and undo bookkeeping are not project content. */
export function startCanvasAutoSave() {
    return useCanvasStore.subscribe((next, prev) => {
        const project = useProjectStore.getState();
        if (project.isProjectLoading || !project.savePath) return;
        if (next.nodes !== prev.nodes || next.edges !== prev.edges ||
            next.groups !== prev.groups || next.viewport !== prev.viewport) {
            project.scheduleAutoSave("canvas");
        }
    });
}
