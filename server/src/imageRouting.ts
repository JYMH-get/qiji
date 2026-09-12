import type { ModelDef } from './store/models.ts';
import type { ParamField } from './contract.ts';

export const IMAGE_ROUTE_FAMILIES = [
  { id: 'fam-gpt-image-2', name: 'GPT Image 2' },
  { id: 'fam-nano-banana', name: 'Nano Banana' },
  { id: 'fam-nano-banana-pro', name: 'Nano Banana Pro' },
  { id: 'fam-nano-banana-2', name: 'Nano Banana 2' },
  { id: 'fam-mj-v7', name: 'Midjourney V7' },
  { id: 'fam-mj-v8-1', name: 'Midjourney V8.1' },
  { id: 'fam-mj-v8-2', name: 'Midjourney V8.2' },
  { id: 'fam-grok-image', name: 'Grok Image' },
];
export function imageFamilyOf(m: ModelDef): string | undefined {
  if (m.capability !== 'image') return m.familyId;
  const name = `${m.id} ${m.upstreamModel ?? ''}`.toLowerCase();
  if (m.familyId === 'fam-nano-banana') {
    if (/banana[- ]?pro|3-pro-image/.test(name)) return 'fam-nano-banana-pro';
    if (/banana[- ]?2|3\.1-flash-image/.test(name)) return 'fam-nano-banana-2';
  }
  if (m.familyId === 'fam-mj') {
    const version = name.match(/midjourney-v(7|8\.1|8\.2)/)?.[1];
    if (version) return `fam-mj-v${version.replace('.', '-')}`;
  }
  return m.familyId;
}

/** 用户端图片请求的唯一公共契约。其余尺寸字段都是选定上游后的派生字段。 */
export const IMAGE_PUBLIC_KEYS = ['aspect_ratio', 'resolution', 'quality'];
export const IMAGE_DERIVED_KEYS = ['size', 'imageSize', 'aspectRatio'];
const PUBLIC_ASPECTS = ['1:1', '16:9', '9:16'];
const PUBLIC_RESOLUTIONS = ['1k', '2k', '4k'];
const PIXELS: Record<string, Record<string, string>> = {
  '1:1': { '1k': '1024x1024', '2k': '2048x2048', '4k': '4096x4096' },
  '16:9': { '1k': '1280x720', '2k': '2048x1152', '4k': '3840x2160' },
  '9:16': { '1k': '720x1280', '2k': '1152x2048', '4k': '2160x3840' },
};

function aspectOf(value: unknown): string {
  return String(value ?? '').trim().replace('：', ':').toLowerCase();
}
function resolutionOf(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}
function pairOf(value: string): { w: number; h: number } | undefined {
  const match = value.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  if (!match) return undefined;
  const w = Number(match[1]), h = Number(match[2]);
  return w > 0 && h > 0 ? { w, h } : undefined;
}
function targetRatio(aspect: string): number {
  const [w, h] = aspect.split(':').map(Number);
  return w > 0 && h > 0 ? w / h : 1;
}
function sameOrientation(aspect: string, pair: { w: number; h: number }): boolean {
  return aspect === '1:1' ? pair.w === pair.h : aspect === '16:9' ? pair.w > pair.h : pair.w < pair.h;
}

/** 从管理端该模型的 size 枚举选出最符合公共比例/分辨率的上游值。 */
function configuredSize(m: ModelDef, aspect: string, resolution: string): string | undefined {
  const allowed = m.params.find(p => p.key === 'size')?.options ?? [];
  if (!allowed.length) return undefined;
  if (allowed.includes(aspect)) return aspect;
  const exact = PIXELS[aspect]?.[resolution];
  if (exact && allowed.includes(exact)) return exact;
  const target = targetRatio(aspect);
  const targetPair = pairOf(exact ?? '');
  const targetLong = targetPair ? Math.max(targetPair.w, targetPair.h) : 2048;
  const candidates = allowed.map(value => ({ value, pair: pairOf(value) }))
    .filter((x): x is { value: string; pair: { w: number; h: number } } => !!x.pair && sameOrientation(aspect, x.pair));
  return candidates.sort((a, b) => {
    const ar = Math.abs(a.pair.w / a.pair.h - target), br = Math.abs(b.pair.w / b.pair.h - target);
    if (Math.abs(ar - br) > 1e-9) return ar - br;
    return Math.abs(Math.max(a.pair.w, a.pair.h) - targetLong) - Math.abs(Math.max(b.pair.w, b.pair.h) - targetLong);
  })[0]?.value;
}

export function imageRouteParams(models: ModelDef[]): ParamField[] | undefined {
  const resolutions = PUBLIC_RESOLUTIONS.filter(resolution => models.some(m => imageMemberAccepts(m, { aspect_ratio: '16:9', resolution })));
  const aspects = PUBLIC_ASPECTS.filter(aspect_ratio => models.some(m => resolutions.some(resolution => imageMemberAccepts(m, { aspect_ratio, resolution }))));
  if (!resolutions.length || !aspects.length) return undefined;
  return [
    { key: 'aspect_ratio', label: '图片比例', type: 'enum', options: aspects, default: aspects.includes('16:9') ? '16:9' : aspects[0] },
    { key: 'resolution', label: '分辨率', type: 'enum', options: resolutions, default: resolutions.includes('2k') ? '2k' : resolutions[0] },
    { key: 'quality', label: '质量', type: 'enum', options: ['auto', 'low', 'medium', 'high'], default: 'high' },
  ];
}

export function imageMemberAccepts(m: ModelDef, params: Record<string, unknown>): boolean {
  const aspect = aspectOf(params.aspect_ratio);
  const resolution = resolutionOf(params.resolution);
  if (!PUBLIC_ASPECTS.includes(aspect) || !PUBLIC_RESOLUTIONS.includes(resolution)) return false;
  const declared = m.params.find(p => p.key === 'resolution')?.options?.map(x => x.toLowerCase()) ?? ['2k'];
  if (!declared.includes(resolution)) return false;
  const sizeField = m.params.find(p => p.key === 'size');
  return !sizeField?.options?.length || configuredSize(m, aspect, resolution) !== undefined;
}

/** 管理端选定实际模型后，把公共图片参数转换成该上游翻译器需要的形态。 */
export function imageUpstreamParams(m: ModelDef, params: Record<string, unknown>): Record<string, unknown> {
  const aspect = aspectOf(params.aspect_ratio) || '16:9';
  const resolution = resolutionOf(params.resolution) || '2k';
  const out: Record<string, unknown> = { ...params, aspect_ratio: aspect, resolution };
  for (const key of IMAGE_DERIVED_KEYS) delete out[key];

  if (m.protocol === 'gemini-image') {
    delete out.aspect_ratio;
    out.aspectRatio = aspect;
    out.imageSize = resolution.toUpperCase();
    return out;
  }
  const usesCanonicalAspect = m.protocol === 'congge-image'
    || (!m.params.some(p => p.key === 'size') && !['openai-image', 'aistars-image', 'jmz-image', 'jmh-image', 'skylee-image', 'yali-image'].includes(m.protocol));
  if (usesCanonicalAspect) return out;

  const size = configuredSize(m, aspect, resolution)
    ?? (m.protocol === 'openai-image' ? PIXELS[aspect]?.[resolution] : aspect);
  delete out.aspect_ratio;
  if (size) out.size = size;
  return out;
}
