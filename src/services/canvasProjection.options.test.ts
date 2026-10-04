import { beforeEach, describe, expect, it } from 'vitest';
import { syncCanvasFromProject } from './canvasProjection';
import { useProjectStore } from '@/store/projectStore';
import { useCanvasStore } from '@/store/canvasStore';
import { useLibraryStore } from '@/store/libraryStore';
import { makeNode, NODE_W } from '@/canvas/nodeFactory';
import { CANVAS_SEND_OPTIONS } from '@/lib/canvasSendSettings';
import { fitMediaNode } from '@/canvas/mediaNodeSizing';
import { useUiStore } from '@/store/uiStore';
import type { CanvasSendSettings } from './projectFile';

const state = () => useCanvasStore.getState();
const find = (ref: string) => Object.values(state().nodes).find(n => n.data.sourceRef === ref);
const configure = (settings: Partial<CanvasSendSettings>) => useProjectStore.getState().setMediaSettings({ canvasSend: settings });
const step = NODE_W + 120;

beforeEach(() => {
  useCanvasStore.setState({ nodes: {}, edges: {}, groups: {}, runtime: {}, past: [], future: [] });
  useLibraryStore.setState({ assets: {} });
  useUiStore.setState({ allowOverlap: false });
  useProjectStore.setState({
    canvasEpisodeId: 'ep', canvases: {}, assetBlobs: {}, mediaSettings: {}, scriptText: '全文',
    characters: [{ id: 'c', name: '甲', prompt: '角色提示', image: 'asset://c.png',
      variants: [{ id: 'costume', name: '雨衣', label: '雨衣', description: '', image: 'asset://rain.png' }] }],
    scenes: [{ id: 's', name: '街道', prompt: '', image: 'asset://s.png' }],
    crowds: [{ id: 'g', name: '观众', prompt: '' }],
    organisms: [{ id: 'o', name: '猫', prompt: '' }], items: [{ id: 'i', name: '伞', prompt: '' }],
    episodes: [{ id: 'ep', index: 1, title: '第一集', scriptText: '甲走过街道，观众看着猫和伞。', shots: [1, 2].map(i => ({
      id: 'sh' + i, index: i, title: '分镜' + i, scriptSegment: '原文' + i, prompt: '',
      unifiedPrompt: '同源' + i, storyboardPrompt: '图像' + i, videoPrompt: '视频' + i,
      storyboardUri: 'asset://sb' + i + '.png', videoUri: 'asset://v' + i + '.mp4', materials: [{ id: 'costume-ref', assetId: 'costume', uri: '' }],
    })) }],
  } as any);
});

describe('发送选项组合', () => {
  for (const sameSource of [false, true]) {
    it.each(Array.from({ length: 128 }, (_, mask) => mask))(`同源=${sameSource} 七项组合 %i`, mask => {
      const settings = Object.fromEntries(CANVAS_SEND_OPTIONS.map(([key], bit) => [key, !!(mask & (1 << bit))])) as unknown as CanvasSendSettings;
      useProjectStore.getState().setMediaSettings({ imgVideoSameSource: sameSource, canvasSend: settings });
      syncCanvasFromProject('ep');
      expect(!!find('episode:ep')).toBe(settings.inference && settings.original);
      expect(!!find('shot:sh1')).toBe(settings.original);
      expect(!!find('shotSb:sh1')).toBe(settings.storyboard);
      expect(!!find('shotVid:sh1')).toBe(settings.video);
      expect(find('script')).toBeUndefined();
      expect(find('episodeSplit')).toBeUndefined();
      expect(find('shotUni:sh1')).toBeUndefined();
      const row = ['episode:ep', 'shot:sh1', 'shotSb:sh1', 'shotVid:sh1'].map(find).filter(n => !!n);
      expect(row.map(n => n.x)).toEqual(row.map((_, i) => i * step));
      const groups = Object.values(state().groups);
      expect(groups.filter(g => g.kind === 'material')).toHaveLength(settings.assets ? 5 : 0);
      expect(groups.filter(g => g.kind === 'default')).toHaveLength(settings.group && row.length ? 1 : 0);
      if (settings.group && row.length) {
        const g = groups.find(g => g.kind === 'default')!;
        expect(g.childIds).toHaveLength((settings.inference && settings.original ? 1 : 0) + 2 * [settings.original, settings.storyboard, settings.video].filter(Boolean).length);
        for (const id of g.childIds) expect(state().nodes[id].parentId).toBe(g.id);
      }
      const edges = Object.values(state().edges);
      if (!settings.connections) expect(edges).toHaveLength(0);
      for (const e of edges) { expect(state().nodes[e.source]).toBeTruthy(); expect(state().nodes[e.target]).toBeTruthy(); }
      const ids = Object.keys(state().nodes).sort();
      const edgeIds = Object.keys(state().edges).sort();
      syncCanvasFromProject('ep');
      expect(Object.keys(state().nodes).sort()).toEqual(ids);
      expect(Object.keys(state().edges).sort()).toEqual(edgeIds);
      expect(['shotSb:sh1', 'shotVid:sh1'].map(find).filter(Boolean).every(n => String(n!.data.params.prompt).length > 0)).toBe(true);
    });
  }
});

