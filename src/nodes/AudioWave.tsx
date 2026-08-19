/**
 * AudioWave —— 画布音频结果的紧凑渲染（第145轮，用户定稿形态）。
 *
 * 旧形态=原生 `<audio controls>`（nodrag 占满整行）：①节点又高又空；②进度条吞掉指针事件——
 * 从素材库拖出放置时点到进度条被误判，节点「粘鼠标」放不下去。
 * 新形态（与视频节点同哲学：节点内不放原生控制条）：**波形图 + 单播放按钮**，无进度条；
 * 波形区 pointer-events:none（节点整体可拖/可点），只有小圆播放钮是 nodrag 热区；
 * **双击放大 → 灯箱**（那里才有完整 `<audio controls>` 进度条）。
 * 波形=真实解码（fetch 字节 → decodeAudioData → 分桶取峰值，模块级缓存按 uri 复用）；
 * 解码失败/进行中显示按 uri 哈希生成的确定性占位波形（稳定不跳变）。
 * 播放进度以波形着色呈现（非交互、不可拖，不算「进度条」）；同时只播一条（新播自动暂停旧的）。
 */
import { useEffect, useRef, useState } from "react";
import { Play, Pause } from "lucide-react";
import { openLightbox } from "@/store/lightboxStore";
import { useCanvasStore } from "@/store/canvasStore";

const BARS = 48;
/** 音频节点紧凑高度（内容 ~72px + 内边距）；仅收紧不放大（>此值的存量高节点自动收） */
export const AUDIO_NODE_H = 92;

// ── 波形峰值：模块级缓存（按 uri），解码一次全画布复用 ──
const peakCache = new Map<string, number[] | null>();
const pending = new Map<string, Promise<number[] | null>>();

