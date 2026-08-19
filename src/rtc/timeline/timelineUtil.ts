/**
 * 时间轴共享常量与小工具：布局尺寸 / 轨道配色 / 素材拖放 payload 解析 / 媒体时长探测。
 * ⚠ 红线：写进 RtcSegment.uri 的只允许轻量显示地址（asset:// / http(s) 直链），绝不收 data:/blob:。
 */
import type { RtcTrackType } from "@/types/rtc";
import { useVideoDurationStore } from "@/store/videoDurationStore";
import { imageDefaultUsFromSettings } from "../settings/rtcEditorSettingsStore";

/** 轨道头列宽 / 标尺高 / 轨道行高（px；行高 64 = 片段内放得下缩略图平铺与波形） */
export const HEADER_W = 128;
export const RULER_H = 28;
export const ROW_H = 64;
/** 文本类轨道行高（用户定稿：缩到一半——文本片段只需一行内容文字） */
export const ROW_H_TEXT = 32;
/** 某轨道的行高（时间轴几何全链的唯一口径：渲染/指针换算/缝隙/幽灵落点都用它） */
export function rowHeightOf(t: { type: RtcTrackType }): number {
	return t.type === "text" ? ROW_H_TEXT : ROW_H;
}

/**
 * 框选命中（鼠标点按拖动多选，纯函数可单测）：
 * rows=显示序轨道、rowTops=各行顶部（含 RULER_H 偏移，长度 rows.length+1，末位=底部）；
 * [y1,y2]×[t1,t2] 的矩形与 行×片段时间窗 相交即命中；锁定轨不参与。y/t 传入顺序无关（内部翻正）。
 */
export function marqueeSelectIds(
	rows: Array<{ locked?: boolean; segments: Array<{ id: string; targetStartUs: number; targetDurationUs: number }> }>,
	rowTops: number[],
	y1: number,
	y2: number,
	t1: number,
	t2: number,
): string[] {
	const yA = Math.min(y1, y2);
	const yB = Math.max(y1, y2);
	const tA = Math.min(t1, t2);
	const tB = Math.max(t1, t2);
	const out: string[] = [];
	for (let i = 0; i < rows.length; i++) {
		if (rows[i].locked) continue;
		const top = rowTops[i];
		const bottom = rowTops[i + 1] ?? top;
		if (bottom <= yA || top >= yB) continue; // 行与矩形纵向不相交
		for (const s of rows[i].segments) {
			const sEnd = s.targetStartUs + s.targetDurationUs;
			if (sEnd > tA && s.targetStartUs < tB) out.push(s.id);
		}
	}
	return out;
}
/** 吸附阈值（屏幕像素，换算微秒 = SNAP_PX / pxPerSec × 1e6） */
export const SNAP_PX = 8;
/** 两轨缝隙的命中带半宽（屏幕像素）：指针距轨道行边界 ≤ 此值即算「悬浮在缝隙上」 */
export const GAP_HIT_PX = 7;
/** 缝隙悬停多久才判定为「要在此新建轨道」（毫秒）——防跨轨拖动路过时误建轨 */
export const GAP_DWELL_MS = 300;
/** 素材拖拽 MIME（AssetAssistant / 素材面板 setData 的 JSON payload） */
export const ASSET_MIME = "application/x-qiji-asset";
/** 图片素材默认上轨时长的**回退值**（微秒）——运行时取值一律走 imageDefaultUs()（设置可调） */
export const IMAGE_DEFAULT_US = 3_000_000;
/** 图片素材默认上轨时长（微秒）：读设置「图片默认时长」（rtcEditorSettingsStore，默认 3s 行为不变） */
export function imageDefaultUs(): number {
	return imageDefaultUsFromSettings();
}
/** 视频/音频时长探测失败时的回退时长（微秒，不建 source 窗口） */
export const MEDIA_FALLBACK_US = 5_000_000;

export const TRACK_COLORS: Record<RtcTrackType, string> = {
	video: "var(--node-video)",
	audio: "var(--node-audio)",
	text: "var(--node-text)",
};
export const TRACK_LABELS: Record<RtcTrackType, string> = { video: "视频", audio: "音频", text: "文本" };
/* 轨道分层的口径（TRACK_TYPE_ORDER / 主轨解析 / 显示序 orderTracksForDisplay / 缝隙合法性）
 * 全部收在 @/lib/rtcOps（纯函数、带单测），此处不再另立一份，防两处规则漂移。 */

export interface DroppedAsset {
	media: "image" | "video" | "audio";
	name?: string;
	assetId?: string;
	/** 落进 doc 的显示 uri（已剔除 data:/blob:） */
	displayUri?: string;
	/** 时长探测用 uri（本地优先，可为任意形态） */
	probeUri?: string;
}

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|m4v|avi)(\?|#|$)/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac)(\?|#|$)/i;

/** 解析素材拖拽 payload；识别不了/不是对象返回 null */
export function parseAssetPayload(raw: string): DroppedAsset | null {
	try {
		const d = JSON.parse(raw);
		if (!d || typeof d !== "object") return null;
		const uriGuess = String(d.localUri || d.uri || d.url || "");
		let media = d.media ?? d.kind;
		if (media !== "image" && media !== "video" && media !== "audio") {
			media = VIDEO_EXT.test(uriGuess) ? "video" : AUDIO_EXT.test(uriGuess) ? "audio" : "image";
		}
		const light = (u: unknown) =>
			typeof u === "string" && u && !/^(data|blob):/i.test(u) ? u : undefined;
		const any = (u: unknown) => (typeof u === "string" && u ? u : undefined);
		return {
			media,
			name: typeof d.name === "string" && d.name ? d.name : undefined,
			assetId: typeof d.assetId === "string" && d.assetId ? d.assetId : undefined,
			displayUri: light(d.localUri) ?? light(d.uri) ?? light(d.url),
			probeUri: any(d.localUri) ?? any(d.uri) ?? any(d.url),
		};
	} catch {
		return null;
	}
}

/** 探测视频/音频真实时长（秒）：metadata-only 加载，成功顺手回填 videoDurationStore；失败回 0 */
export function probeMediaDurationSec(uri: string, media: "video" | "audio"): Promise<number> {
	const cached = useVideoDurationStore.getState().seconds[uri];
	if (cached && cached > 0) return Promise.resolve(cached);
	return new Promise((resolve) => {
		if (typeof document === "undefined") return resolve(0);
		const el = document.createElement(media === "audio" ? "audio" : "video");
		el.preload = "metadata";
		el.muted = true;
		let settled = false;
		const done = (sec: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			el.onloadedmetadata = null;
			el.onerror = null;
			el.removeAttribute("src");
			try { el.load(); } catch { /* 释放解码器，失败无碍 */ }
			if (sec > 0) {
				useVideoDurationStore.setState((s) => ({ seconds: { ...s.seconds, [uri]: sec } }));
			}
			resolve(sec);
		};
		const timer = setTimeout(() => done(0), 15000);
		el.onloadedmetadata = () => {
			const d = el.duration;
			done(Number.isFinite(d) && d > 0 ? d : 0);
		};
		el.onerror = () => done(0);
		el.src = uri;
	});
}
