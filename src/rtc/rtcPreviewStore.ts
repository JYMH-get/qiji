/**
 * rtcPreviewStore —— 实时剪辑**预览区显示偏好**（zustand + localStorage 手写持久化，惯例同 rtcLayoutStore/dockStore）。
 *
 * ⚠ 语义红线：这里全是「看起来怎样 / 播得怎样」的显示态，**一律不进 rtcDoc**——
 * 不该进撤销栈、不该写项目文件、不该随多窗口同步（画质/缩放/循环换个人换机器都可能不同）。
 * 真正的剪辑数据（片段变换、画幅）分别在 `RtcSegment.transform` 与 `RtcDoc.canvas` 里，走 commit。
 *
 * 持久化键 `Qiji:rtcPreview`（读盘经 `normalizePreviewPrefs` 归一，坏值/未知键逐字段回默认）：
 *   quality / loop / maxDecodeLayers / hideBoxWhilePlaying / uniformScale
 * **zoom 刻意不持久化**（会话态）：预览缩放是「这会儿想看细节」的临时动作，
 * 下次打开项目该回到「适应」而不是莫名其妙被裁掉一半。
 */
import { create } from "zustand";

export const RTC_PREVIEW_KEY = "Qiji:rtcPreview";

/**
 * 预览画质 = **图层合成的渲染像素档**（不是"降码率"）：
 * 画幅框内先按 scale 比例的像素渲染整叠图层，再用 CSS 放大填满框。
 * 真实收益是每帧的合成/缩放像素量（多层视频叠加时最明显）；
 * ⚠ 它**不会**让浏览器降低视频源的解码分辨率——那由素材本身决定，
 * 真正压解码负担的是下面的「同时解码视频层上限」。两个旋钮各管一段，别混为一谈。
 */
export type RtcPreviewQuality = "original" | "high" | "standard";

export const RTC_QUALITY_SPECS: readonly { id: RtcPreviewQuality; label: string; scale: number; hint: string }[] = [
	{ id: "original", label: "原画", scale: 1, hint: "按画幅框原像素合成（默认）" },
	{ id: "high", label: "高清", scale: 0.75, hint: "以 75% 像素合成后放大，省一部分合成开销" },
	{ id: "standard", label: "标清", scale: 0.5, hint: "以 50% 像素合成后放大，多层叠加时最省" },
] as const;

export function qualityScale(q: RtcPreviewQuality): number {
	return RTC_QUALITY_SPECS.find((s) => s.id === q)?.scale ?? 1;
}

/** 预览缩放：`"fit"`=画幅框适应容器（默认）；数字=画幅原始像素的倍率（1 = 1:1 像素） */
export type RtcZoomMode = "fit" | number;

/** 缩放档位（"适应" + 四个倍率档，对标剪映播放器右下角的缩放菜单） */
export const RTC_ZOOM_STEPS: readonly { id: string; label: string; mode: RtcZoomMode }[] = [
	{ id: "fit", label: "适应", mode: "fit" },
	{ id: "0.5", label: "50%", mode: 0.5 },
	{ id: "1", label: "100%", mode: 1 },
	{ id: "1.5", label: "150%", mode: 1.5 },
	{ id: "2", label: "200%", mode: 2 },
] as const;

/** 同时活跃解码的视频层上限档（性能护栏；超出的下层停在静止帧且不发声） */
export const RTC_DECODE_LIMITS: readonly number[] = [2, 4, 6, 8] as const;

export interface RtcPreviewPrefs {
	quality: RtcPreviewQuality;
	/** 播完是否回到 0 继续播（关=停在末帧，改造前的行为） */
	loop: boolean;
	/** 同时活跃解码的视频层上限 */
	maxDecodeLayers: number;
	/** 播放时隐藏画面选中框（看片时不被控制点干扰） */
	hideBoxWhilePlaying: boolean;
	/** 拖角手柄默认等比缩放（关=自由拉伸；按住 Shift 临时取反） */
	uniformScale: boolean;
}

