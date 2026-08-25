/**
 * modelOptions —— **按模型 key 取生成档位的唯一入口**（第251轮）。
 *
 * 背景（用户实报的长期 bug）：表格模式与实时剪辑取档位时只查 catalog
 * （`catalog.models.find(m => m.id === key)`），而画布模式还多一层「本地渠道适配器」回退
 * （见 [modelParamAdapt.schemaForNodeModel](./modelParamAdapt.ts)）。于是选中
 * **ComfyUI 直连 / LibTV / 即梦** 这类本地 CLI 模型时（它们的 id 不在 catalog 里）：
 *   - 显示：分辨率下拉掉回内置三档 480p/720p/1080p（服务端/适配器明明声明的是 480p/640p/768p/1080p）；
 *   - 提交：`clampToOptions` 按错档位收敛，把 720p 真发给只收 480/640/768/1080 的上游。
 *
 * ⚠ 规则（勿回退）：**任何「已知模型 key、要取档位」的地方一律走本模块**，
 * 不要再写 `models.find(m => m.id === key)` 然后喂 videoReqOptions/imageResolutionOptions——
 * 那正是漏掉本地渠道的写法。已知模型对象（如遍历 catalog 列表时）才直接用底层函数。
 */
import { getAdapter } from "@/services/adapters/registry";
import { useCatalogStore } from "@/store/catalogStore";
import { videoReqOptions, modelMethods, type VideoReqOptions, type VideoMethod, type ParamsCarrier } from "./videoMethods";
import { imageResolutionOptions } from "./genParams";

/**
 * 模型 key → 参数表载体：catalog 模型优先，查不到再回退本地渠道适配器的 mode.paramsSchema
 * （与画布 schemaForNodeModel 的优先级一致：本地渠道参数按第三方要求）。
 */
function paramsCarrierForKey(modelKey: string | undefined, cap: "video" | "image"): ParamsCarrier | undefined {
	if (!modelKey) return undefined;
	const cm = useCatalogStore.getState().catalog?.models.find((m) => m.id === modelKey);
	if (cm) return cm as ParamsCarrier;
	const ad = getAdapter(modelKey);
	if (!ad) return undefined;
	const mode = ad.modes.find((m) => m.key === cap) ?? ad.modes[0];
	return mode ? { params: mode.paramsSchema } : undefined;
}

/** 视频「要求」三档（时长/比例/分辨率）——含本地渠道回退 */
export function videoReqOptionsForKey(modelKey: string | undefined): VideoReqOptions {
	return videoReqOptions(paramsCarrierForKey(modelKey, "video"));
}

/** 图片分辨率档（1k/2k/4k 白名单内）——含本地渠道回退 */
export function imageResolutionOptionsForKey(modelKey: string | undefined): { v: string; label: string }[] {
	return imageResolutionOptions(paramsCarrierForKey(modelKey, "image") as Parameters<typeof imageResolutionOptions>[0]);
}

/**
 * 模型支持的「方法」（全能参考/首尾帧）。
 * 刻意只认 catalog：本地渠道（LibTV/即梦/ComfyUI）本就只有全能参考，modelMethods 缺省即 ["omni"]。
 */
export function modelMethodsForKey(modelKey: string | undefined): VideoMethod[] {
	const cm = modelKey ? useCatalogStore.getState().catalog?.models.find((m) => m.id === modelKey) : undefined;
	return modelMethods(cm);
}
