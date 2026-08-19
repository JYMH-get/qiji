/**
 * RtcAssetCard —— 实时剪辑资产面板的单张卡片（缩略图 + 名称 + 选中态 + 拖拽）。
 *
 * 缩略：图片=background url 直显（本地 uri，CSP 安全）；视频=静态 <video preload="metadata">
 * 首帧；音频=图标占位 + 点击播放/暂停（由面板层统一持有 Audio 单例，同时只播一条）。
 * 拖拽 payload 由面板层组装（application/x-qiji-asset，硬约定见 rtcAssetData）。
 *
 * 占位符卡（item.placeholder，资产拆分刚提取尚未出图）：虚线边框 + 名字首字 + 「未出图」小徽标
 * （观感对齐时间轴分镜占位符「虚线+『镜』章」，见 RtcTrackLane）；**禁用拖拽**（无图无媒体，
 * 悬停提示先生成图片）；点击选中与有图卡同链路（右栏出图）；出图在途角标同样生效，完成后
 * 随 projectStore 订阅自动变为正常图卡。
 * 「N造型」角标（与 AssetAssistant 同规）：主体卡收敛全部造型不单独占格，>1 个造型时显示角标，
 * 右键弹造型选单（面板层挂 onContextMenu）。
 */
import { Music, Play, Pause, Film } from "lucide-react";
import type { RtcAssetItem } from "./rtcAssetData";

const ACCENT = "#8b5cf6";

export function RtcAssetCard({
	item,
	selected,
	generating,
	playing,
	onSelect,
	onDragStart,
	onPreview,
	onTogglePlay,
	onContextMenu,
}: {
	item: RtcAssetItem;
	selected: boolean;
	/** 该资产有出图在途（项目五类卡显示小转圈角标；完成后主图缩略随 store 订阅自动刷新） */
	generating?: boolean;
	/** 音频卡当前是否在播（面板层单例管理） */
	playing?: boolean;
	onSelect: (item: RtcAssetItem) => void;
	onDragStart: (e: React.DragEvent, item: RtcAssetItem) => void;
	/** 双击放大预览（灯箱） */
	onPreview: (item: RtcAssetItem) => void;
	/** 音频播放/暂停 */
	onTogglePlay?: (item: RtcAssetItem) => void;
	/** 右键（项目资产卡「选择造型」选单；面板层判定 >1 造型才弹） */
	onContextMenu?: (e: React.MouseEvent, item: RtcAssetItem) => void;
}) {
	const isVideo = item.media === "video";
	const isAudio = item.media === "audio";
	const isPh = !!item.placeholder;
	const formsCount = item.forms?.length ?? 0;
	return (
		<div
			draggable={!isPh}
			onDragStart={isPh ? undefined : (e) => onDragStart(e, item)}
			onClick={() => onSelect(item)}
			onDoubleClick={() => onPreview(item)}
			onContextMenu={onContextMenu ? (e) => onContextMenu(e, item) : undefined}
			title={isPh
				? `${item.name}（未出图——先生成图片：点击选中，在右栏编辑提示词并生成基础形象；生成前不可拖入时间轴/垫图）`
				: `${item.name}（点击选中 / 双击预览 / 拖到时间轴=入轨 / 拖到右栏垫图区=复用${formsCount > 1 ? ` / 右键选择造型（${formsCount}）` : ""}）`}
			style={{
				position: "relative", aspectRatio: "1/1", borderRadius: 8, overflow: "hidden",
				cursor: isPh ? "pointer" : "grab",
				border: isPh
					? `1px dashed ${selected ? ACCENT : "rgba(139,92,246,0.55)"}`
					: selected ? `2px solid ${ACCENT}` : "1px solid rgba(255,255,255,0.1)",
				background: isPh
					? "rgba(139,92,246,0.07)"
					: item.media === "image"
						? `center/cover no-repeat url(${item.uri})`
						: "rgba(255,255,255,0.04)",
				display: "flex", alignItems: "center", justifyContent: "center",
			}}>
			{isPh && (
				<>
					{/* 名字首字作视觉占位（观感对齐时间轴分镜占位符的虚线+章） */}
					<span style={{ fontSize: 24, fontWeight: 600, color: "rgba(196,181,253,0.5)", pointerEvents: "none" }}>
						{Array.from(item.name || "?")[0]}
					</span>
					<span
						style={{ position: "absolute", top: 3, left: 3, fontSize: 9, lineHeight: "13px", padding: "0 4px", borderRadius: 4, border: "1px solid rgba(139,92,246,0.8)", color: "#c4b5fd", pointerEvents: "none" }}>
						未出图
					</span>
				</>
			)}
			{!isPh && formsCount > 1 && (
				/* 与 AssetAssistant 资产卡的造型角标同款样式（主体卡收敛造型，不单独占格） */
				<span title={`${formsCount} 个造型，右键选择`}
					style={{ position: "absolute", top: 3, left: 3, fontSize: 9.5, color: "#fff", background: "rgba(0,0,0,0.55)", borderRadius: 4, padding: "1px 5px", lineHeight: 1.4 }}>
					{formsCount}造型
				</span>
			)}
			{isVideo && (
				/* 静态首帧即可（preload=metadata）；hover 播放刻意不做，几十张卡同时解码会卡 */
				<video src={item.uri} muted preload="metadata" style={{ width: "100%", height: "100%", objectFit: "cover", pointerEvents: "none" }} />
			)}
			{isAudio && <Music size={22} color="rgba(255,255,255,0.55)" />}
			{/* 出图在途角标（小转圈）：新主图完成后缩略图随 projectStore 订阅自动换图 */}
			{generating && (
				<span title="出图中（完成后自动设为主图并刷新缩略图）"
					style={{ position: "absolute", top: 3, right: 3, width: 18, height: 18, borderRadius: "50%", background: "rgba(139,92,246,0.92)", color: "#fff", fontSize: 11, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
					<span className="sb-spin" style={{ display: "inline-block" }}>↻</span>
				</span>
			)}
			{/* 视频角标：时长（可得时）；无时长显示模态标 */}
			{isVideo && (
				<span style={{ position: "absolute", top: 3, left: 3, display: "flex", alignItems: "center", gap: 3, fontSize: 9.5, color: "#fff", background: "rgba(0,0,0,0.55)", borderRadius: 4, padding: "1px 5px", lineHeight: 1.4 }}>
					<Film size={9} />{item.durationSec ? `${item.durationSec}s` : "视频"}
				</span>
			)}
			{isAudio && onTogglePlay && (
				<span
					onClick={(e) => { e.stopPropagation(); onTogglePlay(item); }}
					onDoubleClick={(e) => e.stopPropagation()}
					title={playing ? "暂停" : "试听"}
					style={{ position: "absolute", top: 3, right: 3, width: 22, height: 22, borderRadius: "50%", background: playing ? "rgba(139,92,246,0.95)" : "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
					{playing ? <Pause size={11} color="#fff" /> : <Play size={11} color="#fff" />}
				</span>
			)}
			{selected && <span style={{ position: "absolute", inset: 0, background: "rgba(139,92,246,0.16)", pointerEvents: "none" }} />}
			<span style={{ position: "absolute", left: 0, right: 0, bottom: 0, fontSize: 10, color: "#fff", background: "rgba(0,0,0,0.55)", padding: "2px 5px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
				{item.name}
			</span>
		</div>
	);
}
