import { seedanceModelFamily, type GenerateRequest } from '../contract';

/** Copy legacy image indexes onto references without changing the original inputs or parameters. */
export function normalizeIdentityInputs(inputs: GenerateRequest['inputs'], legacy: unknown): GenerateRequest['inputs'] {
  if (!inputs?.images || !Array.isArray(legacy)) return inputs;
  const indexes = new Set(legacy.filter((i): i is number => Number.isInteger(i) && i >= 0));
  return { ...inputs, images: inputs.images.map((ref, index) => ({ ...ref, usage: ref.usage ?? (indexes.has(index) ? 'identity' : 'reference') })) };
}
/** Routing reads request parameters for selection and pricing; it must not filter their contents. */
export function routeParams(params: Record<string, unknown>, _capability?: string, _fields?: readonly { key: string }[]): Record<string, unknown> {
  return { ...params };
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
