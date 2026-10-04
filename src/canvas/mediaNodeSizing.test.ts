import { beforeEach, expect, it } from 'vitest';
import { useCanvasStore } from '@/store/canvasStore';
import { makeNode, NODE_H, resolveCollision } from './nodeFactory';
import { fitMediaNode, resizeMediaNode } from './mediaNodeSizing';
import { layoutProjection } from '@/lib/canvasProjectionLayout';
import { useUiStore } from '@/store/uiStore';
import { useLibraryStore } from '@/store/libraryStore';

beforeEach(() => {
  useCanvasStore.setState({ nodes: {}, edges: {}, groups: {}, runtime: {}, past: [], future: [] });
  useUiStore.setState({ allowOverlap: false });
  useLibraryStore.setState({ assets: {} });
});

function projectedPair() {
  const a = makeNode('image.gen', 0, 0), b = makeNode('video.gen', 220, 0);
  for (const [column, node] of [a, b].entries()) {
    node.data.projectionLayout = { section: 'shots', row: 0, column };
    node.data.projectionPosition = { x: column * 360, y: 0 };
    node.data.episodeRef = 'ep';
  }
  useCanvasStore.setState({ nodes: { [a.id]: a, [b.id]: b } });
  return [a, b];
}

it('切换结果后忽略旧媒体回调，只缓存当前结果的真实尺寸', () => {
  const [a] = projectedPair();
  a.data.resultAssetId = 'current';
  useLibraryStore.getState().addAsset({ id: 'current', kind: 'image', uri: 'asset://current', name: 'current', createdAt: '', thumbnailUri: null, deletedByUser: false });
  const before = useCanvasStore.getState().nodes;
  fitMediaNode(a.id, 4000, 1000, 'old');
  expect(useCanvasStore.getState().nodes).toBe(before);
  expect(useLibraryStore.getState().assets.current.pixelWidth).toBeUndefined();
  fitMediaNode(a.id, 1920, 1080, 'current');
  expect(useLibraryStore.getState().assets.current).toMatchObject({ pixelWidth: 1920, pixelHeight: 1080 });
});

it('加载横图后纠正旧偏移重叠，重复加载不会漂移', () => {
  const [a, b] = projectedPair();
  fitMediaNode(a.id, 1920, 1080);
  const first = useCanvasStore.getState().nodes;
  expect(first[b.id].x).toBeGreaterThanOrEqual(first[a.id].x + first[a.id].w + 16);
  fitMediaNode(a.id, 1920, 1080);
  expect(useCanvasStore.getState().nodes).toBe(first);
  fitMediaNode(b.id, 1920, 1080);
  resizeMediaNode(a.id, 800, 450);
  const loaded = useCanvasStore.getState().nodes;
  for (const node of Object.values(loaded)) expect(resolveCollision(node, Object.values(loaded))).toBeNull();
});

it('媒体变宽只移动碰撞对象，保留远处手动位置和标记', () => {
  const [a, b] = projectedPair();
  const far = { ...b, id: 'far', x: 2200, y: 900, data: { ...b.data, projectionLayout: { section: 'shots', row: 1, column: 1 } } };
  const marker = makeNode('canvas.marker', 0, 0);
  useCanvasStore.setState({ nodes: { ...useCanvasStore.getState().nodes, far, [marker.id]: marker } });
  fitMediaNode(a.id, 4000, 1000);
  expect(useCanvasStore.getState().nodes.far).toBe(far);
  expect(useCanvasStore.getState().nodes[marker.id]).toBe(marker);
});

it('允许重叠时媒体加载不改变节点位置', () => {
  const [a, b] = projectedPair();
  useUiStore.setState({ allowOverlap: true });
  fitMediaNode(a.id, 1920, 1080);
  expect(useCanvasStore.getState().nodes[b.id].x).toBe(b.x);
});
it('横竖图片及视频默认等高、保持完整比例，无额外撤销步骤', () => {
  const portrait = makeNode('image.gen', 0, 0), landscape = makeNode('image.gen', 500, 0), video = makeNode('video.gen', 1000, 0);
  for (const node of [portrait, landscape, video]) useCanvasStore.getState().addNode(node);
  fitMediaNode(portrait.id, 1152, 2048);
  fitMediaNode(landscape.id, 2048, 1152);
  fitMediaNode(video.id, 1920, 1080);
  const s = useCanvasStore.getState();
  expect([portrait, landscape, video].map(n => s.nodes[n.id].h)).toEqual([NODE_H, NODE_H, NODE_H]);
  expect(s.nodes[portrait.id].w).toBe(Math.round(NODE_H * 9 / 16));
  expect(s.nodes[landscape.id].w).toBe(Math.round(NODE_H * 16 / 9));
  expect(s.nodes[video.id].w).toBe(s.nodes[landscape.id].w);
  expect(s.past).toHaveLength(0);
  const prior = s.nodes;
  fitMediaNode(video.id, 1920, 1080);
  expect(useCanvasStore.getState().nodes).toBe(prior);
});
it('用户缩放高度在重载、切换结果比例后保留；坏元数据不污染尺寸', () => {
  const node = makeNode('image.gen', 0, 0);
  useCanvasStore.getState().addNode(node);
  resizeMediaNode(node.id, 600, 300);
  fitMediaNode(node.id, 400, 800);
  expect(useCanvasStore.getState().nodes[node.id]).toMatchObject({ w: 150, h: 300 });
  const before = useCanvasStore.getState().nodes;
  fitMediaNode(node.id, NaN, 0);
  expect(useCanvasStore.getState().nodes).toBe(before);
});
it('素材在上方，加载宽图后横向避开后续素材且分组包裹真实边界', () => {
  const a = makeNode('image.gen', 0, 0), b = makeNode('image.gen', 360, 0), shot = makeNode('video.gen', 0, 0), g = makeNode('group', -20, -40);
  a.data.projectionLayout = { section: 'characters', row: 0, column: 0 };
  b.data.projectionLayout = { section: 'characters', row: 0, column: 1 };
  shot.data.projectionLayout = { section: 'shots', row: 0, column: 0 };
  for (const n of [a, b, shot]) { n.data.projectionPosition = { x: n.x, y: n.y }; n.data.episodeRef = 'ep'; }
  a.parentId = b.parentId = g.id;
  useCanvasStore.setState(layoutProjection({ [a.id]: a, [b.id]: b, [shot.id]: shot, [g.id]: g }, { [g.id]: { id: g.id, x: -20, y: -40, childIds: [a.id, b.id] } }));
  fitMediaNode(a.id, 4000, 1000);
  fitMediaNode(b.id, 1000, 4000);
  const { nodes } = useCanvasStore.getState();
  expect(nodes[a.id].h).toBe(nodes[b.id].h);
  expect(nodes[b.id].x).toBe(nodes[a.id].x + nodes[a.id].w + 120);
  expect(nodes[g.id].x + nodes[g.id].w).toBeGreaterThan(nodes[b.id].x + nodes[b.id].w);
  expect(nodes[g.id].y + nodes[g.id].h).toBeLessThan(nodes[shot.id].y);
});
