/**
 * saveMedia —— 把任意媒体 uri 保存到本地（图片/视频/音频通用）。
 * Tauri：弹「保存」对话框——有本地原件走 copyFile，否则 fetch 字节 writeFile；
 * 浏览器：<a download> 直接下载。供灯箱右击保存、视频界面导出等共用。
 */
import { useProjectStore } from "@/store/projectStore";

function isTauri(): boolean {
    return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/** 从 uri 末尾解析扩展名（忽略 query/hash）；无则空串。 */
function extFromUri(uri: string): string {
    const m = uri.split(/[?#]/)[0].match(/\.([a-zA-Z0-9]{2,5})$/);
    return m ? m[1].toLowerCase() : "";
}

const FILTER_NAME: Record<string, string> = { image: "图片", video: "视频", audio: "音频" };
const FALLBACK_EXT: Record<string, string> = { image: "png", video: "mp4", audio: "mp3" };

/**
 * 保存 uri 到本地。baseName=默认文件名（不含扩展名，自动清非法字符）；media 决定兜底扩展名与对话框过滤。
 * 扩展名优先级：已登记 blob.ext → uri 末尾扩展名 → 按 media 兜底。
 */
export async function saveUriToLocal(uri: string, baseName: string, media: "image" | "video" | "audio" = "image"): Promise<void> {
    if (!uri) return;
    const safe = (baseName || "").replace(/[\\/:*?"<>|]/g, "_").trim() || FILTER_NAME[media] || "文件";
    const blob = useProjectStore.getState().blobByUri(uri);
    const ext = blob?.ext || extFromUri(uri) || FALLBACK_EXT[media] || "bin";
    if (isTauri()) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const dest = await save({ defaultPath: `${safe}.${ext}`, filters: [{ name: FILTER_NAME[media] || "文件", extensions: [ext] }] });
        if (!dest) return;
        const { copyFile, writeFile } = await import("@tauri-apps/plugin-fs");
        if (blob?.localPath) await copyFile(blob.localPath, dest);
        else { const resp = await fetch(uri); await writeFile(dest, new Uint8Array(await resp.arrayBuffer())); }
    } else {
        const a = document.createElement("a"); a.href = uri; a.download = `${safe}.${ext}`; a.click();
    }
}

/** 保存纯文本到本地 .txt（画布文本节点导出用）。Tauri 弹保存对话框；浏览器 <a download>。 */
export async function saveTextToLocal(text: string, baseName: string): Promise<void> {
    if (!text) return;
    const safe = (baseName || "").replace(/[\\/:*?"<>|]/g, "_").trim() || "文本";
    if (isTauri()) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const dest = await save({ defaultPath: `${safe}.txt`, filters: [{ name: "文本", extensions: ["txt"] }] });
        if (!dest) return;
        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        await writeTextFile(dest, text);
    } else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
        a.download = `${safe}.txt`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    }
}
