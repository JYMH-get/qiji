import type { AssetRef, CatalogModel } from '@/contract';
import { managedClient } from './managedClient';
import { useConnectionStore } from '@/store/connectionStore';
import { createMaterialPreparationController } from './materialPreparation';
import { uploadToNyxenAccelerationBucket, verifyNyxenAccelerationUrl, type NyxenMaterialKind } from './nyxenAcceleration';

const STORAGE = 'Qiji:materialAcceleration:v1';
const session = () => {
 const s = useConnectionStore.getState();
 return `${s.serverUrl}\n${s.accessKey}`;
};
export const nyxenMaterialKey = (asset: AssetRef, kind: NyxenMaterialKind, owner = session(), route?: string) => JSON.stringify([owner, route, kind, asset.id || asset.url]);
export const supportsNyxenMaterials = (model?: CatalogModel) => model?.capability === 'video' && model.materialPolicy?.kind === 'nyxen';

type RecordEntry = { url: string; createdAt: number };
const records = new Map<string, RecordEntry>();
const aliases = new Map<string, string>();
async function diskKey(key: string) {
 const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
 return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
function loadRecords(): Record<string, RecordEntry> {
 try { return JSON.parse(localStorage.getItem(STORAGE) || '{}'); } catch { return {}; }
}
async function readRecord(key: string) {
 if (records.has(key)) return records.get(key);
 const value = loadRecords()[await diskKey(key)];
 if (value && typeof value.url === 'string' && /^https?:\/\//i.test(value.url)) { records.set(key, value); return value; }
}
async function saveRecord(key: string, value?: RecordEntry) {
 const hash = await diskKey(key), stored = loadRecords();
 if (value) { records.set(key, value); stored[hash] = value; } else { records.delete(key); delete stored[hash]; }
 const recent = Object.entries(stored).filter(([, v]) => v && typeof v.createdAt === 'number').sort((a,b) => b[1].createdAt-a[1].createdAt).slice(0,512);
 try { localStorage.setItem(STORAGE, JSON.stringify(Object.fromEntries(recent))); } catch { /* Memory cache still works when storage is unavailable. */ }
}
let running = 0;
const waiting: Array<() => void> = [];
async function limited<T>(work: () => Promise<T>): Promise<T> {
 if (running >= 3) await new Promise<void>(resolve => waiting.push(resolve)); else running++;
 try { return await work(); } finally { const next = waiting.shift(); if (next) next(); else running--; }
}
export const nyxenMaterialController = createMaterialPreparationController(async (selection, asset, _retry, control) => {
 const [kind, route] = selection.startsWith('[') ? JSON.parse(selection) as [NyxenMaterialKind, string?] : [selection as NyxenMaterialKind, undefined];
 const owner = session(), key = nyxenMaterialKey(asset, kind, owner, route);
 control?.phase('checking');
 const cached = await readRecord(key);
 if (cached && await limited(() => verifyNyxenAccelerationUrl(cached.url))) {
  if (asset.url) aliases.set(nyxenMaterialKey({ url: asset.url }, kind, owner, route), key);
  return { status: 'Active', checkedAt: Date.now(), scopeKey: 'nyxen', accelerationUrl: cached.url };
 }
 if (cached) await saveRecord(key);
 const upload = async () => limited(async () => {
  const { ensurePublicUrl, isPublicUrl } = await import('@/lib/publicUrl');
  let url = asset.url ?? '';
  if (asset.id && !asset.id.startsWith('LC-')) {
   try { url = await managedClient.resolveAssetUrl(asset.id); }
   catch (error) { if (!url) throw error; }
  }
  // WebView 的 http://asset.localhost 是本地文件显示地址，原生 HTTP 客户端不能读取。
  if (!isPublicUrl(url)) {
   url = await ensurePublicUrl(url, { name: asset.name }) || '';
  }
  if (!isPublicUrl(url)) throw new Error('素材尚无可用公网地址');
  const accelerationUrl = await uploadToNyxenAccelerationBucket(url, kind);
  if (!/^https?:\/\//i.test(accelerationUrl)) throw new Error('加速桶未返回有效链接');
  await saveRecord(key, { url: accelerationUrl, createdAt: Date.now() });
  if (asset.url) aliases.set(nyxenMaterialKey({ url: asset.url }, kind, owner, route), key);
  aliases.set(nyxenMaterialKey({ url }, kind, owner, route), key);
  return { status: 'Active' as const, checkedAt: Date.now(), scopeKey: 'nyxen', accelerationUrl };
 });
 control?.phase('uploading');
 return control ? control.upload(upload) : upload();
}, { maxAgeMs: Infinity, recheckOnSubscribe: true });

export function cachedNyxenMaterial(asset: AssetRef, kind: NyxenMaterialKind, route?: string): string | undefined {
 const key = nyxenMaterialKey(asset, kind, session(), route);
 return nyxenMaterialController.peek(key)?.accelerationUrl
  ?? (!asset.id && aliases.has(key) ? nyxenMaterialController.peek(aliases.get(key)!)?.accelerationUrl : undefined);
}
export async function prepareNyxenMaterial(asset: AssetRef, kind: NyxenMaterialKind, route?: string): Promise<string> {
 const cached = cachedNyxenMaterial(asset, kind, route); if (cached) return cached;
 const state = await nyxenMaterialController.check(nyxenMaterialKey(asset, kind, session(), route), JSON.stringify([kind, route]), asset, 'nyxen');
 if (state.status !== 'Active' || !state.accelerationUrl) throw new Error(state.error || '素材仍在准备，请稍后重试');
 return state.accelerationUrl;
}

