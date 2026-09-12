import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { useCanvasStore } from "@/store/canvasStore";
import { useProjectStore } from "@/store/projectStore";
import { useUiStore } from "@/store/uiStore";
import { NodeResizer, useStore } from "@xyflow/react";
import { MarkerStyleControls } from "./MarkerStyleControls";
import { markerArrowPoints, resizedMarkerFontSize } from "@/canvas/markerGeometry";

/** 只让可见的小菜单响应缩放；位置跟随标记，尺寸和间距保持屏幕像素。 */
function MarkerFloatingMenu({ children }: { children: ReactNode }) {
	const zoom = useStore((s) => s.transform[2]) || 1;
	return <div className="nodrag nowheel absolute left-1/2 z-20 flex w-max items-center rounded-full border border-white/10 bg-black/75 px-3 py-2 shadow-lg"
		style={{ bottom: `calc(100% + ${8 / zoom}px)`, transform: `translateX(-50%) scale(${1 / zoom})`, transformOrigin: "bottom center" }}
		onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>{children}</div>;
}

/** 标记复用坐标/拖动/分组，不参与业务节点避让。 */
export function CanvasTextMarker({ id, selected }: { id: string; selected?: boolean }) {
	const node = useCanvasStore((s) => s.nodes[id]);
	const editing = useUiStore((s) => s.editingMarkerId === id);
	const params = node?.data.params ?? {};
	const stored = String(params.text ?? "");
	const shape = String(params.shape ?? "text");
	const color = String(params.color ?? "#ffffff");
	const fontSize = Math.max(1, Number(params.fontSize ?? 18));
	const highlight = !!params.highlight;
	const [text, setText] = useState(stored);
	const ref = useRef<HTMLTextAreaElement>(null);
	const measureRef = useRef<HTMLSpanElement>(null);
	const initialFitDone = useRef(false);
	const resizeStart = useRef({ width: 220, fontSize: 18 });
	const textStyle: CSSProperties = { color, fontSize, lineHeight: 1.2, padding: `${fontSize / 9}px`, whiteSpace: "pre", background: "transparent", textShadow: highlight ? `0 0 6px ${color}, 0 0 14px ${color}` : undefined };

	useLayoutEffect(() => {
		if (shape !== "text" || (!editing && initialFitDone.current) || !measureRef.current) return;
		initialFitDone.current = true;
		// offset 尺寸是未缩放的 CSS 像素；不使用受画布 zoom 影响的 boundingClientRect。
		const w = Math.max(1, measureRef.current.offsetWidth), h = Math.max(1, measureRef.current.offsetHeight);
		const s = useCanvasStore.getState(), current = s.nodes[id];
		if (!current || (current.w === w && current.h === h)) return;
		useCanvasStore.setState({ nodes: { ...s.nodes, [id]: { ...current, w, h } } });
		useProjectStore.getState().scheduleAutoSave("canvas");
	}, [id, shape, editing, text, fontSize]);

	useEffect(() => setText(stored), [stored]);
	useEffect(() => {
		if (shape !== "text" || !editing) return;
		let frame = 0, attempts = 0;
		const focus = () => {
			if (ref.current && getComputedStyle(ref.current).visibility !== "hidden") ref.current.focus();
			else if (++attempts < 12) frame = requestAnimationFrame(focus);
		};
		frame = requestAnimationFrame(focus);
		return () => cancelAnimationFrame(frame);
	}, [id, editing, shape]);

	const patchStyle = (patch: Record<string, unknown>) => {
		const s = useCanvasStore.getState(), current = s.nodes[id];
		if (!current) return;
		useCanvasStore.setState({ nodes: { ...s.nodes, [id]: { ...current, data: { ...current.data, params: { ...current.data.params, ...patch } } } } });
		useProjectStore.getState().scheduleAutoSave("canvas");
	};
	const removeIfEmpty = () => {
		if (useUiStore.getState().editingMarkerId === id) useUiStore.getState().setEditingMarkerId(null);
		const current = useCanvasStore.getState().nodes[id];
		if (!current || String(current.data.params.text ?? "").trim()) return;
		useCanvasStore.getState().removeNode(id);
		const ui = useUiStore.getState();
		ui.setSelection(ui.selectedNodeIds.filter((value) => value !== id));
		if (ui.activeNodeId === id) ui.setActiveNodeId(null);
		useProjectStore.getState().scheduleAutoSave("canvas");
	};
	const editBar = selected || editing ? (
		<MarkerFloatingMenu>
			<MarkerStyleControls color={color} highlight={highlight} onChange={patchStyle} />
			{shape === "text" && <button type="button" className="ml-2 whitespace-nowrap rounded px-2 py-1 text-xs text-white hover:bg-white/15"
				onMouseDown={(e) => e.preventDefault()}
				onClick={() => editing ? ref.current?.blur() : useUiStore.getState().setEditingMarkerId(id)}>{editing ? "完成" : "编辑"}</button>}
		</MarkerFloatingMenu>
	) : null;
	const resizer = <NodeResizer isVisible={!!selected && !(shape === "text" && editing)} minWidth={24} minHeight={12} keepAspectRatio={shape === "text"}
		lineClassName="!border-white/40" handleClassName="!bg-white"
		onResizeStart={() => {
			resizeStart.current = { width: node?.w ?? 220, fontSize };
			useCanvasStore.getState().pushHistory();
		}}
		onResize={(_, p) => {
			const s = useCanvasStore.getState(), current = s.nodes[id];
			if (!current) return;
			useCanvasStore.setState({ nodes: { ...s.nodes, [id]: { ...current, x: p.x, y: p.y, w: p.width, h: p.height,
				data: { ...current.data, params: { ...current.data.params, ...(shape === "text" ? {
					fontSize: resizedMarkerFontSize(resizeStart.current.fontSize, resizeStart.current.width, p.width),
				} : {}) } } } } });
		}}
		onResizeEnd={() => useProjectStore.getState().scheduleAutoSave("canvas")} />;

	if (shape !== "text") return <div className="relative h-full w-full">
		{editBar}{resizer}
		<svg className="block h-full w-full overflow-visible" viewBox={`0 0 ${node?.w ?? 100} ${node?.h ?? 100}`} preserveAspectRatio="none" aria-label={`${shape} 标记`}
			style={{ filter: highlight ? `drop-shadow(0 0 6px ${color})` : undefined }}>
			{shape === "arrow" && <polygon points={markerArrowPoints(node?.w ?? 100, node?.h ?? 100, !!params.flipX, params.flipY !== false)} fill={color} />}
			{shape === "rect" && <rect x="2" y="2" width={Math.max(1, (node?.w ?? 100) - 4)} height={Math.max(1, (node?.h ?? 100) - 4)} rx="12" fill="transparent" stroke={color} strokeWidth="3" />}
			{shape === "ellipse" && <ellipse cx={(node?.w ?? 100) / 2} cy={(node?.h ?? 100) / 2} rx={Math.max(1, (node?.w ?? 100) / 2 - 2)} ry={Math.max(1, (node?.h ?? 100) / 2 - 2)} fill="transparent" stroke={color} strokeWidth="3" />}
		</svg>
	</div>;

	return <div className="group relative h-full w-full">
		{editBar}{resizer}
		<span ref={measureRef} aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 w-max font-semibold" style={textStyle}>{text + "\u200b"}</span>
		{editing ? <textarea ref={ref} value={text} wrap="off" aria-label="输入标记文字"
			onFocus={() => useUiStore.getState().setSelection([id])}
			onChange={(e) => { setText(e.target.value); patchStyle({ text: e.target.value }); }}
			onBlur={removeIfEmpty}
			onClick={(e) => { e.stopPropagation(); useUiStore.getState().setSelection([id]); useUiStore.getState().setActiveNodeId(null); }} onMouseDown={(e) => e.stopPropagation()}
			onKeyDown={(e) => {
				if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); e.currentTarget.blur(); useUiStore.getState().setCanvasMode(null); }
			}}
			className="nodrag nowheel block h-full w-full resize-none overflow-hidden border-0 font-semibold leading-snug outline-none placeholder:text-white/35"
			style={textStyle} />
			: <div data-marker-text className="h-full w-full cursor-move select-none overflow-hidden whitespace-pre-wrap break-words font-semibold leading-snug"
				style={textStyle}>{stored}</div>}
		<span className="absolute -right-3 top-1/2 -translate-y-1/2 cursor-move text-[10px] text-white/0 group-hover:text-white/45" title="拖动标记">⠿</span>
	</div>;
}
