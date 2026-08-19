/**
 * rtcFreezeActions —— 定格（freeze frame）：对选中视频片段在播放头处
 *   ① 抽当前帧为 PNG（Tauri 走 ffmpeg 的 captureFromUri；浏览器回退 <video>+canvas 抓帧）
 *   ② 图片字节经既有懒上传路径落本地资产（uploadMediaToCanvasAsset，LC- id 零网络）
 *   ③ rtcOps.insertFreezeFrame：原片段分割、两半之间插入 3 秒图片片段、同轨右侧整体右移
 * 一次 commit = 一条 undo；异步过程有进行中提示，失败 alert 明确报错（绝不静默）。
 *
 * ⚠ 异步竞态防护：抽帧/落盘期间 doc 可能被编辑——落笔前按**源素材时刻**（抽帧那一刻的
 *   sourceUs）重新换算切点：片段被移动了照样切在「抽到的那一帧」上；片段被删/被裁到
 *   切点已不在片段内 → 明确提示并取消（绝不切错位置）。项目切换由 rtcStore.commit 的
 *   身份守卫兜底（stale 写入自动丢弃）。
 *
 * 接线说明（本批不接快捷键/右键菜单，见最终报告的待接线清单）：
 *   - freezeAtPlayhead —— 建议键位 G；建议右键菜单「定格」（视频片段限定）
 */
import { genId } from "@/lib/id";
import { captureFromUri } from "@/canvas/videoCapture";
import { uploadMediaToCanvasAsset } from "@/canvas/nodeUpload";
import { FREEZE_DEFAULT_US, MIN_SEGMENT_US, insertFreezeFrame } from "@/lib/rtcOps";
import { sourceTimeSec } from "@/rtc/rtcPlayback";
import { useRtcStore } from "@/store/rtcStore";
import type { RtcSegment } from "@/types/rtc";

const US_PER_SEC = 1_000_000;

/** 进行中提示（轻量 toast：底部居中悬浮条，返回销毁函数）——动作模块自包含，不依赖面板接线 */
function showBusyToast(msg: string): () => void {
	if (typeof document === "undefined") return () => {};
	const el = document.createElement("div");
	el.textContent = msg;
	el.style.cssText =
		"position:fixed;left:50%;bottom:88px;transform:translateX(-50%);z-index:9999;" +
		"padding:6px 14px;border-radius:8px;background:rgba(20,20,26,0.92);" +
		"border:1px solid rgba(255,255,255,0.14);color:rgba(255,255,255,0.85);" +
		"font-size:12px;pointer-events:none;white-space:nowrap;";
	document.body.appendChild(el);
	return () => el.remove();
}

/** 浏览器兜底抓帧：<video> seek 到指定源时刻 → canvas.drawImage → PNG（跨域污染/超时返回 null） */
async function grabFrameFromUri(uri: string, timeSec: number): Promise<Blob | null> {
	if (typeof document === "undefined") return null;
	const v = document.createElement("video");
	v.preload = "auto";
	v.muted = true;
	const cleanup = () => {
		v.removeAttribute("src");
		try { v.load(); } catch { /* 释放解码器，失败无碍 */ }
	};
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("载入视频超时")), 10_000);
			v.onloadedmetadata = () => { clearTimeout(timer); resolve(); };
			v.onerror = () => { clearTimeout(timer); reject(new Error("视频载入失败")); };
			v.src = uri;
		});
		await new Promise<void>((resolve) => {
			let done = false;
			const finish = () => { if (!done) { done = true; resolve(); } };
			v.onseeked = finish;
			setTimeout(finish, 3000); // seeked 不来也继续（画面可能略偏，好过卡死）
			const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
			try { v.currentTime = Math.max(0, dur ? Math.min(timeSec, dur - 0.01) : timeSec); } catch { finish(); }
		});
		const canvas = document.createElement("canvas");
		canvas.width = v.videoWidth || 1280;
		canvas.height = v.videoHeight || 720;
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		try {
			ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
		} catch {
			return null; // 跨域污染
		}
		return await new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), "image/png"));
	} catch {
		return null;
	} finally {
		cleanup();
	}
}

/** 定位片段（返回片段与所在轨道锁定态）；未找到 null */
function findSegById(segId: string): { seg: RtcSegment; locked: boolean } | null {
	const d = useRtcStore.getState().doc;
	if (!d) return null;
	for (const t of d.tracks) {
		const seg = t.segments.find((s) => s.id === segId);
		if (seg) return { seg, locked: !!t.locked };
	}
	return null;
}

