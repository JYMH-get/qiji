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
  { id: 'fam-seedream-5-pro', name: 'Seedream 5.0 Pro' },
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

/** 目录提供的公共选项；请求仍可携带上游原生参数。 */
export const IMAGE_PUBLIC_KEYS = ['aspect_ratio', 'resolution', 'quality'];
export const IMAGE_DERIVED_KEYS = ['size', 'imageSize', 'aspectRatio'];
const PUBLIC_ASPECTS = ['1:1', '16:9', '9:16', '21:9', '4:3', '3:4'];
const PUBLIC_RESOLUTIONS = ['512', '1k', '1.5k', '2k', '4k'];
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

/** 仅生成选路/计价视图，不改写请求。别名冲突必须拒绝，不能低档计价高档出图。 */
export function imageRoutingParams(params: Record<string, unknown>): { aspect_ratio: string; resolution: string } {
  if (params.generationConfig !== undefined && (!params.generationConfig || typeof params.generationConfig !== 'object' || Array.isArray(params.generationConfig))) {
    throw new Error('generationConfig 必须为对象');
  }
  const config = (params.generationConfig ?? {}) as Record<string, unknown>;
  if (config.imageConfig !== undefined && (!config.imageConfig || typeof config.imageConfig !== 'object' || Array.isArray(config.imageConfig))) {
    throw new Error('generationConfig.imageConfig 必须为对象');
  }
  const imageConfig = (config.imageConfig ?? {}) as Record<string, unknown>;
  const resolutions = [imageConfig.imageSize, params.imageSize, params.resolution].map(resolutionOf).filter(Boolean);
  if (new Set(resolutions).size > 1) throw new Error('图片分辨率参数冲突，请统一 resolution、imageSize 与 generationConfig.imageConfig.imageSize');
  const sizeAspect = /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(aspectOf(params.size)) ? params.size : undefined;
  const aspects = [imageConfig.aspectRatio, params.aspectRatio, params.aspect_ratio, sizeAspect].map(aspectOf).filter(Boolean);
  if (new Set(aspects).size > 1) throw new Error('图片比例参数冲突，请统一 aspect_ratio、aspectRatio、size 与 generationConfig.imageConfig.aspectRatio');
  return { aspect_ratio: aspects[0] || '16:9', resolution: resolutions[0] || '2k' };
}
function exactSize(m: ModelDef, aspect: string, resolution: string): string | undefined {
  if (m.imageSizeMap) return m.imageSizeMap[aspect]?.[resolution];
  return PIXELS[aspect]?.[resolution];
}

/** 只接受同档位的精确尺寸，禁止以最近比例或最近长边跨档替代。 */
function configuredSize(m: ModelDef, aspect: string, resolution: string): string | undefined {
  const allowed = m.params.find(p => p.key === 'size')?.options ?? [];
  if (!allowed.length) return undefined;
  if (allowed.includes(aspect)) return aspect;
  const exact = exactSize(m, aspect, resolution);
  if (exact && allowed.includes(exact)) return exact;
  return undefined;
}

export function imageRouteParams(models: ModelDef[]): ParamField[] | undefined {
  if (models.length && models.every(m => m.protocol === 'xiha888-image' || m.params.some(p => p.key === 'botType'))) {
    const fields = structuredClone(models[0].params);
    for (const field of fields) if (field.type === 'enum') {
      field.options = [...new Set(models.flatMap(m => m.params.find(p => p.key === field.key)?.options ?? []))];
    }
    return fields;
  }
  const resolutions = PUBLIC_RESOLUTIONS.filter(resolution => models.some(m => PUBLIC_ASPECTS.some(aspect_ratio => imageMemberAccepts(m, { aspect_ratio, resolution }))));
  const aspects = PUBLIC_ASPECTS.filter(aspect_ratio => models.some(m => resolutions.some(resolution => imageMemberAccepts(m, { aspect_ratio, resolution }))));
  if (!resolutions.length || !aspects.length) return undefined;
  return [
    { key: 'aspect_ratio', label: '图片比例', type: 'enum', options: aspects, default: aspects.includes('16:9') ? '16:9' : aspects[0] },
    { key: 'resolution', label: '分辨率', type: 'enum', options: resolutions, default: resolutions.includes('2k') ? '2k' : resolutions[0] },
    { key: 'quality', label: '质量', type: 'enum', options: ['auto', 'low', 'medium', 'high'], default: 'high' },
  ];
}

