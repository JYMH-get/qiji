/**
 * reverseActions —— 实时剪辑「片段倒放」动作层（桌面版限定）。
 *
 * 语义（定稿）：
 *   - 倒放 = 用内置 ffmpeg 把素材**物理倒放**成一份新的本地资产（`-vf reverse -af areverse` 重编码；
 *     音频片段仅 `-af areverse`），片段换引用这份副本 + 记 `reversedFromAssetId` 标记 +
 *     **source 窗口镜像换算**（纯函数 rtcOps.applyReverse，单测锁定）；
 *   - 已是倒放片段再点 = **还原**：换回 reversedFromAssetId 指向的原素材、窗口再镜像回去、清标记；
 *   - 同一原素材的倒放副本**会话级缓存**（Map），多段引用同一素材只转码一次；
 *     副本经 uploadMediaToCanvasAsset 落 LC- 本地资产（懒上传惯例，sha256 去重、注册三元映射）——
 *     导出剪映的素材复制链路（assetBlobs.localPath）天然覆盖，零改动；
 *   - ⚠ ffmpeg 的 reverse 滤镜会把整段素材缓冲进内存——**长视频转码慢**，UI 侧有 busy 态与提示；
 *   - 非 Tauri（浏览器 dev）明确报错「倒放需要桌面版」；一切失败面向用户可直显，绝不静默。
 *
 * 红线：不碰 rtcKeymap/rtcEditActions/RtcToolbar/RtcSegContextMenu（并行任务独占）——
 * 快捷键（建议 D）与右键菜单入口由协调方接线，本文件只导出干净入口 toggleReverse()。
 */
import { create } from "zustand";
import { useRtcStore } from "@/store/rtcStore";
import { useProjectStore } from "@/store/projectStore";
import { applyReverse } from "@/lib/rtcOps";
import { uploadMediaToCanvasAsset } from "@/canvas/nodeUpload";
import { probeMediaDurationSec } from "@/rtc/timeline/timelineUtil";
import type { RtcSegment } from "@/types/rtc";

const isTauri = () => typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

/** ffmpeg 进程可直接读取的源（真实 http(s) 直链；排除 webview 内部协议）——与 videoCapture 同判据 */
const isFfmpegReadable = (u?: string | null): boolean =>
	!!u && /^https?:\/\//i.test(u) && !/asset\.localhost|ipc\.localhost/i.test(u);

/** 倒放副本会话级缓存：原素材键（assetId）→ 副本 { assetId, uri } */
const reversedCache = new Map<string, { assetId: string; uri: string }>();
/** 反向映射：副本 assetId → 原素材 { assetId, uri }（还原时的第一顺位来源） */
const originCache = new Map<string, { assetId: string; uri: string }>();

/** 倒放转码中的片段 id（UI 显示 busy 态用；只增删本表，不进任何持久化） */
export const useReverseBusy = create<{ busy: Record<string, true | undefined> }>(() => ({ busy: {} }));

function setBusy(segId: string, on: boolean) {
	useReverseBusy.setState((s) => {
		const busy = { ...s.busy };
		if (on) busy[segId] = true;
		else delete busy[segId];
		return { busy };
	});
}

export interface ToggleReverseResult {
	ok: boolean;
	/** 面向用户可直显的失败原因 */
	error?: string;
}

function findSegInDoc(segId: string): RtcSegment | null {
	const doc = useRtcStore.getState().doc;
	if (!doc) return null;
	for (const t of doc.tracks) {
		const s = t.segments.find((x) => x.id === segId);
		if (s) return s;
	}
	return null;
}

/** 生成素材的倒放副本：解析 ffmpeg 可读源 → reverse_media 转码 → 落 LC- 本地资产 */
async function makeReversedCopy(seg: RtcSegment): Promise<{ assetId: string; uri: string }> {
	const kind = seg.media === "audio" ? "audio" : "video";
	const uri = seg.uri as string;
	const blob = useProjectStore.getState().blobByUri(uri);
	const { invoke } = await import("@tauri-apps/api/core");
	const fs = await import("@tauri-apps/plugin-fs");
	const path = await import("@tauri-apps/api/path");

	// 输入：本地原件 / 真实直链直接喂 ffmpeg；仅 webview 内部协议时先 fetch 字节落临时文件（videoCapture 同法）
	let input = blob?.localPath || [blob?.url, uri, blob?.localUri].find(isFfmpegReadable) || "";
	let tempInput = "";
	if (!input) {
		const resp = await fetch(uri);
		if (!resp.ok) throw new Error(`读取素材源失败（HTTP ${resp.status}）`);
		const bytes = new Uint8Array(await resp.arrayBuffer());
		const dir = await path.tempDir();
		tempInput = await path.join(dir, `qiji-revin-${Date.now()}.${kind === "audio" ? "m4a" : "mp4"}`);
		await fs.writeFile(tempInput, bytes);
		input = tempInput;
	}
	let outPath = "";
	try {
		outPath = await invoke<string>("reverse_media", { src: input, kind });
		const bytes = await fs.readFile(outPath);
		if (!bytes || bytes.length === 0) throw new Error("倒放转码未产出内容");
		const ext = kind === "audio" ? "m4a" : "mp4";
		const mime = kind === "audio" ? "audio/mp4" : "video/mp4";
		const baseName = (seg.name || "素材").replace(/\.[a-z0-9]+$/i, "");
		const file = new File([new Blob([bytes as unknown as BlobPart], { type: mime })], `${baseName}-倒放.${ext}`, { type: mime });
		// LC- 本地资产（懒上传惯例）：sha256 去重 + 注册三元映射；导出剪映的素材复制链路天然覆盖
		const up = await uploadMediaToCanvasAsset(file);
		return { assetId: up.assetId, uri: up.displayUri };
	} finally {
		for (const p of [outPath, tempInput]) {
			if (p) { try { await fs.remove(p); } catch { /* 临时文件清理失败可忽略 */ } }
		}
	}
}

