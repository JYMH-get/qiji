import type { GenerateRequest, ParamField } from './contract.ts';
import type { ModelDef } from './store/models.ts';
import { checkMaterialLimits } from './materialLimits.ts';

export const VIDEO_PUBLIC_KEYS = ['duration', 'resolution', 'aspect_ratio'];

export function accepts(field: ParamField, value: unknown): boolean {
  if (field.type === 'enum') return !!field.options?.includes(String(value));
  if (field.type === 'number') {
    if (value === '' || value === null || typeof value === 'boolean') return false;
    const n = Number(value);
    return Number.isFinite(n) && (field.min === undefined || n >= field.min) && (field.max === undefined || n <= field.max)
      && (!field.step || Math.abs((n - (field.min ?? 0)) / field.step - Math.round((n - (field.min ?? 0)) / field.step)) < 1e-7);
  }
  if (field.type === 'boolean') return typeof value === 'boolean';
  return typeof value === 'string';
}

/** Capability is declared by model parameters, never inferred from its pricing rules. */
export function videoModelSupportsParams(model: ModelDef, params: Record<string, unknown>): boolean {
  return VIDEO_PUBLIC_KEYS.every(key => {
    const field = model.params.find(p => p.key === key);
    return !!field && (params[key] === undefined || accepts(field, params[key]));
  }) && (params.method === undefined || (model.methods ?? ['omni']).includes(String(params.method) as 'omni' | 'frames'));
}

export function videoMinVisualMaterials(model: ModelDef): number {
  return model.minVisualMaterials ?? (model.id === '007-sd2.0' ? 1 : 0);
}

export function videoMemberAccepts(model: ModelDef, request: GenerateRequest): boolean {
  const params = (request.params ?? {}) as Record<string, unknown>;
  if (!videoModelSupportsParams(model, params)) return false;
  const inputs = params.firstFrameUrl ? { ...request.inputs, images: [...(request.inputs?.images ?? []), { url: String(params.firstFrameUrl) }] } : request.inputs;
  if (checkMaterialLimits(model.label, model.matLimits, inputs)) return false;
  return (inputs?.images?.length ?? 0) + (inputs?.videos?.length ?? 0) >= videoMinVisualMaterials(model);
}

/** Expose the union; request validation still requires one model supporting the whole combination. */
export function videoRouteParams(models: ModelDef[]): ParamField[] | undefined {
  const valid = models.filter(m => videoModelSupportsParams(m, {}));
  if (!valid.length) return undefined;
  const result: ParamField[] = [];
  for (const key of VIDEO_PUBLIC_KEYS) {
    const fields = valid.map(m => m.params.find(p => p.key === key)!);
    const values = key === 'duration' ? Array.from({ length: 120 }, (_, i) => String(i + 1)) : [...new Set(fields.flatMap(f => f.options ?? []))];
    const options = values.filter(v => fields.some(f => accepts(f, v)));
    if (!options.length) return undefined;
    const preferred = key === 'duration' ? '5' : key === 'resolution' ? '720p' : '16:9';
    const first = fields[0];
    const defaultValue = accepts(first, preferred) && options.includes(preferred) ? preferred
      : options.includes(String(first.default)) && accepts(first, first.default) ? String(first.default)
      : options.find(v => accepts(first, v))!;
    result.push({ key, label: key === 'duration' ? '时长' : key === 'resolution' ? '分辨率' : '宽高比', type: 'enum', options,
      default: defaultValue, ...(key === 'duration' ? { unit: 's' } : {}) });
  }
  return result;
}
