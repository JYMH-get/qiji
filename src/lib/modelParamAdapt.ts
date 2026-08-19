/**
 * 切换模型时把已选「要求」参数收敛到新模型的可用档位（单一事实来源）。
 *
 * 背景：模型的档位（分辨率/时长/比例…）由 catalog 按模型下发，切换模型后旧选择可能越档——
 * 提交层虽有收敛（pluginRegistry / genVideo），但**显示层仍是旧值**，用户看到的与实际发出的不一致。
 * 故模型切换的那一刻就把节点/设置里的值一并收敛落库，做到「显示=提交」。
 *
 * 语义（与 videoMethods.clampDurationTo / clampToOptions 同尺）：
 *  - 只改**不在新档位内**的值；已在档内的原样保留（勿把用户选择重置成默认）。
 *  - 未设置过的键不写（运行时按 default 走，勿凭空落值）。
 *  - 数字型枚举（时长档）就近取档、并列取小；其余枚举取 default（在档内时）否则首档。
 *  - number 型夹到 [min,max]。
 */

import { getNodeSpec } from "@/nodes/nodeSpecs";
import { useCatalogStore } from "@/store/catalogStore";
import { imageResolutionOptions, clampImageResolution } from "@/lib/genParams";

/** 结构化最小声明：兼容 contract.ParamField 与 adapters/types.ParamField 两处定义 */
export interface ParamFieldLike {
	key: string;
	type: string;
	options?: string[];
	default?: unknown;
	min?: number;
	max?: number;
}

/**
 * 某类节点在指定模型下**生效的参数表**（唯一一把尺：两个操作面板与共享设置扇出共用）。
 * 优先级与面板显示完全一致：
 *  - 第三方本地渠道（paramsFromMode，LibTV/即梦）：按第三方要求 mode.paramsSchema；
 *  - 图片节点：spec 固定参数，其中 resolution 档由 catalog 按模型下发覆盖；
 *  - 文本类节点：只用 spec 固定参数（catalog 的温度/长度等不对用户开放，勿动）；
 *  - 其余（视频等）：catalog 模型 params > spec 固定参数 > mode.paramsSchema。
 */
export function schemaForNodeModel(
	nodeType: string,
	modelKey: string,
	opts?: { paramsFromMode?: boolean; modeSchema?: ParamFieldLike[] },
): ParamFieldLike[] {
	if (opts?.paramsFromMode) return opts.modeSchema ?? [];
	const spec = getNodeSpec(nodeType);
	const specParams = (spec?.params ?? []) as ParamFieldLike[];
	const cm = useCatalogStore.getState().catalog?.models.find((m) => m.id === modelKey);
	const cap = spec?.capability;
	if (cap === "image") {
		const res = imageResolutionOptions(cm);
		return specParams.map((f) => (f.key === "resolution" && f.type === "enum"
			? { ...f, options: res.map((r) => r.v), default: clampImageResolution(f.default, res) }
			: f));
	}
	if (cap === "text" || cap == null) return specParams;
	if (cm?.params?.length) return cm.params as ParamFieldLike[];
	return specParams.length ? specParams : (opts?.modeSchema ?? []);
}

const numOf = (v: unknown): number | null => {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};

/** 就近取档（并列取小——档位按升序声明，先命中的即较小档，与 clampDurationTo 一致） */
function nearestOption(n: number, options: string[]): string | null {
	let best: string | null = null;
	let bestD = Infinity;
	for (const o of options) {
		const v = Number(o);
		if (!Number.isFinite(v)) continue;
		const d = Math.abs(v - n);
		if (d < bestD) {
			bestD = d;
			best = o;
		}
	}
	return best;
}

/**
 * 按新模型的参数表收敛已有参数，返回**仅含需变更键**的补丁（无需变更返回空对象）。
 * @param schema 新模型生效的参数表（catalog 模型 params / 节点 spec 固定参数 / 本地渠道 mode.paramsSchema）
 * @param params 当前已落的参数
 */
export function adaptParamsToSchema(
	schema: ParamFieldLike[] | undefined,
	params: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	if (!schema?.length || !params) return patch;
	for (const f of schema) {
		const cur = params[f.key];
		if (cur === undefined || cur === null || cur === "") continue;
		if (f.type === "enum") {
			const options = f.options ?? [];
			if (!options.length) continue;
			if (options.some((o) => String(o) === String(cur))) continue;
			const n = numOf(cur);
			const allNumeric = options.every((o) => Number.isFinite(Number(o)));
			if (n != null && allNumeric) {
				const pick = nearestOption(n, options);
				if (pick != null) patch[f.key] = typeof cur === "number" ? Number(pick) : pick;
				continue;
			}
			if (f.default !== undefined && options.some((o) => String(o) === String(f.default))) patch[f.key] = f.default;
			else patch[f.key] = options[0];
		} else if (f.type === "number") {
			const n = numOf(cur);
			if (n == null) continue;
			let v = n;
			if (f.min != null && v < f.min) v = f.min;
			if (f.max != null && v > f.max) v = f.max;
			if (v !== n) patch[f.key] = v;
		}
	}
	return patch;
}
