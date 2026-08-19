/**
 * ModelPicker —— 各生成界面的「模型选择」下拉（剧本/角色/群像/场景/生物/物品/视频共用）。
 *
 * 数据源：catalogStore（管理端下发的模型，按 capability 过滤；第132轮起全量可用，无「启用模型」子集）。
 * 选择持久化到项目级 projectModelConfig[cap]（随项目落盘、切页/重启不丢）；
 * **未做项目级选择时自动取该能力第一个可用模型**（第132轮，用户定：设置面板「模型」页已删除，
 * 不再有全局默认模型概念——catalog 序第一个即生效，零配置开箱即用；界面下拉如实显示当前用谁）。
 *
 * 生成时用 effectiveModelKey(cap) 解析出生效模型，显式传给 runPurpose({modelKey})。
 */
import { useMemo } from "react";
import { SEEDANCE_FAMILY_ID, type Capability } from "@/contract";
import { useCatalogStore } from "@/store/catalogStore";
import { useProjectStore } from "@/store/projectStore";
import { LIBTV_MODEL_CHOICES } from "@/services/adapters/libtvAdapter";
import { DREAMINA_MODEL_CHOICES } from "@/services/adapters/dreaminaAdapter";
import { modelChannels, buildModelSourceOptions, sourceValueOf, modelForSource, modelVariantsOf, modelFamilies, familyOf, modelForFamily, channelOf, type ModelOpt } from "@/services/adapters/localChannels";
import { useConnectionStore, useDreaminaFeature, useLibtvFeature } from "@/store/connectionStore";
import { useLibtvStore } from "@/store/libtvStore";
import { useDreaminaStore } from "@/store/dreaminaStore";

/** 非 hook：某能力第一个可用模型（catalog 序 × 模式门禁；catalog 无该能力模型时兜底已授权的本地 CLI 渠道） */
function firstModelKey(cap: Capability): string {
	const models = useCatalogStore.getState().catalog?.models ?? [];
	const feats = useConnectionStore.getState().user?.features;
	const m = models.find((x) => x.capability === cap && (!x.modeId || feats?.modes?.[x.modeId] !== false));
	if (m) return m.id;
	if (cap === "video") {
		if (feats?.libtv !== false && useLibtvStore.getState().authed) return LIBTV_MODEL_CHOICES[0].id;
		if (feats?.dreamina !== false && useDreaminaStore.getState().authed) return DREAMINA_MODEL_CHOICES[0].id;
	}
	return "";
}

/** 非 hook：某模型 key 当前是否可用（catalog 在列且模式未被禁；或已授权的本地 CLI 模型） */
function keyAvailable(cap: Capability, key?: string): boolean {
	if (!key) return false;
	const feats = useConnectionStore.getState().user?.features;
	const m = (useCatalogStore.getState().catalog?.models ?? []).find((x) => x.id === key);
	if (m) return m.capability === cap && (!m.modeId || feats?.modes?.[m.modeId] !== false);
	if (cap === "video") {
		if (LIBTV_MODEL_CHOICES.some((c) => c.id === key)) return feats?.libtv !== false && useLibtvStore.getState().authed;
		if (DREAMINA_MODEL_CHOICES.some((c) => c.id === key)) return feats?.dreamina !== false && useDreaminaStore.getState().authed;
	}
	return false;
}

/** 非 hook：解析某能力当前生效模型 key（项目级选择（仍可用）→ 自动取第一个可用 → ""=无可用模型）。
 *  供生成代码调用。⚠ 失效/被禁模式的项目级选择自动回落第一个——与界面下拉显示同一把尺，显示=实际提交。 */
export function effectiveModelKey(cap: Capability): string {
	const override = useProjectStore.getState().projectModelConfig?.[cap];
	if (override && keyAvailable(cap, override)) return override;
	return firstModelKey(cap);
}

/** hook：同 effectiveModelKey，但订阅项目级选择/catalog/门禁——模型切换后组件即时刷新（如按模型下发的参数档位） */
export function useEffectiveModelKey(cap: Capability): string {
	const override = useProjectStore((s) => s.projectModelConfig?.[cap]);
	const opts = useCapModelOptions(cap);
	return override && opts.some((o) => o.id === override) ? override : opts[0]?.id || "";
}

