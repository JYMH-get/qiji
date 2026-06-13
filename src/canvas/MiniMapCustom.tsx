/**
 * MiniMapCustom — 完全自定义小地图，绕开 ReactFlow 内置 MiniMap。
 * 直接从 canvasStore 读取节点数据，用纯 SVG 渲染。
 * 功能：
 *   - 彩色节点缩略矩形
 *   - 灰底 + 深灰框表示当前视口范围
 *   - 点击跳转视口
 */
import { useCallback, useMemo } from "react";
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
// 节点区留边距，让节点不完全贴边
const PADDING = 14;
// 视口框额外扩展量（让视口框在节点覆盖范围之外也能显示）
const VP_EXTRA = 60;

export function MiniMapCustom() {
  const nodesMap = useCanvasStore((s) => s.nodes);
  const { setCenter } = useReactFlow();
  const viewport = useViewport();           // { x, y, zoom } —— 实时响应式
  const storeApi = useStoreApi();           // 读取 ReactFlow 容器实际宽高

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
  //    viewport.x/y 是 ReactFlow pane 的平移量（屏幕像素）
  //    容器宽高从内部 store 读取
  const vpRect = useMemo(() => {
    const { width: cw, height: ch } = storeApi.getState();
    const { x: tx, y: ty, zoom } = viewport;
    // flow 坐标系中可见区域的左上角和宽高
    const left   = -tx / zoom;
    const top    = -ty / zoom;
    const width  = cw  / zoom;
    const height = ch  / zoom;
    return { left, top, width, height };
  }, [viewport, storeApi]);

  // ── 3. 合并 bbox（节点 + 视口，留 VP_EXTRA 余量）────────────────────────
  //    使小地图始终能同时展示节点和视口框
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

  // ── 5. 点击小地图跳转视口 ───────────────────────────────────────────────
  const handleClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const svgX = e.clientX - rect.left;
      const svgY = e.clientY - rect.top;
      const flowX = (svgX - PADDING) / miniScale + totalBbox.minX;
      const flowY = (svgY - PADDING) / miniScale + totalBbox.minY;
      setCenter(flowX, flowY, { zoom: viewport.zoom, duration: 350 });
    },
    [totalBbox, miniScale, setCenter, viewport.zoom],
  );

  // ── 6. 计算视口框的 SVG 坐标 ────────────────────────────────────────────
  const vpSvg = useMemo(() => {
    const { x, y } = toSvgCoord(vpRect.left, vpRect.top);
    return {
      x,
      y,
      w: Math.max(vpRect.width  * miniScale, 4),
      h: Math.max(vpRect.height * miniScale, 4),
    };
  }, [vpRect, toSvgCoord, miniScale]);

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

        {/* 当前视口框：深灰半透明填充 + 稍亮描边 */}
        <rect
          x={vpSvg.x}
          y={vpSvg.y}
          width={vpSvg.w}
          height={vpSvg.h}
          rx={2}
          fill="rgba(120,130,150,0.15)"
          stroke="rgba(180,190,210,0.6)"
          strokeWidth={1.5}
        />
      </svg>
    </div>
  );
}
