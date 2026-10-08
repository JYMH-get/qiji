import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ rtc: {} as any, project: {} as any, center: {} as any, assets: {} as any }));
vi.mock("@/store/rtcStore", () => ({ useRtcStore: { getState: () => h.rtc }, activeRtcDoc: (s: any) => s.activeDoc ?? s.doc }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: { getState: () => h.project } }));
vi.mock("./rtcAssetSelStore", () => ({ useRtcAssetSelStore: { getState: () => h.assets } }));
vi.mock("./panel/rtcCenterTabStore", () => ({ useRtcCenterTabStore: { getState: () => h.center } }));
import { applyRtcPlaybackCommand, playRtcFromToolbar, registerRtcPlaybackController, requestRtcPlayback, rtcPlaybackScope, useRtcPlaybackControl, type RtcPlaybackCommand } from "./rtcPlaybackControl";

const doc = (duration: number) => ({ id: "doc", name: "test", fps: 30, tracks: [{ id: "track", type: "video", segments: [{ id: "seg", kind: "media", targetStartUs: 0, targetDurationUs: duration }] }] });
let controllers: ReturnType<typeof registerRtcPlaybackController>[];
function connect() {
	let playing = false;
	const setPlaying = vi.fn((value: boolean) => { playing = value; controller.publish(value); });
	const command = vi.fn((action: RtcPlaybackCommand) => applyRtcPlaybackCommand(action, playing, setPlaying));
	const controller = registerRtcPlaybackController(rtcPlaybackScope(h.rtc), command);
	controllers.push(controller);
	return { controller, command, setPlaying, get playing() { return playing; } };
}
beforeEach(() => {
	controllers = [];
	h.project = { projectInstanceId: "project", isProjectLoading: false };
	h.rtc = { ownerProjectId: "project", ownerEpisodeKey: "ep", editingSubDocId: null, doc: doc(10_000_000), playheadUs: 3_000_000,
		setPlayhead: vi.fn((value: number) => { h.rtc.playheadUs = value; }) };
	h.center = { tab: "workbench", scriptEditorOpen: false, scriptEditorHidden: false,
		setTab: vi.fn((tab: string) => { h.center.tab = tab; if (h.center.scriptEditorOpen) h.center.scriptEditorHidden = true; }),
		setScriptEditorOpen: vi.fn(), };
	h.assets = { selected: null, mediaSel: null, clear: vi.fn(() => { h.assets.selected = null; h.assets.mediaSel = null; }) };
});
afterEach(() => { for (const controller of controllers) controller.dispose(); });

describe("RTC 工具栏播放命令", () => {
	it.each(["workbench", "overview"])("从%s页明确播放当前头，后台已播放时也不反转成暂停", tab => {
		const player = connect(); h.center.tab = tab;
		expect(playRtcFromToolbar()).toBe(true);
		expect(player.command).toHaveBeenLastCalledWith("play");
		expect(h.center.tab).toBe("preview"); expect(player.playing).toBe(true);
		expect(h.rtc.setPlayhead).not.toHaveBeenCalled(); expect(h.rtc.playheadUs).toBe(3_000_000);
		h.center.tab = tab;
		expect(playRtcFromToolbar()).toBe(true); expect(player.command).toHaveBeenLastCalledWith("play"); expect(player.playing).toBe(true);
	});

	it("无遮挡预览页正在播放时暂停，再点击从原位置继续", () => {
		const player = connect(); h.center.tab = "preview"; requestRtcPlayback("play");
		expect(playRtcFromToolbar()).toBe(true); expect(player.command).toHaveBeenLastCalledWith("pause"); expect(player.playing).toBe(false);
		expect(playRtcFromToolbar()).toBe(true); expect(player.playing).toBe(true);
		expect(h.rtc.setPlayhead).not.toHaveBeenCalled();
	});

	it.each(["asset", "media", "script"])("有%s遮挡时清遮挡并明确播放，剧本草稿不通过关闭动作丢弃", overlay => {
		const player = connect(); h.center.tab = "preview"; requestRtcPlayback("play");
		if (overlay === "asset") h.assets.selected = { cat: "characters", id: "C1" };
		if (overlay === "media") h.assets.mediaSel = { uri: "preview.mp4" };
		if (overlay === "script") h.center.scriptEditorOpen = true;
		expect(playRtcFromToolbar()).toBe(true); expect(player.command).toHaveBeenLastCalledWith("play");
		expect(player.playing).toBe(true); expect(h.assets.selected).toBeNull(); expect(h.assets.mediaSel).toBeNull();
		expect(h.center.setScriptEditorOpen).not.toHaveBeenCalled();
		if (overlay === "script") expect(h.center).toMatchObject({ scriptEditorOpen: true, scriptEditorHidden: true });
	});

	it("剧本面已隐藏时再次点击按预览暂停", () => {
		const player = connect(); h.center.tab = "preview"; h.center.scriptEditorOpen = true; h.center.scriptEditorHidden = true;
		requestRtcPlayback("play"); playRtcFromToolbar();
		expect(player.command).toHaveBeenLastCalledWith("pause"); expect(player.playing).toBe(false);
	});

	it("播放器未挂载时不缓存播放请求，仍允许切到预览页", () => {
		expect(playRtcFromToolbar()).toBe(false); expect(h.center.tab).toBe("preview");
		const player = connect(); expect(player.command).not.toHaveBeenCalled(); expect(player.playing).toBe(false);
	});
});