/**
 * 对指定视频片段在播放头处定格（segId 缺省取当前唯一选中片段）。
 * 前置校验（不满足即 alert，不发起任何异步）：
 *   - 片段存在、media 视频、有显示地址、所在轨道未锁定；
 *   - 播放头在片段内部（距两缘各 ≥ MIN_SEGMENT_US——两半都要能成段）。
 * 成功后选中新插入的定格图片片段；返回是否成功。
 */
export async function freezeAtPlayhead(segId?: string): Promise<boolean> {
	const st = useRtcStore.getState();
	if (!st.doc) return false;
	const id = segId ?? (st.selection.length === 1 ? st.selection[0] : null);
	if (!id) {
		alert("请先选中一个视频片段再定格。");
		return false;
	}
	const found = findSegById(id);
	if (!found) {
		alert("该片段已不存在，定格已取消。");
		return false;
	}
	const { seg, locked } = found;
	if (locked) {
		alert("该片段所在轨道已锁定，无法定格。");
		return false;
	}
	if (seg.kind !== "media" || seg.media !== "video" || !seg.uri) {
		alert("定格只适用于有画面的视频片段（图片本身就是静止画面，音频没有画面可定格）。");
		return false;
	}
	const atUs = st.playheadUs;
	const start = seg.targetStartUs;
	const end = seg.targetStartUs + seg.targetDurationUs;
	if (atUs - start < MIN_SEGMENT_US || end - atUs < MIN_SEGMENT_US) {
		alert("请把播放头移到该片段内部（离两端稍远一点）再定格——两侧都要能留下有效片段。");
		return false;
	}

	// 抽帧那一刻的源素材时刻（含 sourceStartUs / speed 换算）——落笔前按它重算切点，防异步期间片段被挪动
	const srcSec = sourceTimeSec(seg, atUs);
	const srcUs = Math.round(srcSec * US_PER_SEC);
	const closeBusy = showBusyToast("正在定格当前帧…");
	try {
		// ① 抽帧：Tauri 走 ffmpeg（本地原件/直链最快）；非 Tauri / 取不到源 → 浏览器 canvas 兜底
		let blob: Blob | null = null;
		try {
			const cap = await captureFromUri(seg.uri, "frame", { timeSec: srcSec });
			if (cap) blob = cap.blob;
		} catch { /* ffmpeg 路径失败 → 落浏览器兜底 */ }
		if (!blob) blob = await grabFrameFromUri(seg.uri, srcSec);
		if (!blob || blob.size === 0) {
			alert("定格失败：无法从该视频截取当前帧（源文件不可读或跨域受限），请稍后重试。");
			return false;
		}

		// ② 图片字节落本地资产（LC- 懒上传：零网络；被生成请求引用时再补传 OSS）
		const baseName = (seg.name || "片段").replace(/\.[a-z0-9]+$/i, "");
		const stillName = `定格-${baseName}`;
		const file = new File([blob], `${stillName}.png`, { type: "image/png" });
		const up = await uploadMediaToCanvasAsset(file);

		// ③ 落笔：按源素材时刻重算此刻的切点（片段可能已被移动/裁剪/删除）
		const now = findSegById(id);
		if (!now || now.seg.kind !== "media") {
			alert("定格期间该片段已被删除，操作已取消。");
			return false;
		}
		const cur = now.seg;
		const speed = cur.speed && cur.speed > 0 ? cur.speed : 1;
		const cutUs = Math.round(cur.targetStartUs + (srcUs - (cur.sourceStartUs ?? 0)) / speed);
		const curEnd = cur.targetStartUs + cur.targetDurationUs;
		if (cutUs - cur.targetStartUs < MIN_SEGMENT_US || curEnd - cutUs < MIN_SEGMENT_US) {
			alert("定格期间该片段被裁剪/修改，抽到的帧已不在片段内，操作已取消。");
			return false;
		}
		const stillId = genId("seg");
		useRtcStore.getState().commit((d) =>
			insertFreezeFrame(d, id, cutUs, {
				id: stillId,
				assetId: up.assetId,
				uri: up.displayUri,
				name: stillName,
				durUs: FREEZE_DEFAULT_US,
			}),
		);
		useRtcStore.getState().setSelection([stillId]);
		return true;
	} catch (err) {
		alert(`定格失败：${err instanceof Error ? err.message : "未知错误"}`);
		return false;
	} finally {
		closeBusy();
	}
}
