import type { CanvasNode } from '@/types';
import type { Asset } from '@/store/libraryStore';

export interface SelectedResult {
  name: string;
  uri?: string;
  localPath?: string;
  text?: string;
  media: 'image' | 'video' | 'audio';
}

/** Snapshot only the selected nodes' current results, never their history or inputs. */
export function selectedResults(ids: string[], nodes: Record<string, CanvasNode>, assets: Record<string, Asset>): SelectedResult[] {
  return [...new Set(ids)].flatMap<SelectedResult>(id => {
    const node = nodes[id];
    if (!node || node.type === 'group') return [];
    const data = node.data;
    const asset = data.resultAssetId ? assets[data.resultAssetId] : undefined;
    // A missing current asset must not silently export an older uploaded input instead.
    const uri = data.resultAssetId ? asset?.uri : data.fileUri;
    const name = data.title || asset?.name || data.fileName || `${node.type}_结果`;
    const mime = data.fileMime || '';
    const media = asset?.kind === 'video' || mime.startsWith('video/') ? 'video'
      : asset?.kind === 'audio' || mime.startsWith('audio/') ? 'audio' : 'image';
    if (uri || asset?.localPath) return [{ name, uri, localPath: asset?.localPath || undefined, media }];
    if (data.resultAssetId) return [];
    if (data.resultText?.trim()) return [{ name, text: data.resultText, media }];
    return [];
  });
}

export interface DownloadSummary { ok: number; failures: string[] }

/** Choose one folder and save originals; an individual failure does not stop the batch. */
export async function downloadSelectedResults(items: SelectedResult[], onProgress: (done: number, total: number) => void): Promise<DownloadSummary | null> {
  if (!items.length) return null;
  const { useProjectStore } = await import('@/store/projectStore');
  const { localRefOf } = await import('@/lib/importCopy');
  const { isPublicUrl } = await import('@/lib/publicUrl');
  const snapshot = items.map(item => {
    const blob = item.uri ? useProjectStore.getState().blobByUri(item.uri) : undefined;
    return { ...item, localPath: item.localPath || blob?.localPath || localRefOf(item.uri || '')?.path,
      ext: blob?.ext || (item.uri || item.localPath || '').split(/[?#]/)[0].match(/\.([a-zA-Z0-9]{2,5})$/)?.[1] };
  });
  const { open } = await import('@tauri-apps/plugin-dialog');
  const root = await open({ directory: true, multiple: false, title: '选择批量下载保存目录' });
  if (!root || Array.isArray(root)) return null;
  const { join } = await import('@tauri-apps/api/path');
  const { exists, copyFile, writeFile, writeTextFile } = await import('@tauri-apps/plugin-fs');
  const { invoke } = await import('@tauri-apps/api/core');
  const summary: DownloadSummary = { ok: 0, failures: [] };
  onProgress(0, snapshot.length);
  for (const [index, item] of snapshot.entries()) {
    try {
      const rawExt = item.text !== undefined ? 'txt' : item.ext || ({ image: 'png', video: 'mp4', audio: 'mp3' }[item.media]);
      const ext = /^[a-z0-9]{1,8}$/i.test(rawExt) ? rawExt.toLowerCase() : 'bin';
      let base = item.name.replace(new RegExp(`\\.${ext}$`, 'i'), '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 120) || '节点结果';
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = `_${base}`;
      let dest = await join(root, `${base}.${ext}`);
      for (let suffix = 2; await exists(dest); suffix++) dest = await join(root, `${base} (${suffix}).${ext}`);
      if (item.text !== undefined) await writeTextFile(dest, item.text);
      else if (item.localPath && await exists(item.localPath)) await copyFile(item.localPath, dest);
      else if (item.uri && isPublicUrl(item.uri)) await invoke('download_to', { url: item.uri, dest, skipExisting: false });
      else if (item.uri) {
        const response = await fetch(item.uri);
        if (!response.ok) throw new Error(`读取素材 HTTP ${response.status}`);
        await writeFile(dest, new Uint8Array(await response.arrayBuffer()));
      } else throw new Error('本地原件不存在');
      summary.ok++;
    } catch (error) {
      summary.failures.push(`${item.name}：${error instanceof Error ? error.message : String(error)}`);
    }
    onProgress(index + 1, snapshot.length);
  }
  return summary;
}
