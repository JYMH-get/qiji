/**
 * rtcClipboard —— 时间轴剪贴板（**会话级**：不落盘、不跨窗口、不接系统剪贴板）。
 *
 * 只存「剪贴板条目」（片段模板 + 原轨身份 + 相对偏移，见 timeline/rtcClipboardCore），
 * 纯逻辑全在 core 里，本 store 只是个可订阅的容器（工具条据此灰置「粘贴」按钮）。
 *
 * ⚠ 项目隔离（与 rtcStore 同规矩）：切项目即清空——剪贴板里的 assetId/uri 指向的是**上一个项目**的
 *   素材，粘进新项目就是串项目的脏引用。模块级订阅 projectStore.projectInstanceId 落地。
 */
import { create } from "zustand";
import { useProjectStore } from "@/store/projectStore";
import type { RtcClipEntry } from "./timeline/rtcClipboardCore";

interface RtcClipboardState {
	entries: RtcClipEntry[];
	/** 写入剪贴板（空数组=清空） */
	setEntries: (entries: RtcClipEntry[]) => void;
}

export const useRtcClipboard = create<RtcClipboardState>((set) => ({
	entries: [],
	setEntries: (entries) => set({ entries }),
}));

/* 切项目 → 清空剪贴板（模块级订阅，随首次 import 常驻；同项目内的任何写入都不受影响） */
let prevInstanceId = useProjectStore.getState().projectInstanceId;
useProjectStore.subscribe((ps) => {
	if (ps.projectInstanceId === prevInstanceId) return;
	prevInstanceId = ps.projectInstanceId;
	if (useRtcClipboard.getState().entries.length) useRtcClipboard.getState().setEntries([]);
});
