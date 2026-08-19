/**
 * 参考视频按秒计费（第140轮，用户定「与出片同价」）。
 *
 * 规则：模型声明 `refVideoSecondsWeight`（>0，按秒视频模型专用）时——
 *   计费秒数 = duration + 系数 × Σ ceil(每条参考视频秒)   （不足1秒算1秒，逐条向上取整）
 * 实现方式：planBilling **之前**把合成后的计费秒数写进计费参数副本（原 params 不动、发上游不受影响），
 * 于是 用户售价/渠道商逐级结算链/档位路由价/402 预检/失败退款 全部自动包含参考视频费用——
 * 零定价链改造（与 resolveModelCost「一把尺」原则一致）。
 *
 * 时长来源（逐条，三级）：
 *   ① 资产台账缓存（assets.duration_ms——新上传视频入库时已解析；老资产探测一次后回填）；
 *   ② 服务端内存字节（未配 OSS 的 /raw 兜底模式）直接解析；
 *   ③ OSS/公网直链 HTTP Range 探测（mp4meta.probeRemoteDurationMs，只拉元数据字节）→ 有 id 则回填台账。
 * ⚠ 读不出时长（非 mp4/mov、网络失败）→ 明确报错拒单（不下单不扣费）：静默按 0 = 漏收，瞎按上限 = 多收，
 *   报错优于编造（§9 零兜底原则）。
 */
import { parseMp4DurationMs, probeRemoteDurationMs } from "./mp4meta.ts";
import { getAsset, getAssetBytes, setAssetDurationMs } from "./store/assets.ts";
import type { ModelDef } from "./store/models.ts";
import type { AssetRef, GenerateRequest } from "./contract.ts";

/** webview 伪域直链（http://asset.localhost/...）只在客户端本机可达，服务端探测必失败 → 不作探测源 */
function isWebviewLocalUrl(u: string): boolean {
	try {
		return new URL(u).hostname.toLowerCase().endsWith(".localhost");
	} catch {
		return true;
	}
}
const usableUrl = (u?: string): string => (u && /^https?:\/\//i.test(u) && !isWebviewLocalUrl(u) ? u : "");

/** 裸 URL 素材（无资产 id）的探测结果内存缓存（有 id 的走台账持久缓存） */
const urlCache = new Map<string, number>();
const URL_CACHE_MAX = 500;

async function durationMsOf(ref: AssetRef, probe: typeof probeRemoteDurationMs): Promise<number | null> {
	// ① 台账缓存
	const rec = ref.id ? getAsset(ref.id) : undefined;
	if (rec?.durationMs && rec.durationMs > 0) return rec.durationMs;
	// ② 服务端内存字节（无 OSS 降级模式）
	if (ref.id) {
		const bytes = getAssetBytes(ref.id);
		if (bytes) {
			const ms = parseMp4DurationMs(bytes);
			if (ms && ms > 0) {
				setAssetDurationMs(ref.id, ms);
				return ms;
			}
		}
	}
	// ③ 远端探测（台账直链优先——id 是真理，ref.url 只是缓存）
	const url = usableUrl(rec?.url) || usableUrl(ref.url);
	if (!url) return null;
	const cached = urlCache.get(url);
	if (cached && cached > 0) return cached;
	const ms = await probe(url);
	if (ms && ms > 0) {
		if (ref.id) setAssetDurationMs(ref.id, ms);
		if (urlCache.size >= URL_CACHE_MAX) urlCache.delete(urlCache.keys().next().value!);
		urlCache.set(url, ms);
		return ms;
	}
	return null;
}

export interface RefVideoBilling {
	/** 喂给 planBilling 的计费参数（不折算时=原 params 引用；折算时=副本，原对象不动） */
	params: Record<string, unknown> | undefined;
	/** 折算前的参考视频计费秒数合计（Σ 逐条 ceil；0=未折算），请求日志/排查用 */
	refSeconds: number;
	/** 有值=拒单文案（读不出某条参考视频的时长） */
	error?: string;
}

/**
 * 计算含参考视频折算的计费参数。仅当 模型声明 weight>0 且配了 costField 且带视频素材 且
 * 基础计费秒数有效（>0，否则维持原兜底价路径）时折算；其余情况原样返回（零开销）。
 */
export async function refVideoBillingParams(
	md: ModelDef | undefined,
	params: Record<string, unknown> | undefined,
	inputs: GenerateRequest["inputs"],
	probe: typeof probeRemoteDurationMs = probeRemoteDurationMs,
): Promise<RefVideoBilling> {
	const weight = Number(md?.refVideoSecondsWeight) || 0;
	const vids = inputs?.videos ?? [];
	const field = md?.costField;
	if (!md || weight <= 0 || !field || !vids.length) return { params, refSeconds: 0 };
	// 基础计费秒数无效（缺参/0）→ 不折算，维持既有「兜底固定价」路径（cost 已按最高时长定价）
	const base = Number(params?.[field]) || 0;
	if (base <= 0) return { params, refSeconds: 0 };

	let refSeconds = 0;
	for (let i = 0; i < vids.length; i++) {
		const ms = await durationMsOf(vids[i], probe);
		if (!ms || ms <= 0) {
			const label = vids[i].name || vids[i].id || vids[i].url || `第 ${i + 1} 条`;
			return {
				params,
				refSeconds: 0,
				error: `参考视频「${label}」无法读取时长，无法按秒计费：请改用 mp4/mov 格式或重新上传后重试`,
			};
		}
		refSeconds += Math.ceil(ms / 1000); // 逐条向上取整：不足1秒算1秒
	}
	return { params: { ...params, [field]: base + weight * refSeconds }, refSeconds };
}
