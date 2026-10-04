import { useCanvasStore } from '@/store/canvasStore';
import { NODE_H, resolveCollision } from './nodeFactory';
import { settleProjectionLayout, fitGroupBounds } from '@/lib/canvasProjectionLayout';
import { useUiStore } from '@/store/uiStore';
import { useLibraryStore } from '@/store/libraryStore';
import type { CanvasNode, CanvasGroup } from '@/types';

function settleSize(id: string, nodes: Record<string, CanvasNode>, groups: Record<string, CanvasGroup>) {
  if (useUiStore.getState().allowOverlap) return fitGroupBounds(nodes, groups);
  if (nodes[id].data.projectionLayout) return settleProjectionLayout(nodes, groups);
  const free = resolveCollision(nodes[id], Object.values(nodes));
  if (free) nodes = { ...nodes, [id]: { ...nodes[id], ...free } };
  return fitGroupBounds(nodes, groups);
}

export function fitMediaNode(id: string, width: number, height: number, expectedAssetId?: string | null) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  const state = useCanvasStore.getState();
  const node = state.nodes[id];
  if (!node) return;
  if (expectedAssetId !== undefined && node.data.resultAssetId !== expectedAssetId) return;
  const library = useLibraryStore.getState();
  const asset = node.data.resultAssetId ? library.assets[node.data.resultAssetId] : undefined;
  if (asset && (asset.pixelWidth !== width || asset.pixelHeight !== height)) {
    library.addAsset({ ...asset, pixelWidth: width, pixelHeight: height });
  }
  const h = node.data.mediaDisplayHeight ?? NODE_H;
  const w = Math.max(1, Math.round(h * width / height));
  if (node.w === w && node.h === h && node.data.mediaDisplayHeight === h) return;
  const nodes = { ...state.nodes, [id]: { ...node, w, h, data: { ...node.data, mediaDisplayHeight: h } } };
  useCanvasStore.setState(settleSize(id, nodes, state.groups));
}

export function resizeMediaNode(id: string, width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  const state = useCanvasStore.getState();
  const node = state.nodes[id];
  if (!node) return;
  const nodes = { ...state.nodes, [id]: { ...node, w: width, h: height, data: { ...node.data, mediaDisplayHeight: height } } };
  useCanvasStore.setState(settleSize(id, nodes, state.groups));
}
