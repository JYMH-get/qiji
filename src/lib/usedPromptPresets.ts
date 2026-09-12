import type { GenerateRequest, UsedPromptPreset } from '@/contract';
import { listPresetSchemes, type PresetScheme } from './presetSchemes';
import { useSettingsStore } from '@/store/settingsStore';

/** 只记录实发正文中完整存在的预设，覆盖胶囊展开、手动展开和自动宫格。 */
export function matchUsedPresets(texts: string[], schemes: PresetScheme[], customIds: Set<string>): UsedPromptPreset[] {
  const seen = new Set<string>();
  return schemes.filter(p => p.body.trim() && texts.some(text => text.includes(p.body))).flatMap(p => {
    const source = customIds.has(p.id) ? 'custom' as const : 'builtin' as const;
    const key = source + ':' + p.id;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ kind: p.target === 'video' ? 'video' as const : 'image' as const, source, sourceId: p.id, name: p.name, body: p.body }];
  });
}

export function usedPresetsForRequest(req: GenerateRequest): UsedPromptPreset[] | undefined {
  const texts = req.promptOverride ? [req.promptOverride] : Object.values(req.variables ?? {});
  const items = matchUsedPresets(texts, listPresetSchemes('all'), new Set(useSettingsStore.getState().customPresets.map(p => p.id)));
  return items.length ? items : undefined;
}