export function imageMemberAccepts(m: ModelDef, params: Record<string, unknown>): boolean {
  const { aspect_ratio: aspect, resolution } = imageRoutingParams(params);
  if (m.protocol === 'xiha888-image') {
    return m.params.every(field => {
      const value = field.key === 'aspectRatio' ? (params.aspectRatio ?? params.aspect_ratio ?? params.aspect ?? field.default) : params[field.key] ?? field.default;
      return field.type !== 'enum' || !field.options?.length || value === undefined || field.options.includes(String(value));
    });
  }
  if (!PUBLIC_ASPECTS.includes(aspect) || !PUBLIC_RESOLUTIONS.includes(resolution)) return false;
  const declared = m.params.find(p => p.key === 'resolution')?.options?.map(x => x.toLowerCase()) ?? ['2k'];
  if (!declared.includes(resolution)) return false;
  if (m.imageSizeMap) {
    const ratios=m.params.find(p=>['aspect_ratio','aspectRatio','ratio'].includes(p.key))?.options
      ?? m.params.find(p=>p.key==='size')?.options?.filter(x=>/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(x));
    if(ratios?.length&&!ratios.includes(aspect))return false;
    return exactSize(m, aspect, resolution) !== undefined;
  }
  const sizeField = m.params.find(p => p.key === 'size');
  if (!sizeField?.options?.length && (m.protocol === 'openai-image')) return exactSize(m, aspect, resolution) !== undefined;
  const aspectField = m.params.find(p => p.key === 'aspect_ratio' || p.key === 'aspectRatio');
  if (aspectField?.options?.length && !aspectField.options.includes(aspect)) return false;
  return !sizeField?.options?.length || configuredSize(m, aspect, resolution) !== undefined;
}

/** 选定上游后仅补齐缺失的协议字段；显式参数与额外控制保持原值。 */
export function imageUpstreamParams(m: ModelDef, params: Record<string, unknown>): Record<string, unknown> {
  const { aspect_ratio: aspect, resolution } = imageRoutingParams(params);
  // 此协议使用原生比例/质量，不套用公共像素档位表（支持 4:5 等原生比例）。
  if (m.protocol === 'xiha888-image') {
    const out = { ...params };
    if (out.aspectRatio === undefined && (params.aspect_ratio !== undefined || params.size !== undefined || params.generationConfig !== undefined)) out.aspectRatio = aspect;
    return out;
  }
  if (!imageMemberAccepts(m, { aspect_ratio: aspect, resolution })) {
    throw new Error(`模型 ${m.id} 不支持图片 ${aspect} / ${resolution}，禁止替换分辨率档位`);
  }
  const out: Record<string, unknown> = { ...params };
  const fill = (key: string, value: unknown) => { if (out[key] === undefined) out[key] = value; };
  fill('resolution', resolution);

  if (m.imageSizeMap) {
    const size = exactSize(m, aspect, resolution);
    if (out.size !== undefined && out.size !== size && aspectOf(out.size) !== aspect) {
      throw new Error(`模型 ${m.id} 的 size 与请求比例/分辨率对应表不一致，禁止替换显式尺寸`);
    }
    fill('size', size);
    return out;
  }

  if (m.protocol === 'gemini-image') {
    fill('aspectRatio', aspect);
    fill('imageSize', resolution.toUpperCase());
    return out;
  }
  const usesCanonicalAspect = m.protocol === 'congge-image'
    || (!m.params.some(p => p.key === 'size') && !['openai-image', 'aistars-image', 'jmz-image', 'skylee-image', 'yali-image'].includes(m.protocol));
  if (usesCanonicalAspect) {
    fill('aspect_ratio', aspect);
    return out;
  }

  const size = configuredSize(m, aspect, resolution)
    ?? (m.protocol === 'openai-image' ? exactSize(m, aspect, resolution) : aspect);
  if (m.protocol === 'openai-image' && out.size !== undefined && out.size !== size) {
    throw new Error(`模型 ${m.id} 的 size 与请求比例/分辨率不一致，禁止替换显式尺寸`);
  }
  if (size) fill('size', size);
  return out;
}