/**
 * hook：某能力在界面下拉可见的模型选项（catalog 全量 × 模式门禁 + 本地 LibTV 注入；
 * 第132轮删除「启用模型」子集——管理端下发即全部可用）。
 * **所有模型下拉的唯一数据源**：ModelPicker 本体 / 视频页提示词区单分镜覆盖下拉共用，
 * 保证「LibTV 授权后所有视频下拉都出现」。
 * 第131轮：①按 features.modes[modeId]===false 隐藏被禁模式的模型（第130轮服务端 403 的客户端收口，
 * 心跳 ≤30s 生效）；②选项携带 modeId/modeName（catalog.modes 投影）供「模式=源头级」分组折叠。
 */
export function useCapModelOptions(cap: Capability): ModelOpt[] {
	const models = useCatalogStore((s) => s.catalog?.models);
	const catalogModes = useCatalogStore((s) => s.catalog?.modes);
	const catalogFams = useCatalogStore((s) => s.catalog?.families);
	const modeGates = useConnectionStore((s) => s.user?.features?.modes);
	const libtvOn = useLibtvFeature();
	const libtvAuthed = useLibtvStore((s) => s.authed);
	const dreaminaOn = useDreaminaFeature();
	const dreaminaAuthed = useDreaminaStore((s) => s.authed);
	const modeName = (id?: string) => (id ? catalogModes?.find((m) => m.id === id)?.name || id : undefined);
	const famName = (id?: string) => (id ? catalogFams?.find((f) => f.id === id)?.name || id : undefined);
	const opts: ModelOpt[] = (models ?? [])
		.filter((m) => m.capability === cap)
		.filter((m) => !m.modeId || modeGates?.[m.modeId] !== false)
		.map((m) => ({ id: m.id, label: m.label, modeId: m.modeId, modeName: modeName(m.modeId), familyId: m.familyId, familyName: famName(m.familyId) }));
	// 本地模型注入（视频能力 + 已授权 + 管理端未关入口；请求走本机 CLI 不经管理端）：
	// LibTV 家族按款自带（Seedance 2.0 / MiniMax H3），即梦全系 Seedance；catalog 有同 id 家族时显示名跟随
	const seedanceName = famName(SEEDANCE_FAMILY_ID) || "Seedance 2.0";
	if (cap === "video" && libtvOn && libtvAuthed) {
		opts.push(...LIBTV_MODEL_CHOICES.map((c) => ({ id: c.id, label: c.label, familyId: c.familyId, familyName: famName(c.familyId) || c.familyName })));
	}
	if (cap === "video" && dreaminaOn && dreaminaAuthed) {
		opts.push(...DREAMINA_MODEL_CHOICES.map((c) => ({ id: c.id, label: c.label, familyId: SEEDANCE_FAMILY_ID, familyName: seedanceName })));
	}
	return opts;
}

/** hook：家族排序（catalog.families 序），「家族→渠道/线路→模型」一级下拉顺序用 */
export function useFamilyOrder(): string[] {
	const fams = useCatalogStore((s) => s.catalog?.families);
	return useMemo(() => (fams ?? []).map((f) => f.id), [fams]);
}

interface ModelPickerProps {
	cap: Capability;
	label?: string;
	style?: React.CSSProperties;
	/** 不渲染「请选择模型…」占位项（调用方保证有选中值，如处理弹窗的自动选中） */
	noPlaceholder?: boolean;
}

