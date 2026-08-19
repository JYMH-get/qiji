/**
 * segActionsCore 纯逻辑单测：
 *  - 菜单项适用性判定（不适用=键不存在→菜单不显示；被阻断=带给用户看的原因，绝不静默失败）；
 *  - 结果占位落位算法（**优先源片段正上方的同类型轨道**，逐条往上找空闲，都没有才在源轨正上方新建）；
 *  - 结果占位/空白占位/音频分离产物的片段形状（target 窗口对齐、source 窗口继承、血缘字段）；
 *  - 派生记录标号（v{n}+ / v{n}-，与 Frame161195.doProcessVideo 同尺）。
 */
import { describe, it, expect } from "vitest";
import type { RtcDoc, RtcSegment, RtcTrack } from "@/types/rtc";
import {
	BLANK_PLACEHOLDER_US,
	audioSegmentFor,
	blankPlaceholderKinds,
	buildBlankPlaceholder,
	buildResultPlaceholder,
	derivedVideoLabel,
	isWindowFree,
	pickAudioTrack,
	pickResultTrack,
	segActionAvailability,
} from "./segActionsCore";

const SEC = 1_000_000;

function seg(id: string, startSec: number, durSec: number, extra: Partial<RtcSegment> = {}): RtcSegment {
	return {
		id,
		kind: "media",
		media: "video",
		targetStartUs: startSec * SEC,
		targetDurationUs: durSec * SEC,
		...extra,
	};
}
function track(id: string, type: RtcTrack["type"], segments: RtcSegment[] = [], extra: Partial<RtcTrack> = {}): RtcTrack {
	return { id, type, segments, ...extra };
}
function doc(tracks: RtcTrack[]): RtcDoc {
	return { id: "rtc1", name: "t", fps: 30, tracks };
}

const SHOT_REF = { episodeId: "e1", shotId: "s1" };
const TAURI = { tauri: true };

/* ────────────────────────── 适用性判定 ────────────────────────── */

describe("segActionAvailability", () => {
	const vTrack = track("v1", "video");

	it("成片视频片段（有 shotRef + uri）：超分/去字幕/音频分离/重新生成全部可执行", () => {
		const s = seg("a", 0, 5, { shotRef: SHOT_REF, uri: "asset://a.mp4" });
		const av = segActionAvailability(s, vTrack, TAURI);
		expect(av.upscale).toEqual({ ok: true });
		expect(av.desub).toEqual({ ok: true });
		expect(av.separateAudio).toEqual({ ok: true });
		expect(av.regenerate).toEqual({ ok: true });
	});

	it("无 shotRef 的视频（素材面板直接拖入）：超分/去字幕被阻断并说明原因；重新生成不显示；音频分离照常可用", () => {
		const s = seg("a", 0, 5, { uri: "asset://a.mp4" });
		const av = segActionAvailability(s, vTrack, TAURI);
		expect(av.upscale?.ok).toBe(false);
		expect(av.upscale && !av.upscale.ok && av.upscale.reason).toMatch(/没有关联分镜/);
		expect(av.desub?.ok).toBe(false);
		expect(av.regenerate).toBeUndefined(); // 键不存在 = 菜单不显示该项
		expect(av.separateAudio).toEqual({ ok: true }); // 音频分离与分镜无关
	});

	it("没有源文件的片段：超分/去字幕/音频分离均阻断（明确报错，不静默）", () => {
		const s = seg("a", 0, 5, { shotRef: SHOT_REF });
		const av = segActionAvailability(s, vTrack, TAURI);
		expect(av.upscale?.ok).toBe(false);
		expect(av.separateAudio?.ok).toBe(false);
	});

	it("非 Tauri（浏览器）：音频分离阻断并提示需桌面版", () => {
		const s = seg("a", 0, 5, { shotRef: SHOT_REF, uri: "asset://a.mp4" });
		const av = segActionAvailability(s, vTrack, { tauri: false });
		expect(av.separateAudio?.ok).toBe(false);
		const r = av.separateAudio && !av.separateAudio.ok ? av.separateAudio.reason : "";
		expect(r).toMatch(/桌面版/);
		expect(av.upscale).toEqual({ ok: true }); // 超分走服务端，与本机 ffmpeg 无关
	});

	it("锁轨：只拦音频分离（它要把源片段静音）；超分/去字幕不改源片段故放行", () => {
		const s = seg("a", 0, 5, { shotRef: SHOT_REF, uri: "asset://a.mp4" });
		const av = segActionAvailability(s, track("v1", "video", [], { locked: true }), TAURI);
		expect(av.separateAudio?.ok).toBe(false);
		expect(av.upscale).toEqual({ ok: true });
		expect(av.desub).toEqual({ ok: true });
	});

	it("图片片段：只有超分（去字幕的 video-erase 对图片不适用 → 键不存在）", () => {
		const s = seg("a", 0, 3, { media: "image", shotRef: SHOT_REF, uri: "asset://a.png" });
		const av = segActionAvailability(s, vTrack, TAURI);
		expect(av.upscale).toEqual({ ok: true });
		expect(av.desub).toBeUndefined();
		expect(av.separateAudio).toBeUndefined();
	});

	it("占位符：只有「重新生成」（且必须有 shotRef；裸占位无任何动作）", () => {
		const ph = seg("a", 0, 5, { kind: "placeholder", shotRef: SHOT_REF });
		expect(segActionAvailability(ph, vTrack, TAURI)).toEqual({ regenerate: { ok: true } });
		const bare = seg("b", 0, 5, { kind: "placeholder" });
		expect(segActionAvailability(bare, vTrack, TAURI)).toEqual({});
	});

	it("音频轨/文本轨片段：无 AI 动作", () => {
		const a = seg("a", 0, 5, { media: "audio", uri: "asset://a.m4a" });
		expect(segActionAvailability(a, track("t2", "audio"), TAURI)).toEqual({});
		expect(segActionAvailability(seg("c", 0, 5), track("t3", "text"), TAURI)).toEqual({});
	});
});

