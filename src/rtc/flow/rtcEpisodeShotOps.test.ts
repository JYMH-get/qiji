import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RtcDoc, RtcSegment } from "@/types/rtc";
import type { StoryboardShot, VideoEpisode } from "@/services/projectFile";
const mocks = vi.hoisted(() => ({ confirm: vi.fn(), match: vi.fn(), infer: vi.fn() }));
vi.mock("@/lib/confirmDialog", () => ({ confirmDialog: mocks.confirm }));
vi.mock("../panel/shotMatchActions", () => ({ matchShotAssets: mocks.match }));
vi.mock("../panel/shotGenActions", () => ({ inferShotPrompts: mocks.infer }));
import { useProjectStore } from "@/store/projectStore";
import { useRtcStore } from "@/store/rtcStore";
import { useLibraryStore } from "@/store/libraryStore";
import { claimShotPreparation } from "../panel/rtcShotSubmission";
import {
	deleteRtcEpisodeShot, inferRtcEpisodeShot, insertRtcEpisodeShot, matchRtcEpisodeShotAssets,
	moveRtcEpisodeShotLine, orderedRtcEpisodeShots, updateRtcEpisodeShot,
} from "./rtcEpisodeShotOps";

const S = 1_000_000;
const scope = { owner: "owner", episodeId: "ep", shotId: "b" };
const shot = (id: string, index: number, text = id): StoryboardShot => ({ id, index, title: `分镜${index}`, prompt: "", scriptSegment: text, materials: [] });
const seg = (id: string, shotId: string, start: number, duration = 5, extra: Partial<RtcSegment> = {}): RtcSegment => ({
	id, kind: "media", media: "video", name: `分镜${({ a: 1, b: 2, c: 3 } as Record<string, number>)[shotId]}`,
	uri: `fixture://${id}`, targetStartUs: start * S, targetDurationUs: duration * S, shotRef: { episodeId: "ep", shotId }, ...extra,
});
const makeDoc = (): RtcDoc => ({ id: "doc", name: "本集", fps: 30, tracks: [
	{ id: "main", type: "video", segments: [seg("a-seg", "a", 0), seg("b-seg", "b", 5), seg("c-seg", "c", 10)] },
], markers: [{ id: "marker", timeUs: 10 * S, color: "#fff" }] });
const doc = () => useRtcStore.getState().doc!;
const shots = () => useProjectStore.getState().episodes.find(ep => ep.id === "ep")!.shots;
const find = (id: string, source = doc()) => source.tracks.flatMap(track => track.segments).find(item => item.id === id)!;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.confirm.mockResolvedValue(true);
	mocks.match.mockReturnValue({ prompt: "已匹配", added: 2 });
	mocks.infer.mockResolvedValue(undefined);
	const episodes: VideoEpisode[] = [
		{ id: "ep", index: 1, title: "本集", scriptText: "原文", shots: [shot("c", 3), shot("a", 1), shot("b", 2, "首行\n\n末行")] },
		{ id: "other", index: 2, title: "另一集", scriptText: "另一集", shots: [shot("b", 1)] },
	];
	const initial = makeDoc();
	useProjectStore.setState({ projectInstanceId: "owner", isProjectLoading: false, rtcEpisodeId: "ep", episodes,
		rtcDocs: { ep: initial, other: { ...makeDoc(), id: "other-doc" } }, pendingGens: [], inferTasks: [], mediaSettings: {}, assetBlobs: {},
		save: vi.fn(async () => {}), scheduleAutoSave: vi.fn(),
	});
	useRtcStore.getState().loadDoc(initial);
	useLibraryStore.setState({ assets: {} });
});

