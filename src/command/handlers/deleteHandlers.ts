import { useCanvasStore } from "@/store/canvasStore";
import { useProjectStore } from "@/store/projectStore";
import { commandBus } from "../commandBus";
import { deleteStoredFile } from "@/services/fileStorage";

const store = () => useCanvasStore.getState();

export function registerDeleteHandlers(): void {
  commandBus.register("deleteNode", (c) => {
    if (c.type === "deleteNode") {
      const node = store().nodes[c.id];
      if (node && node.type === "file") {
        const params = node.data?.params ?? {};
        const localPath = typeof params.localPath === "string" ? params.localPath : null;
        const fileId = typeof params.fileId === "string" ? params.fileId : null;
        if (localPath) deleteStoredFile(localPath);
        if (fileId) useProjectStore.getState().removeFileRef(fileId);
      }
      store().removeNode(c.id);
    }
  });
}