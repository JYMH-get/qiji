/**
 * fileStorage.ts — Tauri 文件存储服务
 *
 * 职责：
 *   - 调用 Tauri dialog.open() 弹出原生文件选择对话框
 *   - 将选中文件复制到 AppData/Qiji/files/ 永久保存
 *   - 生成 convertFileSrc 可用的路径供 <img>/<video> 直接渲染
 *   - 删除孤立文件（节点删除时级联清理）
 *
 * 降级策略：若 Tauri API 不可用（纯浏览器环境），降级为 FileReader dataURL。
 */
import type { FileInfo } from "@/types";
import { genId } from "@/lib/id";
import { useProjectStore } from "@/store/projectStore";

async function getProjectAssetsDirTauri(): Promise<string> {
  const savePath = await useProjectStore.getState().ensureProjectPath();
  const folder = savePath.replace(/[/\\][^/\\]+$/, "");
  const { join, mkdir, exists } = await getTauriApis();
  const assetsDir = await join(folder, "assets");
  if (!(await exists(assetsDir))) {
    await mkdir(assetsDir, { recursive: true });
  }
  return assetsDir;
}

// 运行时检测是否在 Tauri 环境
function isTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

// 动态 import Tauri API（避免在浏览器环境下报错）
async function getTauriApis() {
  const [{ open }] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
  ]);
  const { copyFile, remove, exists, mkdir, writeFile, readFile } = await import("@tauri-apps/plugin-fs");
  const { appDataDir, join } = await import("@tauri-apps/api/path");
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return { open, copyFile, remove, exists, mkdir, writeFile, readFile, appDataDir, join, convertFileSrc };
}

/** 计算二进制内容的 SHA-256 哈希值 */
async function getFileHash(buffer: ArrayBuffer | ArrayBufferLike): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", new Uint8Array(buffer) as any);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}



/**
 * 打开原生文件选择对话框，将选中文件复制到 AppData 并返回 FileInfo。
 * 浏览器降级：弹出 <input> 并用 FileReader 读 dataURL。
 */
export async function pickAndStoreFile(): Promise<FileInfo | null> {
  if (isTauri()) {
    return pickAndStoreTauri();
  }
  return pickAndStoreBrowser();
}

async function pickAndStoreTauri(): Promise<FileInfo | null> {
  const { open, copyFile, join, convertFileSrc, readFile, exists } = await getTauriApis();

  const selected = await open({
    multiple: false,
    filters: [
      { name: "媒体文件", extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg",
          "mp4", "mov", "webm", "mkv", "avi",
          "mp3", "wav", "ogg", "flac", "aac", "m4a"] },
    ],
  }) as string | null;

  if (!selected) return null;

  const bytes = await readFile(selected);
  const hash = await getFileHash(bytes.buffer);
  const ext = selected.split(".").pop()?.toLowerCase() ?? "bin";
  const fileId = `sha256-${hash}`;
  const srcName = selected.split(/[/\\]/).pop() ?? "file";

  const assetsDir = await getProjectAssetsDirTauri();

  const cleanName = srcName.replace(/[\\/:*?"<>|]/g, "_");
  const destName = `${fileId}_${cleanName}`;
  const destPath = await join(assetsDir, destName);

  if (!(await exists(destPath))) {
    await copyFile(selected, destPath);
  }

  const mime = guessMime(ext);

  return {
    fileId,
    fileName: srcName,
    fileMime: mime,
    fileUri: convertFileSrc(destPath),
    localPath: destPath,
  };
}

function pickAndStoreBrowser(): Promise<FileInfo | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,video/*,audio/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = async (e) => {
        const uri = e.target?.result as string;
        // 计算 hash 并在浏览器环境下识别
        let hash = "";
        try {
          const buffer = await file.arrayBuffer();
          hash = await getFileHash(buffer);
        } catch {}
        resolve({
          fileId: hash ? `sha256-${hash}` : genId("file"),
          fileName: file.name,
          fileMime: file.type,
          fileUri: uri,
          localPath: null,
        });
      };
      reader.readAsDataURL(file);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export async function storeDroppedFile(file: File): Promise<FileInfo | null> {
  if (isTauri()) {
    try {
      const { copyFile, writeFile, join, convertFileSrc, readFile, exists } = await getTauriApis();
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "bin";
      const nativePath = (file as any).path;

      let bytes: Uint8Array;
      if (typeof nativePath === "string" && nativePath.length > 0) {
        bytes = await readFile(nativePath);
      } else {
        const buffer = await file.arrayBuffer();
        bytes = new Uint8Array(buffer);
      }

      const hash = await getFileHash(bytes.buffer);
      const fileId = `sha256-${hash}`;

      const assetsDir = await getProjectAssetsDirTauri();
      const cleanName = file.name.replace(/[\\/:*?"<>|]/g, "_");
      const destName = `${fileId}_${cleanName}`;
      const destPath = await join(assetsDir, destName);

      if (!(await exists(destPath))) {
        if (typeof nativePath === "string" && nativePath.length > 0) {
          await copyFile(nativePath, destPath);
        } else {
          await writeFile(destPath, bytes);
        }
      }

      const mime = guessMime(ext);

      return {
        fileId,
        fileName: file.name,
        fileMime: mime,
        fileUri: convertFileSrc(destPath),
        localPath: destPath,
      };
    } catch (err) {
      console.error("Failed to store dropped file", err);
      return null;
    }
  } else {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        const uri = e.target?.result as string;
        let hash = "";
        try {
          const buffer = await file.arrayBuffer();
          hash = await getFileHash(buffer);
        } catch {}
        resolve({
          fileId: hash ? `sha256-${hash}` : genId("file"),
          fileName: file.name,
          fileMime: file.type,
          fileUri: uri,
          localPath: null,
        });
      };
      reader.readAsDataURL(file);
    });
  }
}


/**
 * 删除 AppData 中存储的文件（节点删除时调用）。
 * 浏览器环境下无操作（dataURL 跟随 GC）。
 */
export async function deleteStoredFile(localPath: string | null): Promise<void> {
  if (!localPath || !isTauri()) return;
  try {
    const { remove } = await getTauriApis();
    await remove(localPath);
  } catch {
    // 文件已不存在，忽略
  }
}

/** 根据文件扩展名猜测 MIME */
function guessMime(ext: string): string {
  const map: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
    mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
    mkv: "video/x-matroska", avi: "video/x-msvideo",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
    flac: "audio/flac", aac: "audio/aac", m4a: "audio/mp4",
  };
  return map[ext] ?? "application/octet-stream";
}
