/**
 * materialValidation —— 视频参考素材「本地初步判断」。
 * 规则（单次视频生成）：
 *   · 数量 ≤12，且 图 ≤9 / 视频 ≤3 / 音频 ≤3；
 *   · 图片单边分辨率 300–6000 px，大小 ≤20MB；
 *   · 视频/音频单个 ≥2 秒；视频总时长 ≤15 秒、音频总时长 ≤15 秒（各自独立计，时长取不到则跳过该项，不误判）。
 * 违规素材标红（❗），供用户裁剪。异步元数据（尺寸/大小/时长）按 uri 缓存。
 */
import { mediaOf } from "./shotMaterials";
import type { ShotMaterial } from "@/services/projectFile";

export const MAT_LIMITS = {
	maxTotal: 12, maxImages: 9, maxVideos: 3, maxAudios: 3,
	imgMinSide: 300, imgMaxSide: 6000, imgMaxBytes: 20 * 1024 * 1024,
	mediaMinSec: 2, mediaTotalMaxSec: 15,
};

export interface MatVerdict { ok: boolean; reasons: string[] }

type Meta = { width?: number; height?: number; bytes?: number; duration?: number };
const metaCache = new Map<string, Promise<Meta>>();

function imgDimViaElement(uri: string): Promise<{ width?: number; height?: number }> {
	return new Promise((resolve) => {
		const im = new Image();
		im.onload = () => resolve({ width: im.naturalWidth, height: im.naturalHeight });
		im.onerror = () => resolve({});
		im.src = uri;
	});
}

function mediaDuration(uri: string, media: "video" | "audio"): Promise<Meta> {
	return new Promise((resolve) => {
		const el = document.createElement(media === "video" ? "video" : "audio");
		el.preload = "metadata";
		const done = () => resolve({ duration: isFinite(el.duration) ? el.duration : undefined });
		el.onloadedmetadata = done;
		el.onerror = () => resolve({});
		el.src = uri;
	});
}

async function computeMeta(uri: string, media: "image" | "video" | "audio"): Promise<Meta> {
	try {
		if (media === "image") {
			const meta: Meta = {};
			try {
				const resp = await fetch(uri);
				const blob = await resp.blob();
				meta.bytes = blob.size;
				try {
					const bmp = await createImageBitmap(blob);
					meta.width = bmp.width; meta.height = bmp.height;
					bmp.close?.();
				} catch {
					const d = await imgDimViaElement(uri);
					meta.width = d.width; meta.height = d.height;
				}
			} catch {
				// fetch 失败（跨域/协议）→ 仅取尺寸，放弃大小判断
				const d = await imgDimViaElement(uri);
				meta.width = d.width; meta.height = d.height;
			}
			return meta;
		}
		return await mediaDuration(uri, media);
	} catch {
		return {};
	}
}

function loadMeta(uri: string, media: "image" | "video" | "audio"): Promise<Meta> {
	if (!uri) return Promise.resolve({});
	const key = `${media}|${uri}`;
	let p = metaCache.get(key);
	if (!p) { p = computeMeta(uri, media); metaCache.set(key, p); }
	return p;
}

/** 校验一个分镜的全部素材，返回 matId → 判定（ok=false 表示违规、reasons 列出原因）。 */
export async function validateShotMaterials(materials: ShotMaterial[]): Promise<Record<string, MatVerdict>> {
	const L = MAT_LIMITS;
	const res: Record<string, MatVerdict> = {};
	const metas = await Promise.all(materials.map((m) => loadMeta(m.uri, mediaOf(m))));
	let img = 0, vid = 0, aud = 0, videoDur = 0, audioDur = 0;
	materials.forEach((m, i) => {
		const media = mediaOf(m);
		const meta = metas[i];
		const reasons: string[] = [];
		// 数量上限（分组序 + 总序）
		if (media === "image") { if (img++ >= L.maxImages) reasons.push(`图片数量超上限（最多 ${L.maxImages} 张）`); }
		else if (media === "video") { if (vid++ >= L.maxVideos) reasons.push(`视频数量超上限（最多 ${L.maxVideos} 个）`); }
		else if (aud++ >= L.maxAudios) reasons.push(`音频数量超上限（最多 ${L.maxAudios} 个）`);
		if (i >= L.maxTotal) reasons.push(`素材总数超上限（最多 ${L.maxTotal} 个）`);
		// 图片：分辨率 + 大小
		if (media === "image") {
			if (meta.width && meta.height) {
				const mn = Math.min(meta.width, meta.height), mx = Math.max(meta.width, meta.height);
				if (mn < L.imgMinSide || mx > L.imgMaxSide) reasons.push(`分辨率 ${meta.width}×${meta.height}，单边需 ${L.imgMinSide}–${L.imgMaxSide}`);
			}
			if (meta.bytes && meta.bytes > L.imgMaxBytes) reasons.push(`大小 ${(meta.bytes / 1048576).toFixed(1)}MB，超过 20MB`);
		} else {
			// 视频/音频：单个 ≥2 秒（时长取不到则跳过），并按各自类型累计总时长
			if (meta.duration != null && isFinite(meta.duration) && meta.duration > 0) {
				if (meta.duration < L.mediaMinSec) reasons.push(`时长 ${meta.duration.toFixed(1)}s，不足 ${L.mediaMinSec} 秒`);
				if (media === "video") videoDur += meta.duration; else audioDur += meta.duration;
			}
		}
		res[m.id] = { ok: reasons.length === 0, reasons };
	});
	// 视频总时长 ≤15 秒、音频总时长 ≤15 秒（各自独立；超则标记该类型全部媒体，提示裁剪）
	const flagTotal = (kind: "video" | "audio", total: number) => {
		if (total <= L.mediaTotalMaxSec) return;
		materials.forEach((m) => {
			if (mediaOf(m) !== kind) return;
			res[m.id].reasons.push(`${kind === "video" ? "视频" : "音频"}总时长 ${total.toFixed(1)}s，超过 ${L.mediaTotalMaxSec} 秒`);
			res[m.id].ok = false;
		});
	};
	flagTotal("video", videoDur);
	flagTotal("audio", audioDur);
	return res;
}
