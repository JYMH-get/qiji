/**
 * rtcShotPlaceholders —— 「分镜 → 时间轴占位符」纯逻辑（可单测，零 store 依赖）。
 *
 * 语义（定稿）：
 *   - 把某分集的 shots 按顺序**追加**为 placeholder 片段：目标轨=第一条 video 轨（没有则新建），
 *     起点=该轨末尾片段结束处（空轨从 0），每镜时长=durationSec 换微秒（缺省 3s，钳 MIN 以上）；
 *   - **幂等**：时间轴上已存在同 shotRef 的片段（任意轨、无论是否已被替换成 media——按 shotRef 判定）
 *     则跳过并计入 skipped，绝不重复添加；
 *   - 已有成片的镜（shot.videoUri 存在）直接生成 kind:"media" 片段（assetId 经调用方 resolve 回调
 *     反查台账、uri=videoUri、source=[0, durationSec µs]）——纯函数不 import store；
 *   - 命名与资产面板 rtcAssetData 一致：单集「分镜N」（=shot.title）、多集「N集·分镜N」；
 *   - 全部跳过/空分集时返回**原 doc 引用**（rtcStore.commit 视为 no-op：不进 undo 栈不落盘）。
 *
 *   - **原文参考**（第238轮补充10 定稿）：原文**不落轨**——由 rtcScriptLane 从主轨片段的
 *     shotRef 实时派生（时间轴车道 + 预览窗参考条），跟随片段挪动/分割/伸缩、分镜原文改了
 *     立即变，本模块不再铺任何 role:"script" 片段。
 *
 * ⚠ 红线：只存 assetId/uri 引用，绝不存 base64；本模块不发起任何生成请求。
 */
import { genId } from "@/lib/id";
import type { RtcDoc, RtcSegment, RtcTrack } from "@/types/rtc";
import { createRtcTrack } from "@/types/rtc";
import type { AssetBlob, StoryboardShot, VideoEpisode } from "@/services/projectFile";

/** 缺省每镜时长（微秒）：分镜没写 durationSec 时按 3s 占位 */
export const DEFAULT_SHOT_DUR_US = 3_000_000;
/** 片段最小时长（微秒）——与 rtcOps.MIN_SEGMENT_US 同值，内联避免依赖（该文件另一任务在改） */
const MIN_DUR_US = 1000;

export interface AppendPlaceholderOpts {
	/** 项目是否多集（决定命名「N集·分镜N」；缺省=单集命名） */
	multiEp?: boolean;
	/** uri → 台账 blob 反查（调用方传 projectStore.getState().blobByUri；纯函数不 import store） */
	resolveBlob?: (uri: string) => AssetBlob | undefined;
}

export interface AppendPlaceholdersResult {
	doc: RtcDoc;
	/** 本次实际追加的片段数 */
	added: number;
	/** 因时间轴已存在同 shotRef 而跳过的分镜数 */
	skipped: number;
}

/** 分镜时长 → 微秒（缺省 3s；钳 MIN_DUR_US 以上防零长/负长片段） */
export function shotDurationUs(shot: Pick<StoryboardShot, "durationSec">): number {
	const sec = shot.durationSec;
	const us = typeof sec === "number" && Number.isFinite(sec) && sec > 0
		? Math.round(sec * 1_000_000)
		: DEFAULT_SHOT_DUR_US;
	return Math.max(MIN_DUR_US, us);
}

/** 片段名（与 rtcAssetData collectVideoItems 同规）：单集=分镜标题、多集=「N集·标题」；标题缺省退 index */
export function shotSegmentName(
	shot: Pick<StoryboardShot, "title" | "index">,
	episodeIndex: number,
	multiEp: boolean,
): string {
	const base = (shot.title || "").trim() || `分镜${shot.index}`;
	return multiEp ? `${episodeIndex}集·${base}` : base;
}

/** shotRef 幂等判定键 */
function refKey(episodeId: string, shotId: string): string {
	return `${episodeId}${shotId}`;
}

/** 收集时间轴上已存在的全部 shotRef 键（任意轨、placeholder 与已替换的 media 一视同仁）。
 *  ⚠ role:"script" 除外——旧形态原文轨（补充10 前落过盘、加载即清）的片段也带 shotRef，
 *  算进来会让视频占位以为分镜已在轨上而整批跳过（对未清洗 doc 的防御，保留）。 */
export function collectShotRefKeys(doc: RtcDoc): Set<string> {
	const keys = new Set<string>();
	for (const t of doc.tracks) {
		if (t.role === "script") continue;
		for (const s of t.segments) {
			if (s.shotRef) keys.add(refKey(s.shotRef.episodeId, s.shotRef.shotId));
		}
	}
	return keys;
}

/** 轨道末尾（微秒）：全部片段的最大右缘；空轨为 0（不假定排序，稳妥取 max） */
function trackEndUs(track: RtcTrack): number {
	let end = 0;
	for (const s of track.segments) end = Math.max(end, s.targetStartUs + s.targetDurationUs);
	return end;
}

/**
 * 把分集的 shots 按顺序追加为 占位符/成片 片段（语义见文件头）。
 * 返回 { doc, added, skipped }；无可添加时 doc 为**原引用**（commit no-op）。
 */
export function appendEpisodePlaceholders(
	doc: RtcDoc,
	episode: VideoEpisode,
	opts?: AppendPlaceholderOpts,
): AppendPlaceholdersResult {
	const shots = episode.shots ?? [];
	if (shots.length === 0) return { doc, added: 0, skipped: 0 };

	const existing = collectShotRefKeys(doc);
	const trackIdx = doc.tracks.findIndex((t) => t.type === "video");
	const baseTrack = trackIdx >= 0 ? doc.tracks[trackIdx] : createRtcTrack("video");

	let cursor = trackEndUs(baseTrack);
	let skipped = 0;
	const fresh: RtcSegment[] = [];
	for (const shot of shots) {
		if (existing.has(refKey(episode.id, shot.id))) {
			skipped++;
			continue;
		}
		const durUs = shotDurationUs(shot);
		const name = shotSegmentName(shot, episode.index, !!opts?.multiEp);
		const shotRef = { episodeId: episode.id, shotId: shot.id };
		if (shot.videoUri) {
			// 已有成片：直落 media 片段（assetId 经 resolve 回调反查台账；source=[0, durationSec µs]）
			const assetId = opts?.resolveBlob?.(shot.videoUri)?.id;
			fresh.push({
				id: genId("seg"),
				kind: "media",
				media: "video",
				name,
				...(assetId ? { assetId } : {}),
				uri: shot.videoUri,
				targetStartUs: cursor,
				targetDurationUs: durUs,
				sourceStartUs: 0,
				sourceDurationUs: durUs,
				shotRef,
			});
		} else {
			fresh.push({
				id: genId("seg"),
				kind: "placeholder",
				name,
				targetStartUs: cursor,
				targetDurationUs: durUs,
				shotRef,
			});
		}
		cursor += durUs;
	}

	if (fresh.length === 0) return { doc, added: 0, skipped }; // 原引用 → commit no-op
	const nextTrack: RtcTrack = { ...baseTrack, segments: [...baseTrack.segments, ...fresh] };
	const next: RtcDoc = {
		...doc,
		tracks: trackIdx >= 0 ? doc.tracks.map((t, i) => (i === trackIdx ? nextTrack : t)) : [...doc.tracks, nextTrack],
	};
	return { doc: next, added: fresh.length, skipped };
}