async function computePeaks(uri: string, bars = BARS): Promise<number[] | null> {
	try {
		const resp = await fetch(uri); // asset:// / asset.localhost / blob: / http(s) 均可 fetch
		if (!resp.ok) return null;
		const buf = await resp.arrayBuffer();
		const AC: typeof AudioContext | undefined =
			(window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
			(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
		if (!AC) return null;
		const ctx = new AC();
		try {
			const audio = await ctx.decodeAudioData(buf);
			const ch = audio.getChannelData(0);
			if (!ch.length) return null;
			const step = Math.max(1, Math.floor(ch.length / bars));
			const peaks: number[] = [];
			for (let i = 0; i < bars; i++) {
				const start = i * step;
				const end = Math.min(ch.length, start + step);
				// 长音频每桶几十万采样点：抽样步进扫峰值，防解码后再卡主线程
				const stride = Math.max(1, Math.floor((end - start) / 200));
				let max = 0;
				for (let j = start; j < end; j += stride) {
					const v = Math.abs(ch[j]);
					if (v > max) max = v;
				}
				peaks.push(max);
			}
			const top = Math.max(0.01, ...peaks);
			return peaks.map((p) => Math.pow(p / top, 0.7)); // 归一化 + γ 提亮小音量段
		} finally {
			void ctx.close?.().catch(() => {});
		}
	} catch {
		return null;
	}
}

/** 确定性占位波形（按 uri 哈希）：解码失败/进行中显示，同一 uri 恒同形不跳变 */
export function pseudoPeaks(uri: string, bars = BARS): number[] {
	let h = 2166136261 >>> 0;
	const out: number[] = [];
	for (let i = 0; i < bars; i++) {
		h ^= (uri.charCodeAt(i % Math.max(1, uri.length)) || i + 1);
		h = Math.imul(h, 16777619);
		out.push(0.22 + 0.62 * (((h >>> 8) % 1000) / 1000));
	}
	return out;
}

function useAudioPeaks(uri: string): number[] {
	const [peaks, setPeaks] = useState<number[] | null>(() => peakCache.get(uri) ?? null);
	useEffect(() => {
		if (!uri) { setPeaks(null); return; }
		const cached = peakCache.get(uri);
		if (cached !== undefined) { setPeaks(cached); return; }
		let alive = true;
		let p = pending.get(uri);
		if (!p) { p = computePeaks(uri); pending.set(uri, p); }
		void p.then((r) => {
			peakCache.set(uri, r);
			pending.delete(uri);
			if (alive) setPeaks(r);
		});
		return () => { alive = false; };
	}, [uri]);
	return peaks ?? pseudoPeaks(uri);
}

/** 同时只播一条（画布多音频节点互斥，新播自动暂停旧的） */
let currentAudio: HTMLAudioElement | null = null;

export function AudioWaveCard({ uri, name, nodeId }: { uri: string; name?: string; nodeId?: string }) {
	const audioRef = useRef<HTMLAudioElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [playing, setPlaying] = useState(false);
	const [ratio, setRatio] = useState(0); // 播放进度 0..1（只作波形着色，非交互）
	const peaks = useAudioPeaks(uri);

	// 存量高节点收紧到紧凑高度（展示性调整，不走结构命令不进撤销栈——§9 第97轮规则）
	useEffect(() => {
		if (!nodeId) return;
		const n = useCanvasStore.getState().nodes[nodeId];
		if (n && (n.h ?? 200) > AUDIO_NODE_H + 4) {
			useCanvasStore.getState().resizeNode(nodeId, n.w ?? 240, AUDIO_NODE_H);
		}
	}, [nodeId]);

	// 波形绘制：底色柱 + 已播部分紫色着色
	useEffect(() => {
		const cv = canvasRef.current;
		const ctx = cv?.getContext("2d");
		if (!cv || !ctx) return;
		const W = cv.width, H = cv.height;
		ctx.clearRect(0, 0, W, H);
		const gap = 2, bw = W / peaks.length - gap;
		const playedTo = ratio * peaks.length;
		for (let i = 0; i < peaks.length; i++) {
			const h = Math.max(2, peaks[i] * (H - 4));
			ctx.fillStyle = i < playedTo ? "rgba(167,139,250,0.95)" : "rgba(216,225,240,0.28)";
			const x = i * (bw + gap);
			ctx.fillRect(x, (H - h) / 2, bw, h);
		}
	}, [peaks, ratio]);

	const toggle = () => {
		const el = audioRef.current;
		if (!el) return;
		if (el.paused) {
			if (currentAudio && currentAudio !== el) currentAudio.pause();
			currentAudio = el;
			void el.play().catch(() => {});
		} else {
			el.pause();
		}
	};

	return (
		<div
			className="Qiji-result Qiji-result--filled"
			title="点按钮播放 · 双击放大（含进度条）"
			onDoubleClick={(e) => {
				e.stopPropagation();
				openLightbox({ uri, name, media: "audio" });
			}}
		>
			<div className="flex w-full items-center gap-2 px-2.5 py-2">
				{/* 唯一的指针热区：小圆播放钮（nodrag）。其余区域交给节点本体拖动/点击——
				    旧原生 controls 进度条占满整行吞事件=拖出放置「粘鼠标」根因，勿回退 */}
				<button
					type="button"
					className="nodrag flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full border border-purple-400/40 bg-purple-400/15 text-purple-300 transition-colors hover:bg-purple-400/30"
					title={playing ? "暂停" : "播放"}
					onMouseDown={(e) => e.stopPropagation()}
					onDoubleClick={(e) => e.stopPropagation()}
					onClick={(e) => {
						e.stopPropagation();
						toggle();
					}}
				>
					{playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="ml-0.5 h-3.5 w-3.5" />}
				</button>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<canvas ref={canvasRef} width={384} height={72} className="pointer-events-none h-9 w-full" />
					{name && (
						<span className="select-none truncate text-[9px] text-muted-foreground" title={name}>{name}</span>
					)}
				</div>
			</div>
			<audio
				ref={audioRef}
				src={uri}
				preload="metadata"
				className="hidden"
				onPlay={() => setPlaying(true)}
				onPause={() => setPlaying(false)}
				onEnded={() => { setPlaying(false); setRatio(0); }}
				onTimeUpdate={(e) => {
					const el = e.currentTarget;
					setRatio(el.duration ? el.currentTime / el.duration : 0);
				}}
			/>
		</div>
	);
}
