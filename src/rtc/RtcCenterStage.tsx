/**
 * 实时剪辑 · 中央区（三页签「总览 / AI 工作台 / 预览」；页签行在中栏标题栏，切换控件是
 * [RtcCenterTabSwitch](./panel/RtcCenterTabSwitch.tsx)，经 FrameEditor 的 headerExtra 与分集切换器并排挂载）。
 *
 * 「总览」显示当前分集表格；「AI 工作台」显示单镜或自由生成工作台；「预览」显示时间轴或资产预览。
 * 页签由用户的明确操作切换：时间轴直接点击片段打开 AI 工作台；移动播放头、生成完成均不自动切页。
 * 用户选择「预览」后始终留在预览，占位符和空隙不会自动露出工作台。
 * 剧本处理面由右栏「整理剧本」打开；切页仅隐藏并保留挂载，未保存草稿可再次打开继续编辑。
 *
 * 工作台绑定 useWorkbenchTarget（新选中暂时优先，播放头移动后恢复跟随主轨片段）：
 *   带 shotRef 的片段（占位符**与已出片的成片**，第251轮需求⑦）→ RtcShotAiWorkbench；
 *   无 shotRef 的自由结果占位 → RtcFreeGenWorkbench；都没有才显示引导。
 *
 * ⚠ 播放不中断：doc 有片段时，RtcSequencePlayer 保持挂载在视口列里；
 *   总览、工作台与素材预览以不透明叠层覆盖，切页签和切素材选中不卸载播放器。
 */
import { useEffect } from "react";
import { Music } from "lucide-react";
import { resolveEpisodeKey, useProjectStore } from "@/store/projectStore";
import { useRtcStore } from "@/store/rtcStore";
import { RtcSequencePlayer } from "./RtcSequencePlayer";
import { docHasAnySegment } from "./rtcPlayback";
import { useRtcAssetSelStore } from "./rtcAssetSelStore";
import { useWorkbenchTarget } from "./panel/useRtcSelected";
import { RtcShotAiWorkbench } from "./panel/RtcShotAiWorkbench";
import { RtcFreeGenWorkbench } from "./panel/RtcFreeGenWorkbench";
import { RtcAssetWorkbench } from "./asset/RtcAssetWorkbench";
import { initialCenterTab, mainTrackSegAt } from "./panel/rtcCenterTabCore";
import { useRtcCenterTabStore } from "./panel/rtcCenterTabStore";
import { RtcScriptEditorPane } from "./flow/RtcScriptEditorPane";
import { ensureShotForPlaceholder } from "./panel/segShotBinding";
import { RtcEpisodeWorkbench } from "./flow/RtcEpisodeWorkbench";
import { openRtcEpisodeShot } from "./flow/rtcEpisodeWorkbenchView";

/** 顺序预览播放器挂载点：doc 有任何片段才显示；布尔选择器——选中/播放头变化不重渲本壳。 */
function SequencePreviewSlot({ showScriptReference }: { showScriptReference: boolean }) {
	const show = useRtcStore((s) => !!s.doc && docHasAnySegment(s.doc));
	return show ? <RtcSequencePlayer showScriptReference={showScriptReference} /> : null;
}

/* ════════════════ 预览页（单一预览视口） ════════════════ */

/** 底层空态提示：仅时间轴无片段时占满视口（有片段=播放器自身撑满整列，不再渲染本块） */
function ViewportIdleHint() {
	const hasSeg = useRtcStore((s) => !!s.doc && docHasAnySegment(s.doc));
	if (hasSeg) return null;
	return (
		<div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
			<div style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", lineHeight: 2, textAlign: "center" }}>
				时间轴还没有片段——从素材面板拖入素材，或在右侧「剧本」「分镜」页签按步骤生成分镜并占位入轨
			</div>
		</div>
	);
}

/** 普通素材预览叠层；项目资产使用独立的共享资产工作台。 */
function AssetPreviewLayer() {
  const media = useRtcAssetSelStore(state => state.mediaSel);
  if (!media) return null;
  return <div style={{ position: "absolute", inset: 0, zIndex: 5, background: "#101018", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: "16px 24px", minHeight: 0 }}>
    {media.media === "video" ? <video key={media.uri} src={media.uri} controls autoPlay style={{ maxWidth: "100%", maxHeight: "100%", minHeight: 0, borderRadius: 10, background: "#000" }} />
      : media.media === "audio" ? <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
        <Music size={40} color="rgba(255,255,255,0.4)" />
        <audio key={media.uri} src={media.uri} controls autoPlay style={{ width: "min(420px, 80%)" }} />
      </div> : <img key={media.uri} src={media.uri} alt={media.name} style={{ maxWidth: "100%", maxHeight: "100%", minHeight: 0, objectFit: "contain", borderRadius: 10 }} />}
    <span style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>{media.name}</span>
  </div>;
}

/* ════════════════ 「AI 工作台」页正文 ════════════════ */