describe("RTC 分镜原文和元数据操作", () => {
	it("按时间轴去重排序；上拆移动首个非空行，保留其他正文和视频", () => {
		const initial = doc();
		initial.tracks.push({ id: "version", type: "video", segments: [seg("b-version", "b", 6)] });
		expect(orderedRtcEpisodeShots(initial, "ep", shots()).map(item => item.id)).toEqual(["a", "b", "c"]);
		expect(moveRtcEpisodeShotLine(scope, "up")).toEqual({ ok: true });
		expect(shots().find(item => item.id === "a")?.scriptSegment).toBe("a\n首行");
		expect(shots().find(item => item.id === "b")?.scriptSegment).toBe("末行");
		expect(shots().find(item => item.id === "c")?.scriptSegment).toBe("c");
		expect(doc()).toBe(initial);
	});

	it("下拆移动末个非空行到时间轴下一镜开头", () => {
		expect(moveRtcEpisodeShotLine(scope, "down").ok).toBe(true);
		expect(shots().find(item => item.id === "c")?.scriptSegment).toBe("末行\nc");
		expect(shots().find(item => item.id === "b")?.scriptSegment).toBe("首行");
		expect(moveRtcEpisodeShotLine({ ...scope, shotId: "a" }, "up").ok).toBe(false);
	});

	it("邻镜正在准备或推理时不移动原文；释放后可操作", () => {
		const held = claimShotPreparation("ep", "a", "infer")!;
		try { expect(moveRtcEpisodeShotLine(scope, "up").ok).toBe(false); }
		finally { held.release(); }
		expect(shots().find(item => item.id === "b")?.scriptSegment).toBe("首行\n\n末行");
		expect(moveRtcEpisodeShotLine(scope, "up").ok).toBe(true);
	});

	it("匹配和单镜推理复用现有入口，剧情引导写回本镜", async () => {
		expect(matchRtcEpisodeShotAssets(scope)).toMatchObject({ ok: true });
		expect(mocks.match).toHaveBeenCalledWith("ep", "b");
		expect(updateRtcEpisodeShot(scope, { plotGuidance: "保留停顿" }).ok).toBe(true);
		expect(shots().find(item => item.id === "b")?.plotGuidance).toBe("保留停顿");
		expect(await inferRtcEpisodeShot(scope)).toEqual({ ok: true });
		expect(mocks.infer).toHaveBeenCalledWith("ep", "b");
	});

	it("推理动态加载期间切项目，不发起旧镜请求", async () => {
		const pending = inferRtcEpisodeShot(scope);
		useProjectStore.setState({ projectInstanceId: "new-owner" });
		expect((await pending).ok).toBe(false);
		expect(mocks.infer).not.toHaveBeenCalled();
	});
});