/* ────────────────────────── 落位算法 ────────────────────────── */

describe("isWindowFree", () => {
	it("相交=不空闲；首尾相接=空闲", () => {
		const t = track("v", "video", [seg("a", 2, 3)]); // 占 [2s,5s)
		expect(isWindowFree(t, 2 * SEC, 1 * SEC)).toBe(false);
		expect(isWindowFree(t, 4.5 * SEC, 1 * SEC)).toBe(false);
		expect(isWindowFree(t, 5 * SEC, 1 * SEC)).toBe(true); // 紧接其后
		expect(isWindowFree(t, 0, 2 * SEC)).toBe(true); // 紧接其前
	});
});

describe("pickResultTrack（结果占位落上方轨道）", () => {
	it("优先复用源片段正上方那条同类型轨道（该窗口空闲时）", () => {
		const d = doc([track("v0", "video"), track("v1", "video", [seg("a", 0, 5)]), track("au", "audio")]);
		expect(pickResultTrack(d, "v1", 0, 5 * SEC)).toEqual({ kind: "existing", trackId: "v0" });
	});

	it("正上方被占 → 继续往上找空闲的（不无脑新建，防轨道爆炸）", () => {
		const d = doc([
			track("v0", "video"), // 空闲
			track("v1", "video", [seg("x", 0, 5)]), // 该窗口被占
			track("v2", "video", [seg("a", 0, 5)]), // 源
		]);
		expect(pickResultTrack(d, "v2", 0, 5 * SEC)).toEqual({ kind: "existing", trackId: "v0" });
	});

	it("上方轨道被锁 → 跳过", () => {
		const d = doc([track("v0", "video", [], { locked: true }), track("v1", "video", [seg("a", 0, 5)])]);
		expect(pickResultTrack(d, "v1", 0, 5 * SEC)).toEqual({ kind: "create", insertAtIndex: 1 });
	});

	it("上方全被占/没有上方轨道 → 在源轨道正上方新建（insertAtIndex=源轨下标）", () => {
		const d = doc([track("v0", "video", [seg("x", 0, 5)]), track("v1", "video", [seg("a", 0, 5)]), track("au", "audio")]);
		expect(pickResultTrack(d, "v1", 0, 5 * SEC)).toEqual({ kind: "create", insertAtIndex: 1 });
		const only = doc([track("v1", "video", [seg("a", 0, 5)])]);
		expect(pickResultTrack(only, "v1", 0, 5 * SEC)).toEqual({ kind: "create", insertAtIndex: 0 });
	});

	it("上方的异类轨道（音频/文本）不作候选", () => {
		const d = doc([track("au", "audio"), track("v1", "video", [seg("a", 0, 5)])]);
		expect(pickResultTrack(d, "v1", 0, 5 * SEC)).toEqual({ kind: "create", insertAtIndex: 1 });
	});

	it("源轨道不存在（数据异常）→ 最前面新建", () => {
		expect(pickResultTrack(doc([track("v1", "video")]), "ghost", 0, SEC)).toEqual({ kind: "create", insertAtIndex: 0 });
	});
});

