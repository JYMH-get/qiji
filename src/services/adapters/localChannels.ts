/**
 * localChannels —— 「模型源 → 模型」两级选择助手。
 *
 * 三个并列的源：LibTV / 即梦（本地 CLI 渠道）与 Qiji（管理端下发的模型）。三者同形：一级下拉选源，
 * 二级「模型」下拉选款式（Seedance 2.0 / Fast / VIP…）。画布视频面板呈现为 渠道 pill + 模型 pill。
 *
 * 差别只在款式清单从哪来：本地渠道是编译期常量（各 adapter 的 *_MODEL_CHOICES），Qiji 随 catalog 动态
 * 下发——所以 Qiji 源由调用方把该能力的平铺清单交给 modelChannels(opts, true) 派生成渠道表，再喂给下面
 * 四个函数。不传渠道表 = 只有本地渠道、管理端模型平铺各占一源（图/文/音沿用此行为，只有视频分 Qiji 源）。
 *
 * 加新款：本地渠道只改各 adapter 的 CHOICES 一处；Qiji 只在管理端加模型（catalog 热更即生效）。
 */
import { LIBTV_CHANNEL, LIBTV_MODEL_CHOICES } from "./libtvAdapter";
import { DREAMINA_CHANNEL, DREAMINA_MODEL_CHOICES } from "./dreaminaAdapter";
import { COMFYUI_CHANNEL, COMFYUI_MODEL_CHOICES } from "./comfyuiAdapter";

export interface LocalChannelChoice {
	id: string;
	/** 全名（平铺下拉/标题栏用），如「即梦 · Seedance 2.0 VIP」 */
	label: string;
	/** 渠道内短名（二级模型选择用），如「Seedance 2.0 VIP」 */
	variantLabel: string;
}

export interface LocalChannelInfo {
	channel: string;
	choices: LocalChannelChoice[];
}

/** 平铺模型清单项（catalog 模型 / 本地渠道模型统一形态）。modeId/modeName 供「按模式折叠成源」（第131轮）；
 *  familyId/familyName 供「家族→渠道/线路→模型」三级折叠（第163轮，家族=一级筛选） */
export interface ModelOpt {
	id: string;
	label: string;
	/** catalog 模型归属模式 id（无=默认模式）；本地 CLI 模型无此字段 */
	modeId?: string;
	/** 模式显示名（catalog.modes 投影）；缺省回退 modeId */
	modeName?: string;
	/** 家族 id（catalog 模型 familyId；本地 CLI Seedance 模型=SEEDANCE_FAMILY_ID）；无=「其他」 */
	familyId?: string;
	/** 家族显示名（catalog.families 投影）；缺省回退 familyId */
	familyName?: string;
}

const CHANNELS: LocalChannelInfo[] = [
	{ channel: LIBTV_CHANNEL, choices: LIBTV_MODEL_CHOICES },
	{ channel: DREAMINA_CHANNEL, choices: DREAMINA_MODEL_CHOICES },
	{ channel: COMFYUI_CHANNEL, choices: COMFYUI_MODEL_CHOICES },
];

/** 无模式管理端模型的兜底源名（第131轮改「默认」——服务端迁移已把无模式视频模型并入 qiji 模式，
 *  正常不出现；管理端新建视频模型没选模式时才现形，叫「默认」避免与「Qiji 视频」模式看着重复） */
export const QIJI_CHANNEL = "默认";

/** modelKey 属于哪个本地 CLI 渠道（不属于任何一个返回 null）；判断「是否走本机 CLI」用它 */
export function localChannelOf(modelKey: string | undefined | null): LocalChannelInfo | null {
	if (!modelKey) return null;
	return CHANNELS.find((ch) => ch.choices.some((c) => c.id === modelKey)) ?? null;
}

/** 按渠道名取本地渠道信息 */
export function localChannelByName(channel: string): LocalChannelInfo | null {
	return CHANNELS.find((ch) => ch.channel === channel) ?? null;
}

// ── 「模型源 → 模型」两级选择 ──
/** 模型源 value 里表示「渠道」的前缀（区别于不属于任何渠道的模型 id） */
export const CHANNEL_SOURCE_PREFIX = "src:";

