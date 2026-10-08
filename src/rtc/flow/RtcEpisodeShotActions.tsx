import { useMemo, useRef, useState } from "react";
import type { StoryboardShot } from "@/services/projectFile";
import { resolveEpisodeKey, useProjectStore } from "@/store/projectStore";
import { useRtcStore } from "@/store/rtcStore";
import { StoryGuidanceButton } from "@/components/InferenceStrategyPicker";
import { useShotPreparing } from "../panel/rtcShotSubmission";
import { RtcTextGenerationCost } from "../panel/RtcGenerationCost";
import { rtcShotListRows } from "./rtcShotListCore";
import {
	deleteRtcEpisodeShot, inferRtcEpisodeShot, insertRtcEpisodeShot, matchRtcEpisodeShotAssets,
	moveRtcEpisodeShotLine, updateRtcEpisodeShot, type RtcEpisodeShotActionResult,
} from "./rtcEpisodeShotOps";

export interface RtcEpisodeShotActionsProps {
	owner: string;
	episodeId: string;
	shot: StoryboardShot;
	disabled?: boolean;
	defaultDuration?: number;
	onOpenShot?: (shotId: string) => void;
}

export function RtcEpisodeShotActions({ owner, episodeId, shot, disabled = false, defaultDuration = 15, onOpenShot }: RtcEpisodeShotActionsProps) {
	const scope = { owner, episodeId, shotId: shot.id };
	const doc = useRtcStore(state => state.doc);
	const placed = useMemo(() => rtcShotListRows(doc, episodeId, [shot]).some(row => !!row.segmentId), [doc, episodeId, shot]);
	const inferring = useProjectStore(state => state.inferTasks.some(task => task.episodeId === episodeId && task.status === "running"
		&& (task.mode !== "single" || task.shotId === shot.id)));
	const generating = useProjectStore(state => state.pendingGens.some(task => task.status === "running" && (
		task.shot?.episodeId === episodeId && task.shot.shotId === shot.id
		|| task.derived?.episodeId === episodeId && task.derived.shotId === shot.id)));
	const inferPreparing = useShotPreparing(episodeId, shot.id, "infer");
	const imagePreparing = useShotPreparing(episodeId, shot.id, "storyboard");
	const videoPreparing = useShotPreparing(episodeId, shot.id, "video");
	const [pending, setPending] = useState(false);
	const [feedback, setFeedback] = useState("");
	const actionLock = useRef(false);
	const busy = disabled || inferring || generating || inferPreparing || imagePreparing || videoPreparing || pending;
	const current = () => {
		const project = useProjectStore.getState();
		return project.projectInstanceId === owner && !project.isProjectLoading
			&& resolveEpisodeKey(project.rtcEpisodeId, project.episodes) === episodeId
			&& project.episodes.some(ep => ep.id === episodeId && ep.shots.some(item => item.id === shot.id));
	};
	const show = (result: RtcEpisodeShotActionResult) => { if (current()) setFeedback(result.ok ? result.message ?? "" : result.reason); };
	const run = async (action: () => RtcEpisodeShotActionResult | Promise<RtcEpisodeShotActionResult>) => {
		if (busy || actionLock.current || !current()) return;
		actionLock.current = true; setPending(true); setFeedback("");
		try { show(await action()); }
		catch (error) { if (current()) setFeedback(error instanceof Error ? error.message : "操作失败，请重试。"); }
		finally { actionLock.current = false; setPending(false); }
	};
	const duration = shot.overrides?.duration ?? shot.durationSec ?? defaultDuration;
	return <div className="rtc-episode-shot-actions">
		<button type="button" className="rtc-episode-shot-link" disabled={!onOpenShot || !placed}
			title={placed ? "打开单镜工作台" : "未在当前时间轴"}
			onClick={() => { if (current()) onOpenShot?.(shot.id); }}>{shot.title || `分镜${shot.index}`} · {duration}s</button>
		<div className="rtc-episode-shot-action-pair">
			<button type="button" disabled={busy} title="把本镜首个非空原文行移到时间轴上一镜末尾" onClick={() => void run(() => moveRtcEpisodeShotLine(scope, "up"))}>上拆</button>
			<button type="button" disabled={busy} title="把本镜末个非空原文行移到时间轴下一镜开头" onClick={() => void run(() => moveRtcEpisodeShotLine(scope, "down"))}>下拆</button>
		</div>
		<div className="rtc-episode-shot-action-pair">
			<button type="button" disabled={busy} onClick={() => void run(() => insertRtcEpisodeShot(scope, "above", defaultDuration))}>上增</button>
			<button type="button" disabled={busy} onClick={() => void run(() => insertRtcEpisodeShot(scope, "below", defaultDuration))}>下增</button>
		</div>
		<button type="button" disabled={busy} onClick={() => void run(() => matchRtcEpisodeShotAssets(scope))}>提取资产</button>
		<button type="button" disabled={busy} onClick={() => void run(() => inferRtcEpisodeShot(scope))}>{inferring || inferPreparing ? "推理中…" : <>智能推理<RtcTextGenerationCost /></>}</button>
		<StoryGuidanceButton key={`${owner}:${episodeId}:${shot.id}`} value={shot.plotGuidance} disabled={busy}
			onChange={plotGuidance => show(updateRtcEpisodeShot(scope, { plotGuidance }))} />
		<button type="button" className="is-danger" disabled={busy} onClick={() => void run(() => deleteRtcEpisodeShot(scope))}>删除分镜</button>
		{feedback && <span className="rtc-episode-shot-action-status" role="status">{feedback}</span>}
	</div>;
}