export const DEFAULT_PREVIEW_PREFS: RtcPreviewPrefs = {
	quality: "original",
	loop: false,
	maxDecodeLayers: 4,
	hideBoxWhilePlaying: true,
	uniformScale: true,
};

/** 读盘归一：逐字段校验，任何坏值/缺失回默认；未知键忽略（旧版残留不炸读盘，同 rtcLayoutCore 惯例）。导出供单测。 */
export function normalizePreviewPrefs(raw: unknown): RtcPreviewPrefs {
	const d = DEFAULT_PREVIEW_PREFS;
	if (!raw || typeof raw !== "object") return { ...d };
	const o = raw as Record<string, unknown>;
	const quality = RTC_QUALITY_SPECS.some((s) => s.id === o.quality) ? (o.quality as RtcPreviewQuality) : d.quality;
	const limit = typeof o.maxDecodeLayers === "number" && RTC_DECODE_LIMITS.includes(o.maxDecodeLayers) ? o.maxDecodeLayers : d.maxDecodeLayers;
	const bool = (v: unknown, def: boolean) => (typeof v === "boolean" ? v : def);
	return {
		quality,
		loop: bool(o.loop, d.loop),
		maxDecodeLayers: limit,
		hideBoxWhilePlaying: bool(o.hideBoxWhilePlaying, d.hideBoxWhilePlaying),
		uniformScale: bool(o.uniformScale, d.uniformScale),
	};
}

function loadPrefs(): RtcPreviewPrefs {
	try {
		if (typeof localStorage === "undefined") return { ...DEFAULT_PREVIEW_PREFS };
		const raw = localStorage.getItem(RTC_PREVIEW_KEY);
		return normalizePreviewPrefs(raw ? JSON.parse(raw) : null);
	} catch {
		return { ...DEFAULT_PREVIEW_PREFS };
	}
}

function persist(p: RtcPreviewPrefs): void {
	try {
		localStorage.setItem(RTC_PREVIEW_KEY, JSON.stringify(p));
	} catch {
		/* localStorage 异常（隐私模式/配额）不阻塞预览本身 */
	}
}

interface RtcPreviewState extends RtcPreviewPrefs {
	/** 会话态：预览缩放（不持久化，见文件头） */
	zoom: RtcZoomMode;
	setQuality: (q: RtcPreviewQuality) => void;
	setZoom: (z: RtcZoomMode) => void;
	setLoop: (v: boolean) => void;
	setMaxDecodeLayers: (n: number) => void;
	setHideBoxWhilePlaying: (v: boolean) => void;
	setUniformScale: (v: boolean) => void;
	/** 恢复默认偏好（缩放一并回「适应」） */
	resetPrefs: () => void;
}

function pickPrefs(s: RtcPreviewState): RtcPreviewPrefs {
	return {
		quality: s.quality,
		loop: s.loop,
		maxDecodeLayers: s.maxDecodeLayers,
		hideBoxWhilePlaying: s.hideBoxWhilePlaying,
		uniformScale: s.uniformScale,
	};
}

export const useRtcPreviewStore = create<RtcPreviewState>((set, get) => {
	/** 改一项偏好并落盘（值未变=不写盘） */
	const patch = (part: Partial<RtcPreviewPrefs>) => {
		const cur = pickPrefs(get());
		const next = { ...cur, ...part };
		if ((Object.keys(part) as (keyof RtcPreviewPrefs)[]).every((k) => cur[k] === next[k])) return;
		set(part);
		persist(next);
	};
	return {
		...loadPrefs(),
		zoom: "fit",
		setQuality: (quality) => patch({ quality }),
		setZoom: (zoom) => set({ zoom }),
		setLoop: (loop) => patch({ loop }),
		setMaxDecodeLayers: (maxDecodeLayers) => patch({ maxDecodeLayers }),
		setHideBoxWhilePlaying: (hideBoxWhilePlaying) => patch({ hideBoxWhilePlaying }),
		setUniformScale: (uniformScale) => patch({ uniformScale }),
		resetPrefs: () => {
			set({ ...DEFAULT_PREVIEW_PREFS, zoom: "fit" });
			persist({ ...DEFAULT_PREVIEW_PREFS });
		},
	};
});
