/**
 * 实时剪辑模式外壳（/frame-editor）：上排三面板（可拖宽/可换位）→ 时间轴高度 splitter → 工具条 → 时间轴。
 *
 * 布局自由化（rtcLayout）：
 *   - 上排三槽位（素材/结果展示/属性）经 RtcPanelFrame 包裹——标题栏拖拽换位（swapPanels），
 *     ⚠ 槽位顺序用 CSS order 落地、JSX 顺序恒定不重排（换位不重建子树、播放不中断）；
 *   - 左右定宽面板经边缘 splitter 拖宽（asset 220–520 / props 260–560）、时间轴高度 splitter
 *     （20vh–60vh 换算像素）；拖动全程本地 state 预览、pointerup 才写 rtcLayoutStore（性能红线）；
 *   - 面板内部组件零改动（宽度覆盖在 RtcPanelFrame 内容层）；RtcTimeline 高度跟随本壳容器。
 * TitleBar 等全局元素由 App 挂载。
 */
import { useState } from "react";
import { RtcAssetPanel } from "@/rtc/RtcAssetPanel";
import { RtcEpisodeSwitcher } from "@/rtc/RtcEpisodeSwitcher";
import { RtcCenterStage } from "@/rtc/RtcCenterStage";
import { RtcPropertyPanel } from "@/rtc/RtcPropertyPanel";
import { RtcToolbar } from "@/rtc/RtcToolbar";
import { RtcTimeline } from "@/rtc/RtcTimeline";
import { RtcPanelFrame } from "@/rtc/layout/RtcPanelFrame";
import { RtcSplitter } from "@/rtc/layout/RtcSplitter";
import { useRtcLayoutStore } from "@/rtc/layout/rtcLayoutStore";
import { ASSET_W, PROPS_W, timelineBounds, type RtcSlotId } from "@/rtc/layout/rtcLayoutCore";

const FrameEditor = () => {
	const slotOrder = useRtcLayoutStore((s) => s.slotOrder);
	const assetWidth = useRtcLayoutStore((s) => s.assetWidth);
	const propsWidth = useRtcLayoutStore((s) => s.propsWidth);
	const timelineHeight = useRtcLayoutStore((s) => s.timelineHeight);

	// splitter 拖动中的本地预览值（pointerup 才落 store → localStorage）
	const [liveAssetW, setLiveAssetW] = useState<number | null>(null);
	const [livePropsW, setLivePropsW] = useState<number | null>(null);
	const [liveTlH, setLiveTlH] = useState<number | null>(null);

	const stageIdx = slotOrder.indexOf("stage");
	/** 定宽面板的拖宽手柄贴「面向 stage 的竖边」（面板在 stage 左侧=右缘，右侧=左缘） */
	const sideFor = (slot: RtcSlotId): "left" | "right" => (slotOrder.indexOf(slot) < stageIdx ? "right" : "left");
	const onSwap = (a: RtcSlotId, b: RtcSlotId) => useRtcLayoutStore.getState().swapPanels(a, b);
	const tlBounds = timelineBounds(typeof window !== "undefined" ? window.innerHeight : 800);

	return (
		<div style={{ width: "100vw", height: "100%", position: "relative", background: "#0a0b0f", display: "flex", flexDirection: "column" }}>
			{/* 上排三面板：JSX 顺序恒定（asset/stage/props），排列由 CSS order 决定 */}
			<div className="flex flex-1 min-h-0 min-w-0">
				<RtcPanelFrame
					slot="asset"
					title="素材面板"
					order={slotOrder.indexOf("asset")}
					width={liveAssetW ?? assetWidth}
					resize={{
						side: sideFor("asset"),
						value: liveAssetW ?? assetWidth,
						min: ASSET_W.min,
						max: ASSET_W.max,
						onPreview: setLiveAssetW,
						onCommit: (v) => {
							useRtcLayoutStore.getState().setAssetWidth(v);
							setLiveAssetW(null);
						},
					}}
					onSwap={onSwap}
				>
					<RtcAssetPanel />
				</RtcPanelFrame>
				<RtcPanelFrame
					slot="stage"
					title="结果展示"
					order={stageIdx}
					flex
					onSwap={onSwap}
					onResetLayout={() => useRtcLayoutStore.getState().resetLayout()}
					headerExtra={<RtcEpisodeSwitcher />}
				>
					<RtcCenterStage />
				</RtcPanelFrame>
				<RtcPanelFrame
					slot="props"
					title="属性面板"
					order={slotOrder.indexOf("props")}
					width={livePropsW ?? propsWidth}
					resize={{
						side: sideFor("props"),
						value: livePropsW ?? propsWidth,
						min: PROPS_W.min,
						max: PROPS_W.max,
						onPreview: setLivePropsW,
						onCommit: (v) => {
							useRtcLayoutStore.getState().setPropsWidth(v);
							setLivePropsW(null);
						},
					}}
					onSwap={onSwap}
				>
					<RtcPropertyPanel />
				</RtcPanelFrame>
			</div>
			{/* 时间轴高度 splitter（上缘手柄：往上拖=时间轴变高） */}
			<RtcSplitter
				orientation="y"
				invert
				value={liveTlH ?? timelineHeight}
				min={tlBounds.min}
				max={tlBounds.max}
				onPreview={setLiveTlH}
				onCommit={(v) => {
					useRtcLayoutStore.getState().setTimelineHeight(v);
					setLiveTlH(null);
				}}
				title="拖动调整时间轴高度"
				className="h-1 w-full"
			/>
			<RtcToolbar />
			<div className="shrink-0 min-h-0 overflow-hidden" style={{ height: liveTlH ?? timelineHeight }}>
				<RtcTimeline />
			</div>
		</div>
	);
};

export default FrameEditor;