export default function ModelPicker({ cap, label = "模型", style, noPlaceholder }: ModelPickerProps) {
	const override = useProjectStore((s) => s.projectModelConfig?.[cap]);
	const setProjectModelConfig = useProjectStore((s) => s.setProjectModelConfig);

	// 该能力可选模型（统一数据源：catalog 全量 + LibTV/即梦注入）
	const opts = useCapModelOptions(cap);

	// 未显式选择/选择已失效 → 自动取第一个可用（与 effectiveModelKey 同一把尺，显示=实际提交）
	const value = override && opts.some((o) => o.id === override) ? override : opts[0]?.id ?? "";

	// 第163轮：视频/图像能力改「家族 → 渠道/线路 → 模型」三级选择（家族=模型种类一级筛选；
	// 渠道/线路=模式名/LibTV/即梦；模型=源内款式）。其余能力（文/音/处理类）保持旧两级：
	// 本地 CLI 渠道折叠、管理端模型平铺=源本身，行为不变。
	const fold = cap === "video" || cap === "image";
	const famOrder = useFamilyOrder();
	const families = useMemo(() => (fold ? modelFamilies(opts, famOrder) : []), [fold, opts, famOrder]);
	const curFam = fold ? familyOf(value, families) : null;
	const famChannels = curFam?.channels ?? [];
	const curCh = fold ? channelOf(value, famChannels) : null;
	// 旧两级（非折叠能力）
	const channels = useMemo(() => modelChannels(opts, false), [opts]);
	const srcOpts = buildModelSourceOptions(opts, channels);
	const variants = modelVariantsOf(value, channels);
	const selSt: React.CSSProperties = { flex: 1, minWidth: 0, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, color: "#fff", padding: "6px 8px", fontSize: 12, outline: "none", cursor: "pointer" };
	const optSt: React.CSSProperties = { background: "#1f1f2e" };

	if (fold) {
		return (
			<label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "rgba(255,255,255,0.55)", ...style }}>
				{label}
				<div style={{ display: "flex", gap: 6, flex: 1, minWidth: 0 }}>
					<select
						title="模型家族（模型种类）"
						value={curFam ? `f:${curFam.familyId}` : ""}
						onChange={(e) => { if (e.target.value) setProjectModelConfig({ [cap]: modelForFamily(e.target.value.slice(2), value, families) }); }}
						style={selSt}
					>
						{(!curFam || (!noPlaceholder && !value)) && (
							<option value="" style={optSt}>
								{opts.length ? "请选择模型…" : "无可用模型（先在设置连接管理端）"}
							</option>
						)}
						{families.map((f) => (
							<option key={f.familyId} value={`f:${f.familyId}`} style={optSt}>{f.familyName}</option>
						))}
					</select>
					{curFam && (
						<select
							title="渠道/线路"
							value={curCh ? sourceValueOf(value, famChannels) : ""}
							onChange={(e) => setProjectModelConfig({ [cap]: modelForSource(e.target.value, value, famChannels) })}
							style={selSt}
						>
							{famChannels.map((ch) => (
								<option key={ch.channel} value={`src:${ch.channel}`} style={optSt}>{ch.channel}</option>
							))}
						</select>
					)}
					{curCh && (
						<select
							title="模型（本线路款式）"
							value={value}
							onChange={(e) => setProjectModelConfig({ [cap]: e.target.value })}
							style={selSt}
						>
							{curCh.choices.map((c) => (
								<option key={c.id} value={c.id} style={optSt}>{c.variantLabel}</option>
							))}
						</select>
					)}
				</div>
			</label>
		);
	}

	return (
		<label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "rgba(255,255,255,0.55)", ...style }}>
			{label}
			<div style={{ display: "flex", gap: 6, flex: 1, minWidth: 0 }}>
				<select
					title="模型源"
					value={sourceValueOf(value, channels)}
					onChange={(e) => setProjectModelConfig({ [cap]: modelForSource(e.target.value, value, channels) })}
					style={selSt}
				>
					{(!noPlaceholder || !value) && (
						<option value="" style={optSt}>
							{opts.length ? "请选择模型源…" : "无可用模型（先在设置连接管理端）"}
						</option>
					)}
					{srcOpts.map((s) => (
						<option key={s.value} value={s.value} style={optSt}>{s.label}</option>
					))}
				</select>
				{variants && (
					<select
						title="模型（本源款式）"
						value={value}
						onChange={(e) => setProjectModelConfig({ [cap]: e.target.value })}
						style={selSt}
					>
						{variants.map((v) => (
							<option key={v.id} value={v.id} style={{ background: "#1f1f2e" }}>{v.label}</option>
						))}
					</select>
				)}
			</div>
		</label>
	);
}
