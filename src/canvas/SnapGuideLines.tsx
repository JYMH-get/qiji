import { ViewportPortal, useStore } from "@xyflow/react";
import { useUiStore } from "@/store/uiStore";
import type { SnapGuide } from "@/lib/dragSnap";

/**
 * 吸附对齐参考线：拖动吸附命中时显示，跨度覆盖 拖动节点↔对齐节点（一眼看出对齐到谁）。
 * 画在 ViewportPortal（画布坐标层，随视口 transform 走）；线画在节点**上层**（z-index 高于
 * 节点卡），沿边缘对齐时也全程可见。粗细按当前缩放补偿=屏幕恒定 ~2.5px（低缩放下不会缩成
 * 亚像素隐形——真机反馈「看不到对齐线」的根因）。
 * §9 合规：外壳只订阅 uiStore.snapGuides（命中才挂内层）；内层 GuideLines 仅命中期间存在，
 * 其 zoom 订阅是瞬态的，不随平时平移/缩放逐帧重渲染。
 */
export function SnapGuideLines() {
	const guides = useUiStore((s) => s.snapGuides);
	if (!guides || guides.length === 0) return null;
	return <GuideLines guides={guides} />;
}

function GuideLines({ guides }: { guides: SnapGuide[] }) {
	const zoom = useStore((s) => s.transform[2]) || 1;
	const t = 2.5 / zoom; // 屏幕恒定 ~2.5px
	const glow = 7 / zoom;
	const style = (g: SnapGuide): React.CSSProperties =>
		g.axis === "x"
			? { position: "absolute", left: g.value - t / 2, top: g.from, width: t, height: g.to - g.from }
			: { position: "absolute", left: g.from, top: g.value - t / 2, width: g.to - g.from, height: t };
	return (
		<ViewportPortal>
			{guides.map((g, i) => (
				<div
					key={i}
					style={{
						...style(g),
						background: "#22d3ee",
						boxShadow: `0 0 ${glow}px ${t / 2}px rgba(34, 211, 238, 0.55)`,
						borderRadius: t,
						pointerEvents: "none",
						zIndex: 10000,
					}}
				/>
			))}
		</ViewportPortal>
	);
}