/**
 * 某能力的渠道表 = 本地 CLI 渠道 +（qiji=true 时）清单里的管理端模型折叠成的模式源。
 * 第131轮起「模式=源头级」：带 modeId 的管理端模型**按模式分桶**（源名=模式名，如 Qiji 视频/简梦GF/
 * 简梦431/简梦933），无 modeId 的仍折叠进旧「Qiji」兜底源。qiji=false 或清单里没有管理端模型 →
 * 只有本地渠道（管理端模型平铺=源本身，旧行为）。渠道表按 opts 顺序稳定，供调用方 useMemo 后喂给下面四个函数。
 */
export function modelChannels(opts: ModelOpt[], qiji = false): LocalChannelInfo[] {
	if (!qiji) return CHANNELS;
	const managed = opts.filter((o) => !localChannelOf(o.id));
	if (!managed.length) return CHANNELS;
	const byMode = new Map<string, LocalChannelInfo>();
	const flat: LocalChannelChoice[] = [];
	for (const o of managed) {
		const choice: LocalChannelChoice = { id: o.id, label: o.label, variantLabel: o.label };
		if (o.modeId) {
			const g = byMode.get(o.modeId) ?? { channel: o.modeName || o.modeId, choices: [] };
			g.choices.push(choice);
			byMode.set(o.modeId, g);
		} else {
			flat.push(choice);
		}
	}
	const out = [...CHANNELS, ...byMode.values()];
	if (flat.length) out.push({ channel: QIJI_CHANNEL, choices: flat });
	return out;
}

/** modelId 属于渠道表里的哪个源（LibTV/即梦/Qiji）；不属于任何一个返回 null */
export function channelOf(
	modelId: string | undefined | null,
	channels: LocalChannelInfo[] = CHANNELS,
): LocalChannelInfo | null {
	if (!modelId) return null;
	return channels.find((ch) => ch.choices.some((c) => c.id === modelId)) ?? null;
}

/** 由某能力的平铺模型清单构建「模型源」下拉项：渠道折叠为一项（value=src:渠道名）；不属任何渠道的模型各占一项（value=模型id） */
export function buildModelSourceOptions(
	opts: ModelOpt[],
	channels: LocalChannelInfo[] = CHANNELS,
): { value: string; label: string }[] {
	const out: { value: string; label: string }[] = [];
	const seen = new Set<string>();
	for (const o of opts) {
		const ch = channelOf(o.id, channels);
		if (!ch) { out.push({ value: o.id, label: o.label }); continue; }
		if (seen.has(ch.channel)) continue;
		seen.add(ch.channel);
		out.push({ value: CHANNEL_SOURCE_PREFIX + ch.channel, label: ch.channel });
	}
	return out;
}

/** 当前模型 id → 模型源 value（属于某渠道=src:渠道名，否则=模型 id 本身） */
export function sourceValueOf(modelId: string | undefined | null, channels: LocalChannelInfo[] = CHANNELS): string {
	const ch = channelOf(modelId, channels);
	return ch ? CHANNEL_SOURCE_PREFIX + ch.channel : (modelId || "");
}

/** 选了某个模型源 → 应设置的模型 id（渠道：已在该渠道则保持款式，否则取默认款；非渠道源：源值即模型 id） */
export function modelForSource(
	sourceValue: string,
	currentId?: string | null,
	channels: LocalChannelInfo[] = CHANNELS,
): string {
	if (!sourceValue.startsWith(CHANNEL_SOURCE_PREFIX)) return sourceValue;
	const name = sourceValue.slice(CHANNEL_SOURCE_PREFIX.length);
	const ch = channels.find((c) => c.channel === name) ?? null;
	if (!ch) return "";
	if (currentId && ch.choices.some((c) => c.id === currentId)) return currentId;
	return ch.choices[0].id;
}

