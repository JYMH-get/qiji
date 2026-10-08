import { useEffect, useMemo, useRef, useState } from "react";
import { InferenceStrategyPicker } from "@/components/InferenceStrategyPicker";
import { InferenceDurationPicker } from "@/components/InferenceDurationPicker";
import ModelPicker from "@/components/ModelPicker";
import { useDualModeFeature } from "@/store/connectionStore";
import { useCatalogStore } from "@/store/catalogStore";
import { useProjectStore, resolveEpisodeKey } from "@/store/projectStore";
import { useRtcStore } from "@/store/rtcStore";
import type { MediaSettings, VideoEpisode } from "@/services/projectFile";
import { normalInferenceStrategy, projectInferenceDuration, projectInferenceStrategy, resolveSplitTemplate, splitTemplates } from "@/lib/inferenceStrategy";
import { aspectFromName } from "@/lib/templateAspect";
import { genShotStoryboard, genShotVideo } from "../panel/shotGenActions";
import { smartInferEpisode, smartSplitEpisode, appendEpisodeToTimeline, type FlowResult } from "./flowActions";
import { RtcEpisodeShotRow } from "./RtcEpisodeShotRow";
import { RtcEpisodeTable } from "./RtcEpisodeTable";
import { submitEpisodeShotBatch } from "./rtcEpisodeWorkbenchCore";
import { orderedRtcEpisodeShots } from "./rtcEpisodeShotOps";
import { RtcEpisodeGenerationCost, RtcTextGenerationCost } from "../panel/RtcGenerationCost";
import "./RtcEpisodeWorkbench.css";

export interface RtcEpisodeWorkbenchProps {
	episodeId: string;
	onOpenShot?: (shotId: string) => void;
}

/** Key drafts/dialogs by their actual owner; identical episode IDs in another project cannot inherit them. */
export function RtcEpisodeWorkbench({ episodeId, onOpenShot }: RtcEpisodeWorkbenchProps) {
	const owner = useProjectStore(s => s.projectInstanceId);
	const episode = useProjectStore(s => s.episodes.find(ep => ep.id === episodeId));
	if (!episode) return <div className="rtc-episode-missing">请选择分集</div>;
	return <EpisodeWorkbenchBody key={`${owner}:${episodeId}`} owner={owner} episode={episode} onOpenShot={onOpenShot} />;
}