it('重新发送按已读取尺寸预留位置，连续发送不漂移', () => {
  syncCanvasFromProject('ep');
  const first = find('shotSb:sh1')!;
  fitMediaNode(first.id, 4000, 1000, first.data.resultAssetId);
  useCanvasStore.setState({ nodes: {}, edges: {}, groups: {}, runtime: {} });
  syncCanvasFromProject('ep');
  const image = find('shotSb:sh1')!, video = find('shotVid:sh1')!;
  expect(image.w).toBe(800);
  expect(video.x).toBeGreaterThanOrEqual(image.x + image.w + 120);
  const positions = Object.values(state().nodes).map(n => [n.id, n.x, n.y, n.w, n.h]);
  syncCanvasFromProject('ep');
  expect(Object.values(state().nodes).map(n => [n.id, n.x, n.y, n.w, n.h])).toEqual(positions);
});

it('连线开关保持位置；移除故事板收拢视频；原文关闭联动推理；恢复不重复', () => {
  configure({ group: true });
  syncCanvasFromProject('ep');
  const vidId = find('shotVid:sh1')!.id;
  const x = find('shotVid:sh1')!.x;
  configure({ group: true, connections: false });
  syncCanvasFromProject('ep');
  expect(find('shotVid:sh1')!.x).toBe(x);
  expect(Object.values(state().edges)).toHaveLength(0);
  configure({ group: true, storyboard: false });
  syncCanvasFromProject('ep');
  expect(find('shotSb:sh1')).toBeUndefined();
  expect(find('shotVid:sh1')!.x).toBe(x - step);
  expect(find('shotVid:sh1')!.id).toBe(vidId);
  expect(Object.values(state().edges).some(e => e.source === find('shot:sh1')!.id && e.target === vidId)).toBe(true);
  configure({ original: false, storyboard: false });
  syncCanvasFromProject('ep');
  expect(find('episode:ep')).toBeUndefined();
  expect(find('shot:sh1')).toBeUndefined();
  expect(find('shotVid:sh1')!.x).toBe(0);
  expect(find('shotVid:sh1')!.parentId).toBeNull();
  expect(Object.values(state().groups)).toHaveLength(0);
  configure({});
  syncCanvasFromProject('ep');
  expect(find('shotVid:sh1')!.id).toBe(vidId);
  expect(find('shotVid:sh1')!.x).toBe(x);
});

it('五类素材组包含主图与造型，关闭普通分组仍保留素材组', () => {
  configure({ assets: true, group: false });
  syncCanvasFromProject('ep');
  const characterGroup = find('assetGroup:characters')!;
  expect(state().groups[characterGroup.id].childIds).toEqual([find('asset:c')!.id, find('asset:c:costume')!.id]);
  expect(useLibraryStore.getState().assets[find('asset:c:costume')!.data.resultAssetId!].uri).toBe('asset://rain.png');
  expect(Object.values(state().groups).every(g => g.kind === 'material')).toBe(true);
  expect(find('asset:s')!.data.params).toMatchObject({ purpose: 'asset.scene.image', idPrefix: 'S', assetName: '街道' });
});

it('取消本集组保留手建节点，清理父组引用，并可撤销整个发送', () => {
  configure({ group: true }); syncCanvasFromProject('ep');
  const group = find('episodeGroup:ep')!;
  const manual = makeNode('text.seed', 5000, 4000);
  manual.parentId = group.id;
  state().addNode(manual);
  state().setGroups({ ...state().groups, [group.id]: { ...state().groups[group.id], childIds: [...state().groups[group.id].childIds, manual.id] } });
  configure({ group: false }); syncCanvasFromProject('ep');
  expect(state().nodes[manual.id]).toMatchObject({ x: 5000, y: 4000, parentId: null });
  expect(find('episodeGroup:ep')).toBeUndefined();
  state().undo();
  expect(find('episodeGroup:ep')).toBeTruthy();
  expect(state().nodes[manual.id].parentId).toBe(group.id);
});

it('取消投影不删除用户创建的分组和其它集节点', () => {
  syncCanvasFromProject('ep');
  const vid = find('shotVid:sh1')!;
  const manualGroup = makeNode('group', 0, 0);
  const other = makeNode('smart.infer', 100, 100);
  other.data.sourceRef = 'episode:other'; other.data.episodeRef = 'other';
  state().addNode(manualGroup); state().addNode(other);
  useCanvasStore.setState({ nodes: { ...state().nodes, [vid.id]: { ...vid, parentId: manualGroup.id } },
    groups: { [manualGroup.id]: { id: manualGroup.id, x: 0, y: 0, childIds: [vid.id] } } });
  configure({ original: false, storyboard: false, video: false }); syncCanvasFromProject('ep');
  expect(state().nodes[manualGroup.id]).toEqual(manualGroup);
  expect(state().nodes[other.id]).toEqual(other);
  expect(state().groups[manualGroup.id].childIds).toEqual([]);
});