describe("pickAudioTrack（音频分离产物落位）", () => {
	it("首条未锁且窗口空闲的音频轨", () => {
		const d = doc([track("v", "video"), track("a1", "audio", [seg("x", 0, 5, { media: "audio" })]), track("a2", "audio")]);
		expect(pickAudioTrack(d, 0, 5 * SEC)).toEqual({ kind: "existing", trackId: "a2" });
	});
	it("锁轨跳过", () => {
		const d = doc([track("a1", "audio", [], { locked: true }), track("a2", "audio")]);
		expect(pickAudioTrack(d, 0, SEC)).toEqual({ kind: "existing", trackId: "a2" });
	});
	it("全被占/无音频轨 → 新建（追加末尾）", () => {
		const d = doc([track("v", "video"), track("a1", "audio", [seg("x", 0, 5, { media: "audio" })])]);
		expect(pickAudioTrack(d, 1 * SEC, 2 * SEC)).toEqual({ kind: "create", insertAtIndex: 2 });
		expect(pickAudioTrack(doc([track("v", "video")]), 0, SEC)).toEqual({ kind: "create", insertAtIndex: 1 });
	});
});

/* ────────────────────────── 片段构造 ────────────────────────── */

describe("buildResultPlaceholder（结果占位）", () => {
	const src = seg("src", 3, 4, { name: "分镜1", shotRef: SHOT_REF, uri: "asset://a.mp4", sourceStartUs: 2 * SEC, sourceDurationUs: 4 * SEC });

	it("target 窗口与源完全一致（上下层=版本堆叠），带血缘 originSegId，genKind=产物类型", () => {
		const p = buildResultPlaceholder(src, { id: "new", action: "upscale", status: "running" });
		expect(p.kind).toBe("placeholder");
		expect(p.targetStartUs).toBe(src.targetStartUs);
		expect(p.targetDurationUs).toBe(src.targetDurationUs);
		expect(p.originSegId).toBe("src");
		expect(p.genKind).toBe("video");
		expect(p.status).toBe("running");
		expect(p.name).toBe("超分 · 分镜1"); // 动作语义写在 name（genKind 只表产物类型）
		// 占位不带源素材（结果落地时才写 assetId/uri/source 窗口）
		expect(p.assetId).toBeUndefined();
		expect(p.uri).toBeUndefined();
		expect(p.sourceStartUs).toBeUndefined();
	});

	it("超分/去字幕的占位不继承 shotRef（不是分镜坑位，免得右栏错当分镜工作台）", () => {
		expect(buildResultPlaceholder(src, { id: "n", action: "upscale" }).shotRef).toBeUndefined();
		expect(buildResultPlaceholder(src, { id: "n", action: "desub" }).name).toBe("去字幕 · 分镜1");
	});

	it("重新生成（action=shot）的占位继承 shotRef——它就是新一版的分镜坑位", () => {
		const p = buildResultPlaceholder(src, { id: "n", action: "shot" });
		expect(p.shotRef).toEqual(SHOT_REF);
		expect(p.name).toBe("重新生成 · 分镜1");
	});

	it("未传 status/taskRef 时不写这两个字段（保持片段干净）", () => {
		const p = buildResultPlaceholder(src, { id: "n", action: "shot" });
		expect("status" in p).toBe(false);
		expect("taskRef" in p).toBe(false);
	});
});

