import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const state = vi.hoisted(() => ({
  catalog: { models: [], modes: [], families: [], routedFamilies: ['fam-seedance', 'fam-minimax'] },
  user: { features: { libtv: true, dreamina: true } },
  libtv: { authed: true }, dreamina: { authed: true },
  projectModelConfig: { video: '' },
}));
vi.mock('@/store/catalogStore', () => ({ useCatalogStore: Object.assign(
  (select: (s: unknown) => unknown) => select({ catalog: state.catalog }),
  { getState: () => ({ catalog: state.catalog, modelsByCapability: () => state.catalog.models }) },
) }));
vi.mock('@/store/connectionStore', () => ({
  useConnectionStore: Object.assign((select: (s: unknown) => unknown) => select(state), { getState: () => state }),
  useLibtvFeature: () => state.user.features.libtv,
  useDreaminaFeature: () => state.user.features.dreamina,
  useComfyuiFeature: () => false,
  getLibtvFeature: () => state.user.features.libtv,
  getDreaminaFeature: () => state.user.features.dreamina,
  getComfyuiFeature: () => false,
}));
vi.mock('@/store/libtvStore', () => ({ useLibtvStore: Object.assign(
  (select: (s: unknown) => unknown) => select(state.libtv), { getState: () => state.libtv },
) , isLibtvAuthed: () => state.libtv.authed }));
vi.mock('@/store/dreaminaStore', () => ({ useDreaminaStore: Object.assign(
  (select: (s: unknown) => unknown) => select(state.dreamina), { getState: () => state.dreamina },
) , isDreaminaAuthed: () => state.dreamina.authed }));
vi.mock('@/store/comfyuiStore', () => ({ useComfyuiStore: (select: (s: unknown) => unknown) => select({ endpoints: [] }), isComfyuiBound: () => false }));
vi.mock('@/store/projectStore', () => ({ useProjectStore: Object.assign(
  (select: (s: unknown) => unknown) => select(state), { getState: () => state },
) }));

import ModelPicker, { effectiveModelKey, useCapModelOptions, useEffectiveModelKey } from './ModelPicker';
import { LIBTV_FAMILY_OPTIONS, DREAMINA_FAMILY_OPTIONS, modelFamilies, modelForLine, localChannelOf } from '@/services/adapters/localChannels';
import { getChannelModelsForNodeType, resolveActiveModelKey } from '@/services/adapters/channelAdapter';

beforeEach(() => {
  state.libtv.authed = state.dreamina.authed = true;
  state.user.features.libtv = state.user.features.dreamina = true;
  state.projectModelConfig.video = '';
});

describe('bound local CLI families with automatic routing enabled', () => {
  it('keeps both families and every model as its own line', () => {
    const options = useCapModelOptions('video');
    const families = modelFamilies(options);
    expect(families.map(f => f.familyName)).toEqual(['LibTV', '即梦']);
    for (const expected of [LIBTV_FAMILY_OPTIONS, DREAMINA_FAMILY_OPTIONS]) {
      const family = families.find(f => f.familyId === expected[0].familyId)!;
      expect(family.channels.map(c => c.channel)).toEqual(expected.map(o => o.lineName));
      for (const option of expected) {
        expect(modelForLine(`src:${option.lineName}`, expected[0].id, families)).toBe(option.id);
        expect(localChannelOf(option.id)).not.toBeNull();
      }
    }
  });
  it.each([...LIBTV_FAMILY_OPTIONS, ...DREAMINA_FAMILY_OPTIONS])('preserves selected CLI $id for display and execution', option => {
    state.projectModelConfig.video = option.id;
    expect(effectiveModelKey('video')).toBe(option.id);
    expect(useEffectiveModelKey('video')).toBe(option.id);
    expect(resolveActiveModelKey('video', option.id)).toBe(option.id);
    const html = renderToStaticMarkup(<ModelPicker cap="video" />);
    expect(html).toContain('title="线路"');
    expect(html).not.toContain('模型（本线路款式）');
    expect(html.match(/<select/g)).toHaveLength(1);
    expect(html).toContain('data-route-select');
  });
  it('shows only the bound provider and uses it as the default', () => {
    state.libtv.authed = false;
    expect(useCapModelOptions('video')).toEqual(DREAMINA_FAMILY_OPTIONS);
    expect(effectiveModelKey('video')).toBe(DREAMINA_FAMILY_OPTIONS[0].id);
    state.dreamina.authed = false;
    expect(useCapModelOptions('video')).toEqual([]);
    expect(effectiveModelKey('video')).toBe('');
  });
  it('uses the same families and model lines in the canvas', () => {
    expect(modelFamilies(getChannelModelsForNodeType('video'))).toEqual(modelFamilies(useCapModelOptions('video')));
    state.libtv.authed = false;
    expect(modelFamilies(getChannelModelsForNodeType('video'))).toEqual(modelFamilies(DREAMINA_FAMILY_OPTIONS));
  });
  it('honors feature permissions and capability boundaries', () => {
    state.user.features.dreamina = false;
    expect(useCapModelOptions('video')).toEqual(LIBTV_FAMILY_OPTIONS);
    expect(effectiveModelKey('video')).toBe(LIBTV_FAMILY_OPTIONS[0].id);
    expect(useCapModelOptions('image')).toEqual([]);
    state.user.features.libtv = false;
    expect(useCapModelOptions('video')).toEqual([]);
    expect(effectiveModelKey('video')).toBe('');
  });
});
