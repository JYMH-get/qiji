import type { CanvasGroup, CanvasNode } from '@/types';

const SECTIONS = ['characters', 'scenes', 'crowds', 'organisms', 'items', 'shots'];

/** 仅重新计算同步布局基准，保留用户相对基准的拖动偏移。 */
export function layoutProjection(nodes: Record<string, CanvasNode>, groups: Record<string, CanvasGroup>, avoidOverlap = false) {
  const next = { ...nodes };
  const episodes = new Set(Object.values(nodes).filter(n => n.data.projectionLayout).map(n => n.data.episodeRef));
  for (const ep of episodes) {
    let top = 0;
    for (const section of SECTIONS) {
      const members = Object.values(next).filter(n => n.data.episodeRef === ep && n.data.projectionLayout?.section === section);
      if (!members.length) continue;
      const columns = [...new Set(members.map(n => n.data.projectionLayout!.column))].sort((a, b) => a - b);
      const rows = [...new Set(members.map(n => n.data.projectionLayout!.row))].sort((a, b) => a - b);
      const xs = new Map<number, number>(), ys = new Map<number, number>();
      let left = 0, bottom = top;
      for (const col of columns) {
        xs.set(col, left);
        left += Math.max(...members.filter(n => n.data.projectionLayout!.column === col).map(n => n.w)) + 120;
      }
      for (const row of rows) {
        ys.set(row, bottom);
        bottom += Math.max(...members.filter(n => n.data.projectionLayout!.row === row).map(n => n.h)) + 48;
      }
      for (const node of members) {
        const slot = node.data.projectionLayout!;
        const x = xs.get(slot.column)!, y = ys.get(slot.row)!;
        const old = node.data.projectionPosition ?? { x: node.x, y: node.y };
        if (x === old.x && y === old.y) continue;
        next[node.id] = { ...node, x: node.x + x - old.x, y: node.y + y - old.y,
          data: { ...node.data, projectionPosition: { x, y } } };
      }
      top = bottom + 80;
    }
  }
  return avoidOverlap ? settleProjectionLayout(next, groups) : fitGroupBounds(next, groups);
}

/** 尺寸到达后只纠正相交节点，不再把整张投影重新套回基准网格。 */
export function settleProjectionLayout(nodes: Record<string, CanvasNode>, groups: Record<string, CanvasGroup>) {
  const next = { ...nodes };
  const business = Object.values(nodes).filter(n => n.type !== 'group' && n.type !== 'canvas.marker');
  const placed = business.filter(n => !n.data.projectionLayout);
  const projected = business.filter(n => n.data.projectionLayout).sort((a, b) => {
    const x = a.data.projectionLayout!, y = b.data.projectionLayout!;
    return (a.data.episodeRef ?? '').localeCompare(b.data.episodeRef ?? '') ||
      SECTIONS.indexOf(x.section) - SECTIONS.indexOf(y.section) || x.row - y.row || x.column - y.column || a.id.localeCompare(b.id);
  });
  for (const original of projected) {
    let node = original;
    // Each step moves beyond at least one obstacle. Coordinates only increase,
    // so the loop terminates without distance caps (including very wide media).
    for (;;) {
      const hit = placed.find(b => node.x < b.x + b.w + 16 && b.x < node.x + node.w + 16 &&
        node.y < b.y + b.h + 16 && b.y < node.y + node.h + 16);
      if (!hit) break;
      const slot = node.data.projectionLayout!, other = hit.data.projectionLayout;
      const below = other && node.data.episodeRef === hit.data.episodeRef &&
        (other.section !== slot.section || (other.column === slot.column && other.row < slot.row));
      node = below ? { ...node, y: hit.y + hit.h + 48 } : { ...node, x: hit.x + hit.w + 120 };
    }
    next[node.id] = node;
    placed.push(node);
  }
  return fitGroupBounds(next, groups);
}

/** 媒体元数据到达后，分组按真实子节点尺寸包裹；不影响撤销历史。 */
export function fitGroupBounds(nodes: Record<string, CanvasNode>, groups: Record<string, CanvasGroup>) {
  const next = { ...nodes }, nextGroups = { ...groups };
  const visited = new Set<string>();
  const fit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const group = groups[id], node = next[id];
    if (!group || !node) return;
    for (const child of group.childIds) if (groups[child]) fit(child);
    const children = group.childIds.map(child => next[child]).filter(Boolean);
    if (!children.length) return;
    const projected = /^(assetGroup|episodeGroup):/.test(node.data.sourceRef ?? '');
    // 手工分组保留用户留白，仅在内容越界时扩展；同步分组贴合实际内容。
    const x = Math.min(...children.map(n => n.x - 20), ...(projected ? [] : [node.x]));
    const y = Math.min(...children.map(n => n.y - 40), ...(projected ? [] : [node.y]));
    const w = Math.max(...children.map(n => n.x + n.w + 20), ...(projected ? [] : [node.x + node.w])) - x;
    const h = Math.max(...children.map(n => n.y + n.h + 20), ...(projected ? [] : [node.y + node.h])) - y;
    if (node.x !== x || node.y !== y || node.w !== w || node.h !== h) next[id] = { ...node, x, y, w, h };
    if (group.x !== x || group.y !== y) nextGroups[id] = { ...group, x, y };
  };
  for (const id of Object.keys(groups)) fit(id);
  return { nodes: next, groups: nextGroups };
}