describe("播放状态与归属", () => {
	it.each(["ownerProjectId", "ownerEpisodeKey", "editingSubDocId", "doc"])("%s改变后旧播放器不能受理命令", field => {
		const player = connect();
		if (field === "doc") h.rtc.doc = { ...h.rtc.doc, id: "new-doc" }; else h.rtc[field] = "another";
		expect(requestRtcPlayback("play")).toBe(false); expect(player.command).not.toHaveBeenCalled();
	});

	it.each(["loading", "project"])("项目%s变化时不发给尚未换掉的旧播放器", change => {
		const player = connect();
		if (change === "loading") h.project.isProjectLoading = true; else h.project.projectInstanceId = "copy-with-same-ids";
		expect(requestRtcPlayback("play")).toBe(false); expect(player.command).not.toHaveBeenCalled();
	});

	it("自动结束可同步工具栏；卸载清状态并拒绝后续命令", () => {
		const player = connect(); requestRtcPlayback("play"); expect(useRtcPlaybackControl.getState().playing).toBe(true);
		player.setPlaying(false); expect(useRtcPlaybackControl.getState().playing).toBe(false);
		player.controller.dispose(); expect(useRtcPlaybackControl.getState()).toEqual({ scope: null, playing: false });
		expect(requestRtcPlayback("play")).toBe(false);
	});

	it("新挂载替代后旧通知/清理不能覆盖新状态", () => {
		const old = connect(); const current = connect(); requestRtcPlayback("play");
		old.controller.publish(false); old.controller.dispose();
		expect(useRtcPlaybackControl.getState().playing).toBe(true); expect(requestRtcPlayback("pause")).toBe(true);
		expect(current.command).toHaveBeenLastCalledWith("pause"); expect(old.command).not.toHaveBeenCalled();
	});
});

describe("播放器实际播放/暂停规则", () => {
	it("显式play在末尾不回零，播放器toggle保留重播语义", () => {
		const player = connect(); h.rtc.playheadUs = 10_000_000;
		expect(requestRtcPlayback("play")).toBe(false); expect(h.rtc.setPlayhead).not.toHaveBeenCalled(); expect(player.playing).toBe(false);
		expect(requestRtcPlayback("toggle")).toBe(true); expect(h.rtc.setPlayhead).toHaveBeenCalledWith(0); expect(player.playing).toBe(true);
	});

	it("连续toggle读取同步当前态，连续play不变成暂停", () => {
		const player = connect(); requestRtcPlayback("toggle"); requestRtcPlayback("toggle"); expect(player.playing).toBe(false);
		requestRtcPlayback("play"); requestRtcPlayback("play"); expect(player.playing).toBe(true);
	});

	it("复合编辑层按子层时长判断结束，不借用主时间轴长时长", () => {
		h.rtc.editingSubDocId = "sub"; h.rtc.activeDoc = doc(2_000_000); const player = connect();
		expect(requestRtcPlayback("play")).toBe(false); expect(player.playing).toBe(false);
		expect(requestRtcPlayback("toggle")).toBe(true); expect(h.rtc.playheadUs).toBe(0);
	});

	it("空文档不进入播放态", () => {
		h.rtc.doc = doc(0); const player = connect();
		expect(requestRtcPlayback("play")).toBe(false); expect(player.playing).toBe(false);
	});
});
