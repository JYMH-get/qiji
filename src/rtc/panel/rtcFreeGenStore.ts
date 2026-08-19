/**
 * rtcFreeGenStore —— 「自由结果占位」（时间轴空白右键新建、无 shotRef）的**生成参数草稿**。
 *
 * 为什么不落在片段上：`RtcSegment`（[types/rtc.ts](@/types/rtc)）本轮由时间轴任务独占、
 * 不可扩字段，而自由占位需要记住用户填的 提示词 / 模型 / 垫素材。故按库内既有惯例
 * （第204轮 requestLedger 的 `Qiji:requestLedger` 同款）落**应用级 localStorage 台账**，
 * key=片段 id（genId 全局唯一，跨项目不撞）。
 *
 * 已知边界（后续应把这三个字段并进 rtcDoc 一并落项目文件）：
 *   - 草稿不随项目文件走——换机/换设备打开同一项目，未生成的占位提示词不在（片段还在）；
 *   - 项目删了草稿会留下（靠 TTL + 容量上限自然淘汰，见 sanitizeDrafts）。
 * ⚠ 红线：草稿里的 refs 只存 assetId/uri 引用，**绝不存 base64/data:**（同项目文件红线）。
 */
import { create } from "zustand";

const LS_KEY = "Qiji:rtcFreeGen";
/** 最多保留多少条草稿（超出丢最旧的） */
export const DRAFT_MAX = 300;
/** 草稿保留期：30 天未更新即淘汰 */
export const DRAFT_TTL_MS = 30 * 24 * 3600 * 1000;

/** 垫素材引用（显示用 uri + 可选资产 id；提交时由 ensurePublicUrl 换成公网直链） */
export interface FreeGenRef {
	uri: string;
	assetId?: string;
	name?: string;
	media: "image" | "video" | "audio";
}

export interface FreeGenDraft {
	prompt: string;
	/** 显式选的模型（空=用 ModelPicker 的生效模型） */
	modelKey?: string;
	refs: FreeGenRef[];
	updatedAt: number;
}

export type FreeGenDraftMap = Record<string, FreeGenDraft>;

/** 空草稿（读不到时的稳定引用——直接 new 对象会让 React 每次渲染都判定变化） */
export const EMPTY_DRAFT: FreeGenDraft = Object.freeze({ prompt: "", refs: [], updatedAt: 0 }) as FreeGenDraft;

/* ────────────────────────── 纯函数（可单测） ────────────────────────── */

/** 单条草稿清洗：字段类型收敛、refs 只留有 uri 的、media 归一（脏数据不炸界面） */
export function sanitizeDraft(raw: unknown, nowMs: number): FreeGenDraft | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const prompt = typeof o.prompt === "string" ? o.prompt.slice(0, 20000) : "";
	const modelKey = typeof o.modelKey === "string" && o.modelKey ? o.modelKey : undefined;
	const refs: FreeGenRef[] = Array.isArray(o.refs)
		? (o.refs as unknown[])
				.map((r) => {
					const x = (r ?? {}) as Record<string, unknown>;
					const uri = typeof x.uri === "string" ? x.uri : "";
					if (!uri || /^data:/i.test(uri)) return null; // 红线：绝不收 base64
					const media = x.media === "video" || x.media === "audio" ? x.media : "image";
					return {
						uri,
						media,
						...(typeof x.assetId === "string" && x.assetId ? { assetId: x.assetId } : {}),
						...(typeof x.name === "string" && x.name ? { name: x.name } : {}),
					} as FreeGenRef;
				})
				.filter((r): r is FreeGenRef => !!r)
				.slice(0, 30)
		: [];
	const updatedAt = typeof o.updatedAt === "number" && Number.isFinite(o.updatedAt) ? o.updatedAt : nowMs;
	if (!prompt && refs.length === 0 && !modelKey) return null; // 空草稿不留
	return { prompt, refs, updatedAt, ...(modelKey ? { modelKey } : {}) };
}

/** 整表清洗：逐条 sanitize + TTL 淘汰 + 按更新时间保留最新 DRAFT_MAX 条 */
export function sanitizeDrafts(raw: unknown, nowMs: number): FreeGenDraftMap {
	if (!raw || typeof raw !== "object") return {};
	const out: [string, FreeGenDraft][] = [];
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		if (!k) continue;
		const d = sanitizeDraft(v, nowMs);
		if (!d) continue;
		if (nowMs - d.updatedAt > DRAFT_TTL_MS) continue;
		out.push([k, d]);
	}
	out.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
	return Object.fromEntries(out.slice(0, DRAFT_MAX));
}

/** 写入一条草稿（返回新表；patch 为空对象也会刷新 updatedAt——用于「我改过它」的语义） */
export function upsertDraft(
	map: FreeGenDraftMap,
	segId: string,
	patch: Partial<Omit<FreeGenDraft, "updatedAt">>,
	nowMs: number,
): FreeGenDraftMap {
	const cur = map[segId] ?? EMPTY_DRAFT;
	const next: FreeGenDraft = {
		prompt: patch.prompt !== undefined ? patch.prompt : cur.prompt,
		refs: patch.refs !== undefined ? patch.refs : cur.refs,
		updatedAt: nowMs,
		...(patch.modelKey !== undefined ? (patch.modelKey ? { modelKey: patch.modelKey } : {}) : cur.modelKey ? { modelKey: cur.modelKey } : {}),
	};
	return { ...map, [segId]: next };
}

/* ────────────────────────── store（localStorage 持久化） ────────────────────────── */

function load(): FreeGenDraftMap {
	try {
		const raw = localStorage.getItem(LS_KEY);
		return raw ? sanitizeDrafts(JSON.parse(raw), Date.now()) : {};
	} catch {
		return {}; // 存储不可用/脏数据：草稿丢了不影响剪辑本身
	}
}

function persist(map: FreeGenDraftMap): void {
	try {
		localStorage.setItem(LS_KEY, JSON.stringify(map));
	} catch {
		/* 配额满/隐私模式：静默（草稿是辅助数据） */
	}
}

interface FreeGenState {
	drafts: FreeGenDraftMap;
	/** 读一条草稿（无=EMPTY_DRAFT 稳定引用） */
	draftOf: (segId: string) => FreeGenDraft;
	patch: (segId: string, patch: Partial<Omit<FreeGenDraft, "updatedAt">>) => void;
	remove: (segId: string) => void;
}

export const useRtcFreeGenStore = create<FreeGenState>((set, get) => ({
	drafts: typeof localStorage === "undefined" ? {} : load(),
	draftOf: (segId) => get().drafts[segId] ?? EMPTY_DRAFT,
	patch: (segId, patch) => {
		const next = upsertDraft(get().drafts, segId, patch, Date.now());
		set({ drafts: next });
		persist(next);
	},
	remove: (segId) => {
		const cur = get().drafts;
		if (!cur[segId]) return;
		const next = { ...cur };
		delete next[segId];
		set({ drafts: next });
		persist(next);
	},
}));
