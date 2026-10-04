export type ProductKind = 'video' | 'image' | 'text' | 'audio' | 'other';
export interface UsageProduct { kind: ProductKind; quantity: number | null; estimated: boolean }
type Obj = Record<string, any>;
const object = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const positive = (v: unknown): number | undefined => {
  if (typeof v !== 'number' && typeof v !== 'string') return;
  const n = Number(v); return Number.isFinite(n) && n > 0 ? n : undefined;
};
export function productKind(purpose?: string): ProductKind | undefined {
  if (!purpose || purpose === 'code.issue') return;
  if (purpose === 'video.generate') return 'video';
  if (purpose === 'image.upscale' || purpose.startsWith('video.')) return 'other';
  if (purpose?.startsWith('image.') || /^asset\.[^.]+\.(image|variant)$/.test(purpose || '')) return 'image';
  if (purpose?.startsWith('audio.')) return 'audio';
  if (/^(script|storyboard|chat)\./.test(purpose || '')) return 'text';
  return 'other';
}
/** Read only output quantity, never wall-clock duration or reference-video billing seconds. */
export function extractUsageProduct(purpose: string | undefined, detail: Obj, previous?: UsageProduct, localExecution = false): UsageProduct | undefined {
  const kind = productKind(purpose); if (!kind) return;
  if (kind === 'text' || kind === 'audio' || kind === 'other') return { kind, quantity: 1, estimated: false };
  if (kind === 'video' && localExecution) {
    const params=object(object(detail.request).params);
    const requested=positive(params.duration)??positive(params.seconds);
    return requested!==undefined ? {kind,quantity:requested,estimated:false} : previous??{kind,quantity:null,estimated:false};
  }
  const response = object(detail.response), result = object(response.result);
  const raw = response.assets ?? result.assets;
  const assets: Obj[] = Array.isArray(raw) ? raw.filter(a => a && typeof a === 'object' && (!a.type || String(a.type).startsWith(kind))) : [];
  if (kind === 'image') return { kind, quantity: assets.length || previous?.quantity || null, estimated: false };
  if (assets.length) {
    const seconds = assets.map(a => positive(object(a.meta).duration) ?? positive(a.duration));
    if (seconds.every(n => n !== undefined)) return { kind, quantity: seconds.reduce<number>((sum,n) => sum+n!,0), estimated: false };
  }
  const body = object(object(detail.upstreamResponse).body);
  const returned = positive(body.duration) ?? positive(object(body.result).duration) ?? positive(object(object(body.data).data).seconds);
  if (returned !== undefined && assets.length <= 1) return { kind, quantity: returned, estimated: false };
  if (previous?.quantity != null && !previous.estimated) return previous;
  const params = object(object(detail.request).params);
  const requested = positive(params.duration) ?? positive(params.seconds);
  if (requested !== undefined) return { kind, quantity: requested * Math.max(1,assets.length), estimated: true };
  return previous ?? { kind, quantity: null, estimated: false };
}
