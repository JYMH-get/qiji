import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { useProjectStore } from "@/store/projectStore";
import { genId } from "@/lib/id";
import type { NodeType } from "@/types";

async function getBufferHash(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    buffer,
  );
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getTauriFsApis() {
  const { writeFile, exists, mkdir } = await import("@tauri-apps/plugin-fs");
  const { appDataDir, join } = await import("@tauri-apps/api/path");
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return { writeFile, exists, mkdir, appDataDir, join, convertFileSrc };
}

function resolveAssetKind(type: NodeType): "image" | "video" | "audio" | "script" {
  if (type === "text" || type === "script") return "script";
  if (type === "video") return "video";
  if (type === "audio") return "audio";
  return "image";
}

/** Mock 生成：当节点无真实插件 executor 时，生成 SVG 占位资产 */
export async function runMockGeneration(nodeId: string) {
  const store = useCanvasStore.getState();
  const node = store.nodes[nodeId];
  if (!node) return;

  const type = node.type;
  store.setRuntime(nodeId, { status: "running", progress: 20 });
  await new Promise((r) => setTimeout(r, 400));
  store.setRuntime(nodeId, { status: "running", progress: 60 });
  await new Promise((r) => setTimeout(r, 400));

  const filename = `gen_${type}_${Date.now()}.svg`;
  const isTauri =
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

  let localPath: string | null = null;
  let fileUri = "";
  let hash = "";
  let assetId = "";

  const svgContent = `
<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200">
  <rect width="100%" height="100%" fill="#12141a" rx="10" stroke="#5b8df6" stroke-width="2"/>
  <text x="50%" y="40%" dominant-baseline="middle" text-anchor="middle" fill="#5b8df6" font-family="sans-serif" font-size="14" font-weight="bold">奇迹 (Qiji) 生成成果</text>
  <text x="50%" y="60%" dominant-baseline="middle" text-anchor="middle" fill="#98a2b3" font-family="sans-serif" font-size="11">节点类型: ${type.toUpperCase()}</text>
  <text x="50%" y="75%" dominant-baseline="middle" text-anchor="middle" fill="rgba(255,255,255,0.2)" font-family="sans-serif" font-size="9">ID: ${nodeId}</text>
</svg>
  `.trim();

  const encoder = new TextEncoder();
  const bytes = encoder.encode(svgContent);

  try {
    hash = await getBufferHash(bytes.buffer);
    assetId = `asset-${hash.slice(0, 10) || genId("asset")}`;

    if (isTauri) {
      await useProjectStore.getState().ensureProjectPath();
      const savePath = useProjectStore.getState().savePath!;
      const folder = savePath.replace(/[/\\][^/\\]+$/, "");

      const { writeFile, exists, mkdir, join, convertFileSrc } =
        await getTauriFsApis();
      const assetsDir = await join(folder, "assets");
      if (!(await exists(assetsDir))) {
        await mkdir(assetsDir, { recursive: true });
      }

      const destPath = await join(assetsDir, `${assetId}.svg`);
      await writeFile(destPath, bytes);

      localPath = destPath;
      fileUri = convertFileSrc(destPath);
    } else {
      const blob = new Blob([svgContent], { type: "image/svg+xml" });
      fileUri = URL.createObjectURL(blob);
    }
  } catch (err) {
    console.error("Failed to generate mock asset file", err);
  }

  const asset = {
    id: assetId,
    kind: resolveAssetKind(type),
    name: filename,
    uri: fileUri,
    thumbnailUri: null,
    createdAt: new Date().toISOString(),
    deletedByUser: false,
    localPath,
  };

  useLibraryStore.getState().addAsset(asset);

  const updatedNodes = { ...store.nodes };
  if (updatedNodes[nodeId]) {
    updatedNodes[nodeId] = {
      ...updatedNodes[nodeId],
      data: {
        ...updatedNodes[nodeId].data,
        resultAssetId: assetId,
      },
    };
    useCanvasStore.setState({ nodes: updatedNodes });
  }

  store.setRuntime(nodeId, { status: "success", progress: 100 });

  if (localPath) {
    useProjectStore.getState().addFileRef(assetId, localPath);
  }

  useProjectStore.getState().scheduleAutoSave("history");
}