describe("RTC 新增分镜与时间轴联动", () => {
	it("上增插占位，后续各轨、组合早起成员和标记一起移动", () => {
		const initial = makeDoc();
		initial.tracks[0].segments[1].groupId = "group";
		initial.tracks.push(
			{ id: "audio", type: "audio", segments: [seg("voice", "b", 4, 1, { media: "audio", groupId: "group", shotRef: undefined })] },
			{ id: "text", type: "text", segments: [seg("subtitle", "b", 5, 2, { shotRef: undefined })] },
		);
		useRtcStore.getState().loadDoc(initial);
		const other = useProjectStore.getState().rtcDocs.other;
		const result = insertRtcEpisodeShot(scope, "above", 3);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.reason);
		const inserted = doc().tracks[0].segments.find(item => item.shotRef?.shotId === result.shotId)!;
		expect(inserted).toMatchObject({ kind: "placeholder", targetStartUs: 5 * S, targetDurationUs: 3 * S });
		expect(shots().map(item => item.id)).toEqual(["a", result.shotId, "b", "c"]);
		expect(find("b-seg").targetStartUs).toBe(8 * S);
		expect(find("c-seg").targetStartUs).toBe(13 * S);
		expect(find("voice").targetStartUs).toBe(7 * S);
		expect(find("subtitle").targetStartUs).toBe(8 * S);
		expect(doc().markers?.[0].timeUs).toBe(13 * S);
		expect(useProjectStore.getState().rtcDocs.other).toBe(other);
	});

	it("下增同步已有撤销和重做快照，新镜不会被无关剪辑撤销移除", () => {
		const edit = (position: number) => useRtcStore.getState().commit(before => ({ ...before, tracks: before.tracks.map(track => ({
			...track, segments: track.segments.map(item => item.id === "c-seg" ? { ...item, targetStartUs: position * S } : item),
		})) }));
		edit(11); edit(12); useRtcStore.getState().undo();
		const result = insertRtcEpisodeShot(scope, "below", 2);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.reason);
		const hasAdded = () => doc().tracks[0].segments.some(item => item.shotRef?.shotId === result.shotId);
		expect(hasAdded()).toBe(true);
		expect(find("c-seg").targetStartUs).toBe(13 * S);
		useRtcStore.getState().undo();
		expect(hasAdded()).toBe(true);
		expect(find("c-seg")).toMatchObject({ targetStartUs: 12 * S, name: "分镜4" });
		useRtcStore.getState().redo();
		expect(hasAdded()).toBe(true);
		expect(find("c-seg").targetStartUs).toBe(13 * S);
	});

	it.each(["main-lock", "linked-lock", "crossing"])("%s 时拒绝新增，不留半份分镜或占位", (reason) => {
		const initial = makeDoc();
		if (reason === "main-lock") initial.tracks[0].locked = true;
		if (reason === "linked-lock") initial.tracks.push({ id: "audio", type: "audio", locked: true, segments: [seg("audio", "c", 10, 2, { shotRef: undefined })] });
		if (reason === "crossing") {
			initial.tracks[0].segments = [seg("a-seg", "a", 0, 20)];
			initial.tracks.push({ id: "upper", type: "video", segments: [seg("b-seg", "b", 5)] });
		}
		useRtcStore.getState().loadDoc(initial);
		const originalShots = shots();
		expect(insertRtcEpisodeShot(scope, "above", 3)).toMatchObject({ ok: false, reason: expect.any(String) });
		expect(doc()).toBe(initial);
		expect(shots()).toBe(originalShots);
	});
});

