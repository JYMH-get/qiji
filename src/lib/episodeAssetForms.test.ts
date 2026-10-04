import { beforeEach, expect, it } from 'vitest';
import { useProjectStore } from '@/store/projectStore';
import { episodeAssetForms } from './episodeAssetForms';
import type { VideoEpisode } from '@/services/projectFile';

beforeEach(() => useProjectStore.setState({
  characters: [
    { id: 'hero', name: '张三', prompt: '', image: 'asset://base', variants: [
      { id: 'rain', name: '张三雨衣', image: 'asset://rain' }, { id: 'armor', name: '张三铠甲', image: 'asset://armor' },
    ] },
    { id: 'other', name: '李四', prompt: '', image: 'asset://other' },
  ],
  scenes: [{ id: 'scene', name: '大厅', image: 'asset://hall' }], items: [], crowds: [], organisms: [], assetBlobs: {},
} as any));
const episode = (scriptText: string, materials: any[] = []): VideoEpisode => ({
  id: 'ep', index: 1, title: '本集', scriptText,
  shots: [{ id: 'sh', scriptSegment: '', materials }] as any,
});
it('只收录本集原文匹配及显式引用的造型，排除其它集和未用造型', () => {
  const used = episodeAssetForms(episode('张三雨衣走进大厅。', [{ id: 'm', assetId: 'rain', uri: 'asset://rain' }]));
  expect([...used].sort()).toEqual(['hero:rain', 'scene']);
});
it('原文对白内提及其他角色不自动同步；素材只有URL仍能按身份反查', () => {
  expect([...episodeAssetForms(episode('张三：“李四呢？”', [{ id: 'm', uri: 'asset://hall' }]))].sort()).toEqual(['hero', 'scene']);
});
it('没有分集或本集没有引用时不发送全项目资产', () => {
  expect(episodeAssetForms().size).toBe(0);
  expect(episodeAssetForms(episode('')).size).toBe(0);
});