/** 某模型 id 的二级「模型款式」选项（属于某渠道才有；否则返回 null=无二级） */
export function modelVariantsOf(
	modelId: string | undefined | null,
	channels: LocalChannelInfo[] = CHANNELS,
): { id: string; label: string }[] | null {
	const ch = channelOf(modelId, channels);
	if (!ch) return null;
	return ch.choices.map((c) => ({ id: c.id, label: c.variantLabel }));
}

// ── 「家族 → 渠道/线路 → 模型」三级折叠（第163轮，家族=一级筛选）──────────────
// 家族 = 底层模型种类（Seedance 2.0 / Sora2 / GPT Image 2…，服务端 families 注册表）；
// 渠道/线路 = 家族内的源（模式名 / 本地 CLI 渠道名 / 无模式兜底「默认」——沿用第131轮源语义）；
// 模型 = 源内款式。视频/图像能力的所有模型选择 UI（ModelPicker / 表格单卡 / 画布双 pill）统一走这套。

/** 家族分组：familyId=""（未分家族）归「其他」，排序恒最后 */
export interface FamilyGroup {
	familyId: string;
	familyName: string;
	/** 家族内的「渠道/线路」源；源内 choices 即第三级「模型」款式 */
	channels: LocalChannelInfo[];
}

/**
 * 平铺清单 → 家族分组。familyOrder=家族排序（catalog.families 序）；未在列的按首现顺序排其后，
 * 「其他」（无 familyId）恒最后。源顺序/款式顺序均按 opts 原序稳定。
 */
export function modelFamilies(opts: ModelOpt[], familyOrder?: string[]): FamilyGroup[] {
	const groups = new Map<string, FamilyGroup>();
	for (const o of opts) {
		const fid = o.familyId ?? "";
		let g = groups.get(fid);
		if (!g) {
			g = { familyId: fid, familyName: fid ? (o.familyName || fid) : "其他", channels: [] };
			groups.set(fid, g);
		}
		// 源名：本地 CLI 渠道名 > 模式名 > 「默认」兜底（与 modelChannels 同语义）
		const local = localChannelOf(o.id);
		const srcName = local ? local.channel : (o.modeId ? (o.modeName || o.modeId) : QIJI_CHANNEL);
		let ch = g.channels.find((c) => c.channel === srcName);
		if (!ch) {
			ch = { channel: srcName, choices: [] };
			g.channels.push(ch);
		}
		// 本地 CLI 模型用渠道常量里的短款式名（「Seedance 2.0 Fast」），catalog 模型款式名=label
		const variantLabel = local?.choices.find((c) => c.id === o.id)?.variantLabel ?? o.label;
		ch.choices.push({ id: o.id, label: o.label, variantLabel });
	}
	const order = familyOrder ?? [];
	const idx = (fid: string) => {
		const i = order.indexOf(fid);
		return i >= 0 ? i : order.length;
	};
	return [...groups.values()].sort((a, b) => {
		if (!a.familyId !== !b.familyId) return a.familyId ? -1 : 1; // 「其他」恒最后
		return idx(a.familyId) - idx(b.familyId);
	});
}

/** modelId 属于哪个家族分组（不在任何分组返回 null） */
export function familyOf(modelId: string | undefined | null, families: FamilyGroup[]): FamilyGroup | null {
	if (!modelId) return null;
	return families.find((f) => f.channels.some((ch) => ch.choices.some((c) => c.id === modelId))) ?? null;
}

/** 选了某家族 → 应设置的模型 id（当前模型已在该家族则保持；否则取家族第一个源的第一款；家族不存在=""） */
export function modelForFamily(familyId: string, currentId: string | undefined | null, families: FamilyGroup[]): string {
	const f = families.find((x) => x.familyId === familyId);
	if (!f) return "";
	if (currentId && f.channels.some((ch) => ch.choices.some((c) => c.id === currentId))) return currentId;
	return f.channels[0]?.choices[0]?.id ?? "";
}

/** 本地 CLI 模型 id → 全名（标题栏等非下拉场景显示实名） */
export const LOCAL_MODEL_LABELS: Record<string, string> = Object.fromEntries(
	CHANNELS.flatMap((ch) => ch.choices.map((c) => [c.id, c.label])),
);
