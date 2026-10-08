import { create } from "zustand";
import { useProjectStore } from "@/store/projectStore";
import { activeRtcDoc, useRtcStore } from "@/store/rtcStore";
import { docDurationUs } from "@/lib/rtcOps";
import { useRtcAssetSelStore } from "./rtcAssetSelStore";
import { useRtcCenterTabStore } from "./panel/rtcCenterTabStore";

export type RtcPlaybackCommand = "play" | "pause" | "toggle";

/** 会话桥只镜像播放器状态，不另起计时器，也不进入项目/撤销/持久化。 */
export const useRtcPlaybackControl = create<{ scope: string | null; playing: boolean }>(() => ({ scope: null, playing: false }));

export function rtcPlaybackScope(state: Pick<ReturnType<typeof useRtcStore.getState>, "ownerProjectId" | "ownerEpisodeKey" | "editingSubDocId" | "doc">): string {
	return JSON.stringify([state.ownerProjectId, state.ownerEpisodeKey, state.editingSubDocId, state.doc?.id]);
}

let active: { token: symbol; scope: string; command: (command: RtcPlaybackCommand) => boolean } | null = null;

/** 仅当前挂载的播放器接收命令；切项目/分集/复合层或卸载后，旧引用不能污染新播放器。 */
export function registerRtcPlaybackController(scope: string, command: (command: RtcPlaybackCommand) => boolean) {
	const token = Symbol("rtc-player");
	active = { token, scope, command };
	useRtcPlaybackControl.setState({ scope, playing: false });
	return {
		publish(playing: boolean) {
			if (active?.token === token) useRtcPlaybackControl.setState({ playing });
		},
		dispose() {
			if (active?.token !== token) return;
			active = null;
			useRtcPlaybackControl.setState({ scope: null, playing: false });
		},
	};
}

export function requestRtcPlayback(command: RtcPlaybackCommand): boolean {
	const rtc = useRtcStore.getState(), project = useProjectStore.getState();
	if (!active || !rtc.doc || project.isProjectLoading || rtc.ownerProjectId !== project.projectInstanceId
		|| active.scope !== rtcPlaybackScope(rtc)) return false;
	return active.command(command);
}

/** 播放时长以当前编辑层为准；显式 play 保持播放头，toggle 才提供播完重播。 */
export function applyRtcPlaybackCommand(command: RtcPlaybackCommand, playing: boolean, setPlaying: (value: boolean) => void): boolean {
	if (command === "pause" || command === "toggle" && playing) {
		setPlaying(false);
		return true;
	}
	const rtc = useRtcStore.getState(), view = activeRtcDoc(rtc);
	const duration = view ? docDurationUs(view) : 0;
	if (duration <= 0) return false;
	if (rtc.playheadUs >= duration - 1) {
		if (command === "play") return false;
		rtc.setPlayhead(0);
	}
	setPlaying(true);
	return true;
}

/** 从其它页或遮挡层点播放始终发 play；只有已在时间轴预览播放时才暂停。 */
export function playRtcFromToolbar(): boolean {
	const center = useRtcCenterTabStore.getState();
	const assets = useRtcAssetSelStore.getState();
	const playback = useRtcPlaybackControl.getState();
	const pause = center.tab === "preview" && (!center.scriptEditorOpen || center.scriptEditorHidden) && !assets.selected && !assets.mediaSel
		&& playback.scope === rtcPlaybackScope(useRtcStore.getState()) && playback.playing;
	assets.clear();
	center.setTab("preview");
	return requestRtcPlayback(pause ? "pause" : "play");
}
