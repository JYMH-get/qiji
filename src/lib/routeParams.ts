import { seedanceModelFamily } from '../contract';
/** Project/node state contains UI fields. The public line wire contract contains only generation parameters. */
export function routeParams(params: Record<string, unknown>, capability?: string): Record<string, unknown> {
  const keys = capability === 'image' ? ['aspect_ratio', 'resolution', 'quality', 'assetName', 'idPrefix'] : ['duration', 'resolution', 'aspect_ratio', 'method', 'firstFrameUrl', 'assetName', 'idPrefix'];
  return Object.fromEntries(keys.filter(key => params[key] !== undefined).map(key => [key, params[key]]));
}

/** Retired Seedance selections retain their model version; never substitute another family. */
export function migratedRouteKey(key: string | undefined, options: { id: string; familyId?: string }[], routedFamilies?: string[]): string | undefined {
  if (!key || !routedFamilies?.length) return undefined;
  let familyId: string | undefined;
  if (seedanceModelFamily(key)) familyId=seedanceModelFamily(key);
  else if (/gpt[- ]?image|^image2$/i.test(key)) familyId='fam-gpt-image-2';
  else if (/banana/i.test(key)) familyId=/pro/i.test(key)?'fam-nano-banana-pro':/banana[- ]?2/i.test(key)?'fam-nano-banana-2':'fam-nano-banana';
  else if (/midjourney-v(7|8\.1|8\.2)/i.test(key)) familyId='fam-mj-v'+key.match(/midjourney-v(7|8\.1|8\.2)/i)![1].replace('.', '-');
  if (!familyId) return undefined;
  if (!routedFamilies.includes(familyId)) return undefined;
  const candidates = options.filter(o => o.familyId === familyId && o.id.startsWith('route:'));
  return (key.startsWith('off-') ? candidates.find(o => o.id.endsWith('-official')) : undefined)?.id ?? candidates[0]?.id ?? '';
}
