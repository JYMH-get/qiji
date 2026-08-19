/**
 * rtcEditorSettingsStore —— 实时剪辑**剪辑行为偏好**（zustand + localStorage 手写持久化，
 * 惯例同 rtcPreviewStore/rtcLayoutStore）。
 *
 * ⚠ 语义红线：全是「操作手感」的本机偏好，**一律不进 rtcDoc**——不该进撤销栈、不写项目文件、
 * 不随多窗口同步。持久化键 `Qiji:rtcEditorSettings`（读盘经 normalizeEditorSettings 归一，
 * 坏值/缺失逐字段回默认，未知键忽略）。
 *
 * 三个数值（对标剪映「全局设置」）：
 *   - bigStepFrames：时间线大幅移动步长（帧）——「+ / −」快捷键每按一次播放头移动的帧数；
 *   - bigValueStep：数值大幅调节步长——属性数值类输入做大幅增减时的步进（预留给数值控件消费）；
 *   - imageDefaultSec：图片默认时长（秒）——图片素材拖入轨道 / 「添加图片占位」的默认时长。
 */
import { create } from "zustand";

export const RTC_EDITOR_SETTINGS_KEY = "Qiji:rtcEditorSettings";

export interface RtcEditorSettings {
	/** 时间线大幅移动步长（帧，1–600 整数） */
	bigStepFrames: number;
	/** 数值大幅调节步长（1–100 整数） */
	bigValueStep: number;
	/** 图片默认时长（秒，0.2–120，保留 1 位小数） */
	imageDefaultSec: number;
}

export const DEFAULT_EDITOR_SETTINGS: RtcEditorSettings = {
	bigStepFrames: 10,
	bigValueStep: 10,
	imageDefaultSec: 3,
};

/** 只认数字与非空数字串（⚠ Number(null)=0 是陷阱——null/空串/布尔一律按缺失回默认） */
function toNum(v: unknown): number {
	if (typeof v === "number") return v;
	if (typeof v === "string" && v.trim() !== "") return Number(v);
	return Number.NaN;
}

/** 数值收敛：非数/越界回默认；整数字段取整 */
function clampInt(v: unknown, def: number, lo: number, hi: number): number {
	const n = toNum(v);
	if (!Number.isFinite(n)) return def;
	return Math.min(hi, Math.max(lo, Math.round(n)));
}

function clampSec(v: unknown, def: number): number {
	const n = toNum(v);
	if (!Number.isFinite(n)) return def;
	// 0.2s 下限：低于 MIN_SEGMENT_US 量级的图片时长没有剪辑意义；保留 1 位小数
	return Math.min(120, Math.max(0.2, Math.round(n * 10) / 10));
}

/** 读盘归一：逐字段校验，坏值回默认；未知键忽略（旧版残留不炸读盘）。导出供单测。 */
export function normalizeEditorSettings(raw: unknown): RtcEditorSettings {
	const d = DEFAULT_EDITOR_SETTINGS;
	if (!raw || typeof raw !== "object") return { ...d };
	const o = raw as Record<string, unknown>;
	return {
		bigStepFrames: clampInt(o.bigStepFrames, d.bigStepFrames, 1, 600),
		bigValueStep: clampInt(o.bigValueStep, d.bigValueStep, 1, 100),
		imageDefaultSec: clampSec(o.imageDefaultSec, d.imageDefaultSec),
	};
}

function loadSettings(): RtcEditorSettings {
	try {
		if (typeof localStorage === "undefined") return { ...DEFAULT_EDITOR_SETTINGS };
		const raw = localStorage.getItem(RTC_EDITOR_SETTINGS_KEY);
		return normalizeEditorSettings(raw ? JSON.parse(raw) : null);
	} catch {
		return { ...DEFAULT_EDITOR_SETTINGS };
	}
}

function persist(s: RtcEditorSettings): void {
	try {
		localStorage.setItem(RTC_EDITOR_SETTINGS_KEY, JSON.stringify(s));
	} catch {
		/* localStorage 异常（隐私模式/配额）不阻塞编辑本身 */
	}
}

interface RtcEditorSettingsState extends RtcEditorSettings {
	/** 改一项并落盘（传入值先归一；值未变=不写盘） */
	patch: (part: Partial<RtcEditorSettings>) => void;
	/** 恢复默认值 */
	reset: () => void;
}

function pick(s: RtcEditorSettingsState): RtcEditorSettings {
	return { bigStepFrames: s.bigStepFrames, bigValueStep: s.bigValueStep, imageDefaultSec: s.imageDefaultSec };
}

export const useRtcEditorSettingsStore = create<RtcEditorSettingsState>((set, get) => ({
	...loadSettings(),
	patch: (part) => {
		const cur = pick(get());
		const next = normalizeEditorSettings({ ...cur, ...part });
		if (
			next.bigStepFrames === cur.bigStepFrames &&
			next.bigValueStep === cur.bigValueStep &&
			next.imageDefaultSec === cur.imageDefaultSec
		) {
			return;
		}
		set(next);
		persist(next);
	},
	reset: () => {
		set({ ...DEFAULT_EDITOR_SETTINGS });
		persist({ ...DEFAULT_EDITOR_SETTINGS });
	},
}));

/** 图片默认时长（微秒）——timelineUtil / segActions 的图片入轨与占位时长统一从这里取 */
export function imageDefaultUsFromSettings(): number {
	return Math.round(useRtcEditorSettingsStore.getState().imageDefaultSec * 1_000_000);
}