/**
 * 倒放开关：非倒放片段 → 生成/复用倒放副本并换入；倒放片段 → 换回原素材。
 * 一次调用 = 一条 undo（rtcStore.commit + applyReverse 纯函数）。
 * 失败返回 { ok:false, error }（调用方直显给用户；本函数不 alert，UI 层自决呈现方式）。
 */
export async function toggleReverse(segId: string): Promise<ToggleReverseResult> {
	if (!isTauri()) return { ok: false, error: "倒放需要桌面版（依赖内置 ffmpeg 转码），浏览器版暂不可用" };
	const seg = findSegInDoc(segId);
	if (!seg || seg.kind !== "media") return { ok: false, error: "片段不存在或不是素材片段" };
	if (seg.media !== "video" && seg.media !== "audio") return { ok: false, error: "只有视频/音频片段可以倒放（图片无时间方向）" };
	if (useReverseBusy.getState().busy[segId]) return { ok: false, error: "该片段正在倒放转码中，请稍候" };

	// ── 还原：换回原素材 + 窗口镜像回去 + 清标记 ──
	if (seg.reversedFromAssetId) {
		const origId = seg.reversedFromAssetId;
		const cached = originCache.get(seg.assetId || "");
		const blob = useProjectStore.getState().assetBlobs[origId];
		const uri = cached?.uri || blob?.localUri || blob?.url;
		if (!uri) return { ok: false, error: "找不到原素材（本地映射缺失），无法取消倒放" };
		const totalSec = await probeMediaDurationSec(uri, seg.media === "audio" ? "audio" : "video");
		useRtcStore.getState().commit((d) =>
			applyReverse(d, segId, {
				assetId: origId,
				uri,
				totalUs: totalSec > 0 ? Math.round(totalSec * 1_000_000) : 0,
				reversedFromAssetId: undefined,
			}),
		);
		return { ok: true };
	}

	// ── 倒放：生成/复用副本并换入 ──
	if (!seg.uri) return { ok: false, error: "片段没有可用的素材地址，无法倒放" };
	if (!seg.assetId) return { ok: false, error: "素材尚未登记资产 id，无法倒放（请先让素材落库后重试）" };
	const key = seg.assetId;
	let copy = reversedCache.get(key);
	if (!copy) {
		setBusy(segId, true);
		try {
			copy = await makeReversedCopy(seg);
		} catch (e) {
			return { ok: false, error: `倒放转码失败：${e instanceof Error ? e.message : String(e)}（长视频转码较慢且占内存，也请确认已内置 ffmpeg）` };
		} finally {
			setBusy(segId, false);
		}
		reversedCache.set(key, copy);
	}
	const rev = copy; // const 化：闭包内 TS 窄化稳定（let 捕获进回调会退回 possibly undefined）
	originCache.set(rev.assetId, { assetId: seg.assetId, uri: seg.uri });
	// 副本总时长（=原素材总时长）：镜像换算的基准；探测不到给 0（applyReverse 起点归 0）
	const totalSec = await probeMediaDurationSec(rev.uri, seg.media === "audio" ? "audio" : "video");
	// ⚠ 异步等待期间片段可能已被删/已被别的操作换素材——现读复核后再落笔
	const cur = findSegInDoc(segId);
	if (!cur || cur.kind !== "media" || cur.assetId !== key) {
		return { ok: false, error: "片段状态已变化（被删除或素材已更换），本次倒放未应用" };
	}
	useRtcStore.getState().commit((d) =>
		applyReverse(d, segId, {
			assetId: rev.assetId,
			uri: rev.uri,
			totalUs: totalSec > 0 ? Math.round(totalSec * 1_000_000) : 0,
			reversedFromAssetId: key,
		}),
	);
	return { ok: true };
}