describe("RTC 删除分镜与成品保留", () => {
	it("精确删除本集各版本和复合内绑定段，保留其他镜、他集同ID、宿主和成品", async () => {
		const initial = makeDoc();
		initial.tracks.push({ id: "upper", type: "video", segments: [
			seg("b-version", "b", 5), seg("foreign", "b", 20, 5, { shotRef: { episodeId: "other", shotId: "b" } }),
			{ id: "host", kind: "compound", subDocId: "sub", targetStartUs: 30 * S, targetDurationUs: 10 * S },
		] });
		initial.subDocs = { sub: { id: "sub", name: "复合", tracks: [{ id: "child", type: "video", segments: [seg("b-child", "b", 0), seg("c-child", "c", 5)] }] } };
		useRtcStore.getState().loadDoc(initial);
		useProjectStore.getState().updateShot("ep", "b", { videoUri: "fixture://legacy", videoUris: ["fixture://legacy", "fixture://history"], storyboardUri: "fixture://image" });
		const otherEpisode = useProjectStore.getState().episodes[1];
		const otherDoc = useProjectStore.getState().rtcDocs.other;
		expect(await deleteRtcEpisodeShot(scope)).toEqual({ ok: true });
		expect(shots().map(item => item.id)).toEqual(["a", "c"]);
		expect(doc().tracks.flatMap(track => track.segments).map(item => item.id)).toEqual(["a-seg", "c-seg", "foreign", "host"]);
		expect(doc().subDocs?.sub.tracks[0].segments.map(item => item.id)).toEqual(["c-child"]);
		expect(find("c-seg").targetStartUs).toBe(10 * S);
		expect(find("host").targetDurationUs).toBe(10 * S);
		expect(useProjectStore.getState().episodes[1]).toBe(otherEpisode);
		expect(useProjectStore.getState().rtcDocs.other).toBe(otherDoc);
		const assets = Object.values(useLibraryStore.getState().assets);
		expect(assets.map(item => item.uri)).toEqual(expect.arrayContaining(["fixture://legacy", "fixture://history", "fixture://image", "fixture://b-seg", "fixture://b-version", "fixture://b-child"]));
		expect(assets.every(item => item.episodeId === "ep")).toBe(true);
	});

	it("删除后撤销/重做其他剪辑不会复活已删镜；软删除素材不复活", async () => {
		useLibraryStore.getState().addAsset({ id: "deleted", kind: "video", name: "删过的素材", uri: "fixture://b-seg", deletedByUser: true,
			createdAt: "2026-10-08T00:00:00Z", thumbnailUri: null, localPath: null, serverAssetId: null, origin: "generated", episodeId: "ep" });
		useRtcStore.getState().commit(before => ({ ...before, name: "剪辑后的标题" }));
		expect((await deleteRtcEpisodeShot(scope)).ok).toBe(true);
		useRtcStore.getState().undo();
		expect(doc().tracks[0].segments.some(item => item.shotRef?.shotId === "b")).toBe(false);
		useRtcStore.getState().redo();
		expect(doc().tracks[0].segments.some(item => item.shotRef?.shotId === "b")).toBe(false);
		expect(useLibraryStore.getState().assets.deleted.deletedByUser).toBe(true);
		expect(Object.values(useLibraryStore.getState().assets).filter(item => item.uri === "fixture://b-seg")).toHaveLength(1);
	});

	it("确认期间切项目不删新项目的同ID分镜，取消也不改", async () => {
		mocks.confirm.mockResolvedValueOnce(false);
		const initial = shots();
		expect((await deleteRtcEpisodeShot(scope)).ok).toBe(true);
		expect(shots()).toBe(initial);
		let confirm!: (value: boolean) => void;
		mocks.confirm.mockImplementationOnce(() => new Promise<boolean>(resolve => { confirm = resolve; }));
		const pending = deleteRtcEpisodeShot(scope);
		useProjectStore.setState({ projectInstanceId: "new-owner" });
		confirm(true);
		expect((await pending).ok).toBe(false);
		expect(shots()).toBe(initial);
	});

	it("锁定的复合宿主保护子分镜；失败不会删元数据", async () => {
		const initial = makeDoc();
		initial.subDocs = { sub: { id: "sub", name: "复合", tracks: [{ id: "child", type: "video", segments: [seg("b-child", "b", 0)] }] } };
		initial.tracks.push({ id: "locked-host", type: "video", locked: true, segments: [{ id: "host", kind: "compound", subDocId: "sub", targetStartUs: 30 * S, targetDurationUs: 5 * S }] });
		useRtcStore.getState().loadDoc(initial);
		expect((await deleteRtcEpisodeShot(scope)).ok).toBe(false);
		expect(shots().some(item => item.id === "b")).toBe(true);
		expect(doc()).toBe(initial);
	});
});

describe("身份与在途任务保护", () => {
	it.each(["project", "episode", "loading", "infer", "generation", "preparing"])("%s 阻止增删及元数据写入", async (reason) => {
		let held: ReturnType<typeof claimShotPreparation> = null;
		if (reason === "project") useProjectStore.setState({ projectInstanceId: "different" });
		if (reason === "episode") useProjectStore.setState({ rtcEpisodeId: "other" });
		if (reason === "loading") useProjectStore.setState({ isProjectLoading: true });
		if (reason === "infer") useProjectStore.setState({ inferTasks: [{ id: "infer", episodeId: "ep", mode: "multi", status: "running", createdAt: 0 }] });
		if (reason === "generation") useProjectStore.setState({ pendingGens: [{ id: "job", status: "running", shot: { episodeId: "ep", shotId: "b", field: "video" }, purpose: "video.generate", prompt: "", label: "视频", createdAt: 0 }] });
		if (reason === "preparing") held = claimShotPreparation("ep", "b", "video");
		const original = shots();
		try {
			expect(insertRtcEpisodeShot(scope, "above").ok).toBe(false);
			expect((await deleteRtcEpisodeShot(scope)).ok).toBe(false);
			expect(updateRtcEpisodeShot(scope, { plotGuidance: "迟到草稿" }).ok).toBe(false);
			expect(shots()).toBe(original);
		} finally { held?.release(); }
	});
});
