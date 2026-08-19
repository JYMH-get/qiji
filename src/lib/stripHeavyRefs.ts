/**
 * stripHeavyRefs —— 落盘前把 genMeta/assetRefImages 里的「重量级」垫图引用剥离，防项目文件膨胀。
 *
 * 背景（待办 §7.1，161MB 事故根源）：出图请求详情 genMeta.refs[].uri 与记忆垫图 assetRefImages[].uri
 * 会存 `data:image/...;base64,...`（整张图的字节，单张可达数 MB）或 `blob:`（会话级、刷新即失效）。
 * 这些整段落进 project.Qiji → 文件可膨胀到上百 MB → 保存写盘窗口被拉长、断电截断风险剧增（本轮主线）。
 *
 * 解法（契合「id 是真理、url 是缓存」）：持久化副本里，把 data:/blob: 引用换成**公网 url**
 * （凭 ref.id 在 assetBlobs 里查 OSS/服务端 url），查不到就丢掉重字节、只留 id/name（详情面板仍能
 * 显示「用过哪个资产」，需要缩略图时按 id 重新解析）。blob: 本就刷新即死，丢弃无损。
 *
 * 纯函数、不改传入对象：只作用于持久化副本，当前会话的 store 保留原始 uri 不受影响。
 */
import type { GenMeta, RefImgMemo, AssetBlob } from "@/services/projectFile";
import { isWebviewLocalUri } from "@/lib/publicUrl";

const isHeavy = (u?: string) => !!u && (/^data:/i.test(u) || /^blob:/i.test(u));
const isPublicUrl = (u?: string): u is string =>
  !!u && /^https?:\/\//i.test(u) && !isWebviewLocalUri(u);

/** 凭资产 id 在 assetBlobs 里查一个可用的公网 url（webview 伪域 http://*.localhost 不算公网） */
function publicUrlById(blobs: Record<string, AssetBlob> | undefined, id?: string): string | undefined {
  if (!id || !blobs) return undefined;
  const b = blobs[id];
  return b && isPublicUrl(b.url) ? b.url : undefined;
}

export interface StripResult {
  genMeta: Record<string, GenMeta>;
  assetRefImages: Record<string, RefImgMemo[]>;
  /** 剥掉的重字节引用数（供日志/提示） */
  stripped: number;
}

/**
 * 返回剥离后的 genMeta / assetRefImages 全新对象；stripped=命中并处理的重引用数。
 * 键（genMeta 的图片 uri、assetRefImages 的造型 key）原样保留——重字节只在 refs/memo 的值里。
 */
export function stripHeavyRefs(
  genMeta: Record<string, GenMeta> | undefined,
  assetRefImages: Record<string, RefImgMemo[]> | undefined,
  blobs: Record<string, AssetBlob> | undefined,
): StripResult {
  let stripped = 0;

  const gmOut: Record<string, GenMeta> = {};
  for (const [k, v] of Object.entries(genMeta || {})) {
    const refs = (v.refs || []).map((r) => {
      if (!isHeavy(r.uri)) return r;
      stripped++;
      return { ...r, uri: publicUrlById(blobs, r.id) || "" };
    });
    gmOut[k] = { ...v, refs };
  }

  const ariOut: Record<string, RefImgMemo[]> = {};
  for (const [k, arr] of Object.entries(assetRefImages || {})) {
    ariOut[k] = (arr || []).map((m) => {
      const heavyUri = isHeavy(m.uri);
      const heavyUrl = isHeavy(m.url);
      if (!heavyUri && !heavyUrl) return m;
      if (heavyUri) stripped++;
      const resolved = publicUrlById(blobs, m.id) || (isPublicUrl(m.url) ? m.url : undefined);
      return {
        ...m,
        uri: heavyUri ? (resolved || "") : m.uri,
        url: heavyUrl ? resolved : m.url,
      };
    });
  }

  return { genMeta: gmOut, assetRefImages: ariOut, stripped };
}
