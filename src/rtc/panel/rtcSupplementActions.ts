import { resolveEpisodeKey, useProjectStore } from "@/store/projectStore";
import { activeRtcDoc, useRtcStore } from "@/store/rtcStore";
import { planRtcSupplement, renameRtcShotTitles } from "./rtcSupplement";

/** 同步受理当前工作台目标；调用方仅需展示失败 reason。 */
export function toggleRtcSupplement(args: { owner: string; episodeId: string; shotId: string; segId: string }): { ok: true } | { ok: false; reason: string } {
	const { owner, episodeId, shotId, segId } = args;
	const project = useProjectStore.getState(), rtc = useRtcStore.getState();
	if (project.projectInstanceId !== owner || project.isProjectLoading || rtc.ownerProjectId !== owner
		|| rtc.ownerEpisodeKey !== episodeId || resolveEpisodeKey(project.rtcEpisodeId, project.episodes) !== episodeId) {
		return { ok: false, reason: "项目或分集已切换，请重新选择素材。" };
	}
	const episode = project.episodes.find(e => e.id === episodeId);
	const shot = episode?.shots.find(s => s.id === shotId);
	const view = activeRtcDoc(rtc);
	if (!episode || !shot || !view) return { ok: false, reason: "素材关联的分镜已不存在。" };
	const plan = planRtcSupplement({ doc: view, shots: episode.shots, episodeId, shotId, segId, enabled: !shot.isSupplement });
	if (!plan.ok) return plan;
	if (plan.shots === episode.shots) return { ok: true };
	project.setEpisodeShots(episodeId, plan.shots);
	// 分镜编号是项目元数据（与表格修改相同），不独立加入剪辑撤销栈；自动名只是其派生显示。
	// 同步已有 past/future，避免随后撤销一个移动动作又把自动编号复活为旧名。
	const rename = (doc: NonNullable<typeof rtc.doc>) => renameRtcShotTitles(doc, episodeId, episode.shots, plan.shots);
	useRtcStore.getState().patchSilent(rename);
	const current = useRtcStore.getState();
	const past = current.past.map(rename), future = current.future.map(rename);
	if (past.some((doc, i) => doc !== current.past[i]) || future.some((doc, i) => doc !== current.future[i])) {
		useRtcStore.setState({ past, future });
	}
	void useProjectStore.getState().save(true);
	return { ok: true };
}
