/**
 * MiniMapCustom — 完全自定义小地图
 * 功能：
 *   - 彩色节点缩略矩形
 *   - 灰底 + 视口范围框
 *   - 点击跳转视口
 *   - 拖拽视口框平移画布
 */
import { useCallback, useMemo, useRef } from "react";
import { useCanvasStore } from "@/store/canvasStore";
import { useReactFlow, useViewport, useStoreApi } from "@xyflow/react";

// 节点类型 → 填充色（真实 hex，SVG fill 属性可用）
const NODE_COLORS: Record<string, string> = {
  text: "#56cfb2",
  script: "#f06b6b",
  image: "#5b8df6",
  video: "#f0a05a",
  audio: "#b57bee",
  group: "#98a2b3",
  file: "#e8a44a",
};

// 小地图 SVG 尺寸（px）
const MAP_W = 210;
const MAP_H = 140;
// 节点区留边距
const PADDING = 14;
// 视口框额外扩展量
const VP_EXTRA = 60;

export function MiniMapCustom() {
  const nodesMap = useCanvasStore((s) => s.nodes);
  const { setCenter } = useReactFlow();
  const viewport = useViewport();
  const storeApi = useStoreApi();

  const dragRef = useRef<{ active: boolean; startSvgX: number; startSvgY: number }>({
    active: false,
    startSvgX: 0,
    startSvgY: 0,
  });

  const nodes = useMemo(() => Object.values(nodesMap), [nodesMap]);

  // ── 1. 节点 bounding box（flow 坐标系）──────────────────────────────────
  const nodeBbox = useMemo(() => {
    if (nodes.length === 0) return { minX: 0, minY: 0, maxX: 400, maxY: 300 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + (n.w ?? 240));
      maxY = Math.max(maxY, n.y + (n.h ?? 200));
    }
    return { minX, minY, maxX, maxY };
  }, [nodes]);

  // ── 2. 当前视口矩形（flow 坐标系）──────────────────────────────────────
  const vpRect = useMemo(() => {
    const { width: cw, height: ch } = storeApi.getState();
    const { x: tx, y: ty, zoom } = viewport;
    const left   = -tx / zoom;
    const top    = -ty / zoom;
    const width  = cw  / zoom;
    const height = ch  / zoom;
    return { left, top, width, height };
  }, [viewport, storeApi]);

  // ── 3. 合并 bbox（节点 + 视口，留 VP_EXTRA 余量）────────────────────────
  const totalBbox = useMemo(() => {
    const minX = Math.min(nodeBbox.minX, vpRect.left)   - VP_EXTRA;
    const minY = Math.min(nodeBbox.minY, vpRect.top)    - VP_EXTRA;
    const maxX = Math.max(nodeBbox.maxX, vpRect.left + vpRect.width)  + VP_EXTRA;
    const maxY = Math.max(nodeBbox.maxY, vpRect.top  + vpRect.height) + VP_EXTRA;
    return { minX, minY, maxX, maxY };
  }, [nodeBbox, vpRect]);

  // ── 4. flow 坐标 → SVG 坐标的统一转换 ────────────────────────────────
  const miniScale = useMemo(() => {
    const scaleX = (MAP_W - PADDING * 2) / Math.max(totalBbox.maxX - totalBbox.minX, 1);
    const scaleY = (MAP_H - PADDING * 2) / Math.max(totalBbox.maxY - totalBbox.minY, 1);
    return Math.min(scaleX, scaleY);
  }, [totalBbox]);

  const toSvgCoord = useCallback(
    (fx: number, fy: number) => ({
      x: PADDING + (fx - totalBbox.minX) * miniScale,
      y: PADDING + (fy - totalBbox.minY) * miniScale,
    }),
    [totalBbox, miniScale],
  );

  // SVG 坐标 → flow 坐标
  const toFlowCoord = useCallback(
    (svgX: number, svgY: number) => ({
      flowX: (svgX - PADDING) / miniScale + totalBbox.minX,
      flowY: (svgY - PADDING) / miniScale + totalBbox.minY,
    }),
    [totalBbox, miniScale],
  );

  // ── 5. 计算视口框的 SVG 坐标 ────────────────────────────────────────────
  const vpSvg = useMemo(() => {
    const { x, y } = toSvgCoord(vpRect.left, vpRect.top);
    return {
      x,
      y,
      w: Math.max(vpRect.width  * miniScale, 4),
      h: Math.max(vpRect.height * miniScale, 4),
    };
  }, [vpRect, toSvgCoord, miniScale]);

  // ── 6. 点击跳转 ───────────────────────────────────────────────────────
  const handleClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (dragRef.current.active) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const svgX = e.clientX - rect.left;
      const svgY = e.clientY - rect.top;
      const { flowX, flowY } = toFlowCoord(svgX, svgY);
      setCenter(flowX, flowY, { zoom: viewport.zoom, duration: 350 });
    },
    [toFlowCoord, setCenter, viewport.zoom],
  );

  // ── 7. 拖拽视口框平移 ──────────────────────────────────────────────────
  const onViewportPointerDown = useCallback(
    (e: React.PointerEvent<SVGRectElement>) => {
      e.stopPropagation();
      e.preventDefault();
      (e.target as Element).setPointerCapture(e.pointerId);
      const rect = (e.currentTarget.ownerSVGElement!).getBoundingClientRect();
      dragRef.current = {
        active: true,
        startSvgX: e.clientX - rect.left,
        startSvgY: e.clientY - rect.top,
      };
    },
    [],
  );

  const onViewportPointerMove = useCallback(
    (e: React.PointerEvent<SVGRectElement>) => {
      if (!dragRef.current.active) return;
      const svgEl = e.currentTarget.ownerSVGElement!;
      const rect = svgEl.getBoundingClientRect();
      const curX = e.clientX - rect.left;
      const curY = e.clientY - rect.top;
      const dxSvg = curX - dragRef.current.startSvgX;
      const dySvg = curY - dragRef.current.startSvgY;
      dragRef.current.startSvgX = curX;
      dragRef.current.startSvgY = curY;
      const { flowX, flowY } = toFlowCoord(vpSvg.x + dxSvg, vpSvg.y + dySvg);
      setCenter(flowX, flowY, { zoom: viewport.zoom, duration: 0 });
    },
    [toFlowCoord, vpSvg, setCenter, viewport.zoom],
  );

  const onViewportPointerUp = useCallback(() => {
    dragRef.current.active = false;
  }, []);

  return (
    <div className="minimap-custom">
      <svg
        width={MAP_W}
        height={MAP_H}
        viewBox={`0 0 ${MAP_W} ${MAP_H}`}
        onClick={handleClick}
        style={{ cursor: "crosshair", display: "block" }}
      >
        {/* 整体灰底 */}
        <rect x={0} y={0} width={MAP_W} height={MAP_H} fill="#1e2029" rx={7} />

        {/* 节点缩略矩形 */}
        {nodes.map((n) => {
          const { x, y } = toSvgCoord(n.x, n.y);
          const sw = Math.max((n.w ?? 240) * miniScale, 4);
          const sh = Math.max((n.h ?? 200) * miniScale, 3);
          const color = NODE_COLORS[n.type] ?? "#5b8df6";
          return (
            <rect
              key={n.id}
              x={x}
              y={y}
              width={sw}
              height={sh}
              rx={2}
              fill={color}
              fillOpacity={0.4}
              stroke={color}
              strokeWidth={1.5}
              strokeOpacity={0.95}
            />
          );
        })}

        {/* 当前视口框：可拖拽平移 */}
        <rect
          x={vpSvg.x}
          y={vpSvg.y}
          width={vpSvg.w}
          height={vpSvg.h}
          rx={2}
          fill="rgba(120,130,150,0.15)"
          stroke="rgba(180,190,210,0.6)"
          strokeWidth={1.5}
          style={{ cursor: "grab" }}
          onPointerDown={onViewportPointerDown}
          onPointerMove={onViewportPointerMove}
          onPointerUp={onViewportPointerUp}
        />
      </svg>
    </div>
  );
}