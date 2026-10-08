import { InferenceStrategyPicker } from "@/components/InferenceStrategyPicker";
import { normalInferenceStrategy, projectInferenceStrategy } from "@/lib/inferenceStrategy";
import { useCatalogStore } from "@/store/catalogStore";
import { useProjectStore } from "@/store/projectStore";
import { inferShotPrompts } from "./shotGenActions";
import { RtcTextGenerationCost } from "./RtcGenerationCost";

/** Share the project creation strategy; the selected RTC shot always requests a single-card output. */
export function RtcShotInferenceControls({ episodeId, shotId, busy }: { episodeId: string; shotId: string; busy: boolean }) {
	const owner = useProjectStore(state => state.projectInstanceId);
	const settings = useProjectStore(state => state.mediaSettings);
	const templates = useCatalogStore(state => state.catalog?.templates);
	const strategy = normalInferenceStrategy(projectInferenceStrategy(settings), templates ?? []);
	const current = () => {
		const state = useProjectStore.getState();
		return state.projectInstanceId === owner && !state.isProjectLoading
			&& state.episodes.some(episode => episode.id === episodeId && episode.shots.some(shot => shot.id === shotId));
	};
	return (
		<div role="group" aria-label="本分镜提示词推理" style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flexWrap: "wrap" }}>
			<button type="button" disabled={busy}
				title="对本分镜单卡推理：使用所选方案，覆盖当前提示词"
				onClick={() => { if (current()) void inferShotPrompts(episodeId, shotId, { strategy }); }}
				style={{ padding: "3px 10px", fontSize: 11, borderRadius: 6, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(255,255,255,0.06)", color: "#eee", whiteSpace: "nowrap", cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.5 : 1 }}>
				{busy ? "推理中…" : "推理提示词"}
				{!busy && <RtcTextGenerationCost />}
			</button>
			<InferenceStrategyPicker value={strategy} disabled={busy} onChange={value => {
				if (current()) useProjectStore.getState().setMediaSettings({ inferenceStrategy: value });
			}} />
		</div>
	);
}
