import { memo, useEffect, useMemo, useState } from "react";
import type { StoryboardShot } from "@/services/projectFile";
import { useProjectStore } from "@/store/projectStore";
import { useCatalogStore } from "@/store/catalogStore";
import { useSettingsStore } from "@/store/settingsStore";
import { openLightbox } from "@/store/lightboxStore";
import { resolveDisplayUri } from "@/services/projectAssetHeal";
import { listPresetSchemes } from "@/lib/presetSchemes";
import { JobChips, ShotPromptField } from "../panel/shotWorkbenchParts";
import { genShotStoryboard } from "../panel/shotGenActions";
import { useShotPreparing } from "../panel/rtcShotSubmission";
import { RtcMaterialStrip } from "../panel/RtcMaterialStrip";
import { episodeStoryboardUris } from "./rtcEpisodeWorkbenchCore";
import { RtcEpisodeShotActions } from "./RtcEpisodeShotActions";
import { RtcShotGenerationCost } from "../panel/RtcGenerationCost";

function EpisodeStoryboardImage({ uri, name, disabled = false, onClick }: { uri: string; name: string; disabled?: boolean; onClick?: () => void }) {
	const owner = useProjectStore(s => s.projectInstanceId);
	const [resolved, setResolved] = useState<{ uri: string; src: string } | null>(null);
	useEffect(() => {
		let alive = true;
		void resolveDisplayUri(uri).then(src => {
			if (alive && useProjectStore.getState().projectInstanceId === owner) setResolved({ uri, src });
		}).catch(() => { /* Keep the empty state if a stored image cannot be recovered. */ });
		return () => { alive = false; };
	}, [uri, owner]);
	const src = resolved?.uri === uri ? resolved.src : "";
	return <button type="button" className="rtc-episode-image" aria-label={name} disabled={!src || disabled}
		onClick={() => onClick ? onClick() : openLightbox({ uri: src, media: "image", name })}>
		{src ? <img src={src} alt={name} loading="lazy" draggable={false} /> : <span>载入图片…</span>}
	</button>;
}

export const RtcEpisodeShotRow = memo(function RtcEpisodeShotRow({ owner, episodeId, shot, sameSource, defaultDuration, locked, onOpenShot }: {
	owner: string; episodeId: string; shot: StoryboardShot; sameSource: boolean; defaultDuration: number; locked: boolean;
	onOpenShot?: (shotId: string) => void;
}) {
	const [promptTab, setPromptTab] = useState<"storyboardPrompt" | "videoPrompt">("storyboardPrompt");
	const fieldKey = sameSource ? "unifiedPrompt" : promptTab;
	const presetCatalog = useCatalogStore(s => s.catalog);
	const customPresets = useSettingsStore(s => s.customPresets);
	const presets = useMemo(() => listPresetSchemes(fieldKey === "videoPrompt" ? "video" : "image"), [presetCatalog, customPresets, fieldKey]);
	const inferring = useProjectStore(s => s.inferTasks.some(t => t.episodeId === episodeId && t.shotId === shot.id && t.status === "running"));
	const busy = locked || inferring;
	const imagePreparing = useShotPreparing(episodeId, shot.id, "storyboard");
	const images = episodeStoryboardUris(shot);
	const currentUri = shot.storyboardUri || images[0];
	const current = () => {
		const state = useProjectStore.getState();
		return state.projectInstanceId === owner && !state.isProjectLoading
			&& state.episodes.some(ep => ep.id === episodeId && ep.shots.some(s => s.id === shot.id));
	};
	const update = (patch: Partial<StoryboardShot>) => {
		if (!current()) return;
		const state = useProjectStore.getState();
		if (state.inferTasks.some(t => t.episodeId === episodeId && t.status === "running" && (t.mode !== "single" || t.shotId === shot.id))) return;
		state.updateShot(episodeId, shot.id, patch);
	};
	return <tr data-episode-shot={shot.id}>
		<td className="rtc-episode-shot-name">
			<RtcEpisodeShotActions owner={owner} episodeId={episodeId} shot={shot} disabled={busy} defaultDuration={defaultDuration} onOpenShot={onOpenShot} />
		</td>
		<td><textarea className="rtc-episode-shot-script" aria-label={`${shot.title}原文`} value={shot.scriptSegment || ""}
			disabled={busy} placeholder="填写分镜原文" onChange={event => update({ scriptSegment: event.target.value })} /></td>
		<td><div className="rtc-episode-materials"><RtcMaterialStrip episodeId={episodeId} shotId={shot.id} disabled={busy} /></div></td>
		<td><div className="rtc-episode-prompt-cell">
			{!sameSource && <div className="rtc-episode-prompt-tabs" role="group" aria-label={`${shot.title}提示词类型`}>
				<button type="button" aria-pressed={promptTab === "storyboardPrompt"} onClick={() => setPromptTab("storyboardPrompt")}>图片提示词</button>
				<button type="button" aria-pressed={promptTab === "videoPrompt"} onClick={() => setPromptTab("videoPrompt")}>视频提示词</button>
			</div>}
			{busy ? <textarea className="rtc-episode-prompt-readonly" aria-label={`${shot.title}提示词（推理中）`} disabled value={shot[fieldKey] || ""} placeholder="推理中，结果将流式回填…" /> : <ShotPromptField key={fieldKey} episodeId={episodeId} shotId={shot.id} shot={shot} fieldKey={fieldKey}
				label={sameSource ? "同源提示词" : promptTab === "storyboardPrompt" ? "图片提示词" : "视频提示词"}
				presetSchemes={presets} inferring={false} fill />}
		</div></td>
		<td><div className="rtc-episode-storyboard">
			{currentUri ? <EpisodeStoryboardImage key={currentUri} uri={currentUri} name={`${shot.title}分镜图`} /> : <div className="rtc-episode-image-empty">暂无分镜图</div>}
			{images.length > 1 && <div className="rtc-episode-image-history" role="group" aria-label={`${shot.title}图片历史`}>
				{images.map((uri, index) => <span key={uri} data-current={uri === currentUri || undefined}>
					<EpisodeStoryboardImage uri={uri} name={`${shot.title}图片历史${index + 1}`} disabled={busy} onClick={() => update({ storyboardUri: uri })} />
				</span>)}
			</div>}
			<JobChips shotId={shot.id} field="storyboard" />
			<button type="button" disabled={busy || imagePreparing} onClick={() => { if (current()) void genShotStoryboard(episodeId, shot.id); }}>{imagePreparing ? "准备中…" : "生成图片"}{!imagePreparing && <RtcShotGenerationCost shot={shot} field="storyboard" />}</button>
		</div></td>
	</tr>;
});
