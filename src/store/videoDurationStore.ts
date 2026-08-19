/**
 * 视频素材时长缓存（第143轮，参考视频按秒计费的**客户端预估**侧）。
 *
 * 服务端实扣按 mvhd 探测（server refVideoBilling.ts）；客户端预估要同一把尺，就地用
 * `<video preload="metadata">` 读素材显示 uri（本地 asset:// / blob: 优先，与全站媒体显示同源）的时长。
 * 结果进 zustand 缓存（uri → 秒），积分角标订阅它——时长陆续读出时角标自动刷新。
 * 失败（远程被 CSP 拦/非视频/超时）只记失败集防循环，预估按已知部分显示（实扣以服务端为准，402 兜底）。
 */
import { create } from "zustand";
import { useEffect } from "react";

interface VideoDurationState {
	/** uri → 原始秒（未取整；计费口径用 ceil，见 sumRefVideoSeconds） */
	seconds: Record<string, number>;
}

export const useVideoDurationStore = create<VideoDurationState>(() => ({ seconds: {} }));

const pending = new Set<string>();
const failed = new Set<string>();

function loadDurationSec(uri: string): Promise<number | null> {
	return new Promise((resolve) => {
		if (typeof document === "undefined") return resolve(null);
		const v = document.createElement("video");
		v.preload = "metadata";
		v.muted = true;
		let settled = false;
		const done = (val: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			v.onloadedmetadata = null;
			v.onerror = null;
			v.removeAttribute("src");
			try { v.load(); } catch { /* 释放解码器，失败无碍 */ }
			resolve(val);
		};
		const timer = setTimeout(() => done(null), 15000);
		v.onloadedmetadata = () => {
			const d = v.duration;
			done(Number.isFinite(d) && d > 0 ? d : null);
		};
		v.onerror = () => done(null);
		v.src = uri;
	});
}

/** 惰性读取某 uri 的时长进缓存（重复调用零开销；失败缓存防循环重试） */
export function ensureVideoDuration(uri: string): void {
	if (!uri || pending.has(uri) || failed.has(uri) || useVideoDurationStore.getState().seconds[uri] != null) return;
	pending.add(uri);
	void loadDurationSec(uri).then((sec) => {
		pending.delete(uri);
		if (sec && sec > 0) {
			useVideoDurationStore.setState((s) => ({ seconds: { ...s.seconds, [uri]: sec } }));
		} else {
			failed.add(uri);
		}
	});
}

/** 参考视频计费秒数合计 = Σ ceil(每条秒)（不足1秒算1秒·逐条向上取整，与服务端同尺）；未知时长的条目暂不计 */
export function sumRefVideoSeconds(uris: string[], seconds: Record<string, number>): number {
	let sum = 0;
	for (const u of uris) {
		const s = seconds[u];
		if (s && s > 0) sum += Math.ceil(s);
	}
	return sum;
}

/** hook：视频素材 uri 列表 → 参考视频计费秒数合计（触发惰性加载；时长读出后自动重渲染） */
export function useRefVideoSeconds(uris: string[]): number {
	const key = uris.join("\n");
	useEffect(() => {
		for (const u of uris) ensureVideoDuration(u);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key]);
	return useVideoDurationStore((s) => sumRefVideoSeconds(uris, s.seconds));
}

/** 测试钩子：直接注入时长（vitest node 环境无 <video>） */
export function __setVideoDurationForTest(uri: string, sec: number): void {
	useVideoDurationStore.setState((s) => ({ seconds: { ...s.seconds, [uri]: sec } }));
}