describe("blankPlaceholderKinds / buildBlankPlaceholder（空白区添加占位）", () => {
	it("轨道类型决定可添加项：视频轨=视频+图片、音频轨=音频、文本轨=无", () => {
		expect(blankPlaceholderKinds("video")).toEqual(["video", "image"]);
		expect(blankPlaceholderKinds("audio")).toEqual(["audio"]);
		expect(blankPlaceholderKinds("text")).toEqual([]);
	});

	it("默认时长：视频/音频 5s、图片 3s；status=pending、genKind=产物类型、无 assetId/uri", () => {
		const v = buildBlankPlaceholder("video", 2.5 * SEC, "n1");
		expect(v.targetStartUs).toBe(2.5 * SEC);
		expect(v.targetDurationUs).toBe(BLANK_PLACEHOLDER_US.video);
		expect(v.status).toBe("pending");
		expect(v.genKind).toBe("video");
		expect(v.assetId).toBeUndefined();
		expect(v.uri).toBeUndefined();
		expect(buildBlankPlaceholder("image", 0, "n2").targetDurationUs).toBe(3 * SEC);
		expect(buildBlankPlaceholder("audio", 0, "n3").targetDurationUs).toBe(5 * SEC);
	});

	it("负时间点钳到 0，微秒取整", () => {
		expect(buildBlankPlaceholder("video", -5, "n").targetStartUs).toBe(0);
		expect(buildBlankPlaceholder("video", 1234.6, "n").targetStartUs).toBe(1235);
	});

	it("durUs 可选覆盖时长（图片占位走设置「图片默认时长」的入口）；非法值回退档位表", () => {
		expect(buildBlankPlaceholder("image", 0, "n", 4_500_000).targetDurationUs).toBe(4_500_000);
		expect(buildBlankPlaceholder("image", 0, "n", 0).targetDurationUs).toBe(BLANK_PLACEHOLDER_US.image);
		expect(buildBlankPlaceholder("image", 0, "n", Number.NaN).targetDurationUs).toBe(BLANK_PLACEHOLDER_US.image);
		expect(buildBlankPlaceholder("video", 0, "n", 7_000_000.4).targetDurationUs).toBe(7_000_000);
	});
});

describe("audioSegmentFor（音频分离产物）", () => {
	it("与源视频片段同 target 窗口、同 source 窗口（共用同一条时间线才对得上画面）", () => {
		const src = seg("v", 3, 4, { name: "分镜1", sourceStartUs: 2 * SEC, sourceDurationUs: 4 * SEC, speed: 2, volume: 0.5 });
		const a = audioSegmentFor(src, { id: "au1", assetId: "LC-1", uri: "asset://a.m4a" });
		expect(a).toEqual({
			id: "au1",
			kind: "media",
			media: "audio",
			name: "分镜1·音频",
			assetId: "LC-1",
			uri: "asset://a.m4a",
			targetStartUs: 3 * SEC,
			targetDurationUs: 4 * SEC,
			sourceStartUs: 2 * SEC,
			sourceDurationUs: 4 * SEC,
			speed: 2,
			volume: 0.5,
		});
	});

	it("源无 source 窗口 → 产物同样不建（不编造虚假源长）；speed=1 不写", () => {
		const a = audioSegmentFor(seg("v", 0, 5, { speed: 1 }), { id: "au", uri: "u" });
		expect("sourceStartUs" in a).toBe(false);
		expect("sourceDurationUs" in a).toBe(false);
		expect("speed" in a).toBe(false);
		expect(a.name).toBe("视频·音频"); // 源片段没名字时的兜底
	});
});

/* ────────────────────────── 派生记录标号 ────────────────────────── */

describe("derivedVideoLabel（与 Frame161195.doProcessVideo 同尺）", () => {
	it("源是第 n 条原始成片 → v{n}+ / v{n}-", () => {
		const shot = { videoUris: ["u1", "u2"] };
		expect(derivedVideoLabel(shot, "u2", "upscale")).toEqual({ label: "v2+", srcLabel: "v2" });
		expect(derivedVideoLabel(shot, "u1", "desub")).toEqual({ label: "v1-", srcLabel: "v1" });
	});

	it("链式处理（对 v3+ 再去字幕）：标号不叠加后缀，根记录号沿用 → v3-", () => {
		const shot = { videoUris: ["u1", "u2", "u3"], videoDerived: [{ uri: "up3", label: "v3+" }] };
		expect(derivedVideoLabel(shot, "up3", "desub")).toEqual({ label: "v3-", srcLabel: "v3+" });
	});

	it("源不在任何记录里（异常/外部素材）→ 回退 v1", () => {
		expect(derivedVideoLabel({}, "ghost", "upscale")).toEqual({ label: "v1+", srcLabel: "v1" });
	});
});