/**
 * 「AI 工作台」页正文分派（绑 useWorkbenchTarget：新选中暂时优先，播放头移动后跟随主轨）。
 *
 * ⚠ 第251轮需求⑦：分派只看 **shotRef 有没有**，不看 kind——占位生成成功变成片后
 *   shotRef 原样保留，它仍该回分镜工作台二次编辑（提示词/垫图/历史都还在）。
 * 补充6（用户定稿「普通占位与分镜占位完全一致，不要两种实现」）：普通占位（视频/图片）创建时
 * 已挂真实分镜（segShotBinding）；**存量旧占位**在这里绑定那一刻补挂同一函数（幂等）。
 * 仍无 shotRef 的残余（音频占位/超分·去字幕坑位/生成中的存量自由占位）→ RtcFreeGenWorkbench。
 * 自由生成工作台以 segId 为 key：换目标即重置其本地编辑态。
 */
function ShotWorkbenchBody() {
	const target = useWorkbenchTarget();
	const seg = target?.seg ?? null;
	useEffect(() => {
		if (seg && seg.kind === "placeholder" && !seg.shotRef) ensureShotForPlaceholder(seg.id);
	}, [seg]);
	if (target && !target.seg.shotRef) {
		return <RtcFreeGenWorkbench key={target.seg.id} seg={target.seg} track={target.track} segIndex={target.segIndex} />;
	}
	return <RtcShotAiWorkbench />;
}

function OverviewBody() {
	const projectId = useProjectStore(s => s.projectInstanceId);
	const episodeId = useProjectStore(s => s.isProjectLoading ? "" : resolveEpisodeKey(s.rtcEpisodeId, s.episodes));
	return episodeId
		? <RtcEpisodeWorkbench key={`${projectId}/${episodeId}`} episodeId={episodeId} onOpenShot={(shotId) => { openRtcEpisodeShot(episodeId, shotId); }} />
		: <div className="m-auto text-xs text-muted-foreground">当前没有分集</div>;
}

export function RtcCenterStage() {
	const tab = useRtcCenterTabStore((s) => s.tab);
	const assetSel = useRtcAssetSelStore(s => s.selected);
	const showWorkbench = tab !== "preview";
	// 剧本处理面：右栏「整理剧本」打开的最上层叠层；切页隐藏时保持挂载，保留草稿。
	const scriptEditorOpen = useRtcCenterTabStore((s) => s.scriptEditorOpen);
	const scriptEditorHidden = useRtcCenterTabStore((s) => s.scriptEditorHidden);
	const projectId = useProjectStore(s => s.projectInstanceId);
	// 初始页签（会话首次挂载定一次）：优先按播放头下主轨片段——占位=工作台/有结果=预览，
	// 空白处按 doc 是否已有可播片段兜底。之后由页签、快捷键和明确导航入口切换，不跟随播放头自动切页。
	useEffect(() => {
		const st = useRtcStore.getState();
		const doc = st.doc;
		const hasPlayable = !!doc && doc.tracks.some((t) => t.segments.some((sg) => sg.kind !== "placeholder"));
		const ph = mainTrackSegAt(doc, st.playheadUs);
		useRtcCenterTabStore.getState().initTab(initialCenterTab(hasPlayable, ph?.seg.kind ?? null));
	}, []);

	return (
		<main className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
			{/* 页签行已收进中栏标题栏（RtcCenterTabSwitch 经 FrameEditor headerExtra 挂载，第240轮） */}
			<div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden" style={{ position: "relative" }}>
				{/* 顺序预览：doc 有片段时保持播放器挂载，不因页签切换卸载。 */}
				<SequencePreviewSlot showScriptReference={!showWorkbench} />
				<ViewportIdleHint />
				{/* 总览与 AI 工作台按页签挂载为不透明叠层；预览页不渲染此层，包括占位和空隙。 */}
				{showWorkbench && (
					<div style={{ position: "absolute", inset: 0, zIndex: 7, background: "#101018", display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
						{tab === "overview" ? <OverviewBody /> : <ShotWorkbenchBody />}
					</div>
				)}
				{/* ── 最上：左栏选中素材/资产卡的预览叠层（仅「预览」页，自带不透明底）── */}
				{tab === "preview" && !assetSel && <AssetPreviewLayer />}
				{/* 资产会话保持挂载，切页不丢编辑参数；预览留在中栏，编辑器由 portal 放入右栏。 */}
				{assetSel && <div aria-label="资产预览" style={{ position: "absolute", inset: 0, zIndex: 5, background: "#101018", display: tab === "preview" ? "flex" : "none", minWidth: 0, minHeight: 0 }}>
					<RtcAssetWorkbench key={`${projectId}/${assetSel.cat}/${assetSel.id}`} cat={assetSel.cat} id={assetSel.id} />
				</div>}
				{/* 剧本处理面：切页隐藏但保留草稿；重新打开恢复显示，保存/取消/Esc 才关闭。 */}
				{scriptEditorOpen && <div key={projectId} style={{ display: scriptEditorHidden ? "none" : "contents" }}><RtcScriptEditorPane active={!scriptEditorHidden} /></div>}
			</div>
		</main>
	);
}