function EpisodeWorkbenchBody({ owner, episode, onOpenShot }: { owner: string; episode: VideoEpisode; onOpenShot?: (shotId: string) => void }) {
	const settings = useProjectStore(s => s.mediaSettings);
	const doc = useRtcStore(s => s.doc);
	const orderedShots = useMemo(() => orderedRtcEpisodeShots(doc, episode.id, episode.shots), [doc, episode.id, episode.shots]);
	const templates = useCatalogStore(s => s.catalog?.templates);
	const dualMode = useDualModeFeature();
	const sameSource = !dualMode || !!settings.imgVideoSameSource;
	const running = useProjectStore(s => s.inferTasks.find(t => t.episodeId === episode.id && (t.mode === "multi" || t.mode === "split") && t.status === "running"));
	const inferError = useProjectStore(s => [...s.inferTasks].reverse().find(t => t.episodeId === episode.id && (t.mode === "multi" || t.mode === "split") && t.status === "failed")?.error);
	const [editScript, setEditScript] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [pendingAction, setPendingAction] = useState("");
	const [feedback, setFeedback] = useState<FlowResult | null>(null);
	const actionLock = useRef(false);
	const episodeId = episode.id;
	const current = () => {
		const state = useProjectStore.getState();
		return state.projectInstanceId === owner && !state.isProjectLoading
			&& resolveEpisodeKey(state.rtcEpisodeId, state.episodes) === episodeId
			&& state.episodes.some(ep => ep.id === episodeId);
	};
	const updateSettings = (patch: Partial<MediaSettings>) => { if (current()) useProjectStore.getState().setMediaSettings(patch); };
	const strategy = normalInferenceStrategy(projectInferenceStrategy(settings), templates ?? []);
	const splitTemplate = resolveSplitTemplate(templates ?? [], settings.splitTplId);
	const splitOptions = splitTemplates(templates ?? []);
	const inferenceDuration = projectInferenceDuration(settings);
	const locked = !!running || !!pendingAction;
	const hasScript = !!episode.scriptText.trim();
	// 录入过程中即使已经输入原文，也不切页；接受推理后才进入结果表格。
	const showScript = !running && (editScript || episode.shots.length === 0);
	useEffect(() => {
		if (running) { setEditScript(false); setSettingsOpen(false); }
	}, [running?.id]);
	const run = async (label: string, action: () => Promise<FlowResult>) => {
		if (!current() || actionLock.current) return;
		actionLock.current = true; setPendingAction(label); setFeedback(null);
		try {
			const result = await action();
			if (current()) setFeedback(result);
		} catch (error) {
			if (current()) setFeedback({ ok: false, message: error instanceof Error ? error.message : "操作失败，请重试" });
		} finally {
			actionLock.current = false;
			setPendingAction("");
		}
	};
	const batch = (field: "storyboard" | "video") => run(field === "storyboard" ? "提交图片" : "提交视频", async () => {
		const shots = useProjectStore.getState().episodes.find(ep => ep.id === episodeId)?.shots ?? [];
		const ids = orderedRtcEpisodeShots(useRtcStore.getState().doc, episodeId, shots).map(shot => shot.id);
		const result = await submitEpisodeShotBatch(ids, current, shotId => field === "storyboard"
			? genShotStoryboard(episodeId, shotId) : genShotVideo(episodeId, shotId));
		return { ok: true, message: `已提交 ${result.accepted} 个${field === "storyboard" ? "图片" : "视频"}任务${result.stopped ? "，后续提交已停止" : ""}` };
	});
	const feedbackLine = (feedback?.message || inferError || running || pendingAction) && <div className={`rtc-episode-feedback${feedback?.ok === false || !running && inferError && !feedback ? " is-error" : ""}`} role="status">
		{feedback?.message || (running ? `${running.mode === "split" ? "拆分" : "推理"}中 · 已出 ${episode.shots.length} 镜` : pendingAction ? `${pendingAction}…` : inferError)}
	</div>;
	const inferenceOptions = <footer className="rtc-episode-inference-bar" aria-label="整集推理设置">
		<fieldset className="rtc-episode-model" disabled={locked}><ModelPicker cap="text" label="文本模型" style={{ width: "100%", minWidth: 0 }} /></fieldset>
		<div className="rtc-episode-inference-controls">
			<div className="rtc-episode-inference-options" role="group" aria-label="时长与拆分方案">
				<InferenceDurationPicker value={inferenceDuration} onChange={updateSettings} disabled={locked} />
				<label className="rtc-episode-split-option">拆分方案<select aria-label="拆分方案" value={splitTemplate?.id ?? ""} disabled={locked} onChange={event => updateSettings({ splitTplId: event.target.value })}>
					{!splitTemplate && <option value="">请选择拆分方案</option>}
					{splitOptions.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
				</select></label>
			</div>
			<div className="rtc-episode-inference-bottom">
				<div className="rtc-episode-inference-strategy"><InferenceStrategyPicker value={strategy} disabled={locked} onChange={value => {
					const aspect = aspectFromName(templates?.find(t => t.id === value.templateId)?.name);
					updateSettings({ inferenceStrategy: value, ...(aspect ? { imageAspect: aspect, aspect } : {}) });
				}} /></div>
				<div className="rtc-episode-inference-actions">
					<label className="rtc-episode-same-source"><input type="checkbox" checked={sameSource} disabled={locked || !dualMode}
						onChange={event => updateSettings({ imgVideoSameSource: event.target.checked })} />图视同源</label>
					<button type="button" className="is-primary" disabled={locked || !hasScript} onClick={() => void run("推理", () => smartInferEpisode(episodeId))}>智能推理<RtcTextGenerationCost /></button>
					<button type="button" disabled={locked || !hasScript} onClick={() => void run("拆分", () => smartSplitEpisode(episodeId))}>仅拆分<RtcTextGenerationCost /></button>
				</div>
			</div>
		</div>
	</footer>;
	return <section className={`rtc-episode-workbench${showScript ? " is-script-page" : " is-table-page"}`} aria-label={`${episode.title || "当前分集"}整集工作台`}>
		{showScript ? <>
			<div className="rtc-episode-script-heading"><label htmlFor={`rtc-episode-script-${episodeId}`}>本集剧本原文</label>
				{episode.shots.length > 0 && <button type="button" onClick={() => setEditScript(false)}>返回分镜</button>}
			</div>
			{feedbackLine}
			<textarea className="rtc-episode-script-input" id={`rtc-episode-script-${episodeId}`} value={episode.scriptText} placeholder="粘贴或输入本集剧本原文"
				disabled={locked} onChange={event => { if (current()) useProjectStore.getState().updateEpisode(episodeId, { scriptText: event.target.value }); }} />
			{inferenceOptions}
		</> : <>
		<header className="rtc-episode-heading"><strong>{episode.title || `第${episode.index}集`}</strong><span>{episode.shots.length} 个分镜</span></header>
		<div className="rtc-episode-toolbar" role="toolbar" aria-label="分集快捷操作">
			<button type="button" disabled={!!running} onClick={() => setEditScript(true)}>本集原文</button>
			<button type="button" className="is-primary" disabled={locked || !hasScript} onClick={() => void run("推理", () => smartInferEpisode(episodeId))}>{running?.mode === "multi" ? "推理中…" : "智能推理"}{!running && <RtcTextGenerationCost />}</button>
			<button type="button" disabled={locked || !hasScript} onClick={() => void run("拆分", () => smartSplitEpisode(episodeId))}>{running?.mode === "split" ? "拆分中…" : episode.shots.length ? "重新拆分" : "仅拆分"}{!running && <RtcTextGenerationCost />}</button>
			<button type="button" disabled={locked || !episode.shots.length} onClick={() => {
				if (!current()) return;
				const result = appendEpisodeToTimeline(episodeId);
				if (result) setFeedback({ ok: true, message: `已添加 ${result.added} 个占位，跳过 ${result.skipped} 个已在轨分镜` });
			}}>生成占位入轨</button>
			<span className="rtc-episode-toolbar-divider" />
			<button type="button" disabled={locked || !episode.shots.length} onClick={() => void batch("storyboard")}>一键故事板<RtcEpisodeGenerationCost episodeId={episodeId} shots={episode.shots} field="storyboard" /></button>
			<button type="button" disabled={locked || !episode.shots.length} onClick={() => void batch("video")}>一键视频<RtcEpisodeGenerationCost episodeId={episodeId} shots={episode.shots} field="video" /></button>
			<button type="button" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(value => !value)}>推理设置</button>
		</div>
		{feedbackLine}
		<div className="rtc-episode-content">
			<div className="rtc-episode-table-scroll">
				<RtcEpisodeTable>
					<tbody>{orderedShots.map(shot => <RtcEpisodeShotRow key={shot.id} owner={owner} episodeId={episodeId} shot={shot}
						sameSource={sameSource} defaultDuration={settings.maxDuration ?? 15} locked={!!running} onOpenShot={onOpenShot} />)}</tbody>
				</RtcEpisodeTable>
				{!episode.shots.length && <div className="rtc-episode-table-empty">{running ? "分镜将陆续显示…" : "暂无分镜"}</div>}
			</div>
		</div>
		{settingsOpen && inferenceOptions}
		</>}
	</section>;
}
