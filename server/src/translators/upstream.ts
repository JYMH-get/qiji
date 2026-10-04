/**
 * 把一个模型定义解析成上游调用参数（地址 / 密钥 / 上游模型名）。
 *
 * 优先级（地址/密钥）：模型自身 baseUrl/apiKey 覆盖 > 归属渠道(channelId) > 网关默认。
 * 上游模型名：命中的重定向规则 routes（按请求参数）> 模型 upstreamModel > 模型 id。
 * 这样管理端按渠道分类模型（同渠道共用 url+key），并能对一个逻辑模型按请求做重定向。
 */
import { config } from "../config.ts";
import { matchRoute } from "../store/models.ts";
import type { ModelDef } from "../store/models.ts";
import { getChannel } from "../store/channels.ts";
import type { GenerateRequest } from "../contract.ts";
import { imageRoutingParams } from '../imageRouting.ts';

export interface Upstream {
	baseUrl: string;
	apiKey: string;
	upstreamModel: string;
	imageMaterialMode?: 'direct' | 'url';
	textReasoningDefaults?: Record<string, unknown>;
}

const strip = (u: string) => u.replace(/\/+$/, "");

export function effectiveImageMaterialMode(m: ModelDef, upstreamModel = m.upstreamModel || m.id): 'direct' | 'url' | undefined {
	return m.capability === 'image' ? m.imageMaterialMode ?? (m.protocol === 'gemini-image' || m.protocol === 'yali-image' && /gemini|banana/i.test(upstreamModel) ? 'direct' : 'url') : undefined;
}

/** 派发和渠道观测必须使用同一重定向结果。 */
export function resolveUpstreamRoute(m: ModelDef, rawParams?: GenerateRequest['params']) {
	// 图片计价和实际重定向共用只读档位视图；保留 size 等其他匹配条件及原请求值。
	const params = m.capability === 'image'
		? { ...rawParams, ...imageRoutingParams(rawParams ?? {}) }
		: rawParams;
	return matchRoute(m, params);
}

export function resolveUpstream(m: ModelDef, req?: GenerateRequest): Upstream {
	const route = resolveUpstreamRoute(m, req?.params);
	const upstreamModel = route?.upstreamModel || m.upstreamModel || m.id;

	// 渠道凭据：路由可改用另一渠道，否则用模型归属渠道
	const ch = getChannel(route?.channelId || m.channelId || "");

	// 默认渠道：简梦视频/火山 MediaKit/苏打水/星辰/画影/Dimensio/Aivide/简梦P 各走独立网关，其余走 g-aisc 聚合网关
	const fallback =
		(route?.channelId || m.channelId) === "ch-zongheng" || m.protocol === "zongheng-video" ? config.zongheng : m.protocol === "xingguang-video" ? config.xingguang : m.protocol === "xiha888-image" ? config.xiha888 : m.protocol === "longyou-video" ? config.longyou : m.protocol === "jianmeng-video"
			? { baseUrl: config.jianmeng.baseUrl, apiKey: config.jianmeng.apiKey || config.gateway.apiKey }
			: m.protocol === "volc-mediakit"
				? { baseUrl: config.volc.baseUrl, apiKey: config.volc.apiKey }
				: m.protocol === "sudashui-video"
					? { baseUrl: config.sudashui.baseUrl, apiKey: config.sudashui.apiKey }
					: m.protocol === "aistars-video" || m.protocol === "aistars-image"
						? { baseUrl: config.aistars.baseUrl, apiKey: config.aistars.apiKey }
						: m.protocol === "huaying-video"
							? { baseUrl: config.huaying.baseUrl, apiKey: config.huaying.apiKey }
							: m.protocol === "dimensio-video"
								? { baseUrl: config.dimensio.baseUrl, apiKey: config.dimensio.apiKey }
								: m.protocol === "aivide-video"
									? { baseUrl: config.aivide.baseUrl, apiKey: config.aivide.apiKey }
									: m.protocol === "jianmengp-video"
										? { baseUrl: config.jianmengp.baseUrl, apiKey: config.jianmengp.apiKey }
										: m.protocol === "musem-video"
											? { baseUrl: config.musem.baseUrl, apiKey: config.musem.apiKey }
											: m.protocol === "jmz-video" || m.protocol === "jmz-image"
												? { baseUrl: config.jmz.baseUrl, apiKey: config.jmz.apiKey }
													: m.protocol === "jmt-video"
														? { baseUrl: config.jmt.baseUrl, apiKey: config.jmt.apiKey }
														: m.protocol === "jmf-video"
															? { baseUrl: config.jmf.baseUrl, apiKey: config.jmf.apiKey }
															: m.protocol === "overseas-video"
																? { baseUrl: config.overseas.baseUrl, apiKey: config.overseas.apiKey }
																: m.protocol === "suanli-video"
																	? { baseUrl: config.suanli.baseUrl, apiKey: config.suanli.apiKey }
																		: m.protocol === "yali-image"
																			? { baseUrl: config.yali.baseUrl, apiKey: config.yali.apiKey }
																		: m.protocol === "skylee-image"
																			? { baseUrl: config.skylee.baseUrl, apiKey: config.skylee.apiKey }
																		: m.protocol === "congge-image" || m.protocol === "congge-video"
																			? { baseUrl: config.congge.baseUrl, apiKey: config.congge.apiKey }
																	: m.protocol === "autodl-video"
																		? { baseUrl: config.autodl.baseUrl, apiKey: config.autodl.apiKey }
																	: m.protocol === "qijicloud-comfy"
																		? { baseUrl: config.qijicloud.baseUrl, apiKey: config.qijicloud.apiKey }
																	: m.protocol === "bys-video"
																		? { baseUrl: config.bys.baseUrl, apiKey: config.bys.apiKey }
																				: m.protocol === "qiqi-video"
																					? { baseUrl: config.qiqi.baseUrl, apiKey: config.qiqi.apiKey }
																				: m.protocol === "official-video"
																					? { baseUrl: config.official.baseUrl, apiKey: config.official.apiKey }
																				: m.protocol === "zero007-video"
																					? { baseUrl: config.zero007.baseUrl, apiKey: config.zero007.apiKey }
																				: { baseUrl: config.gateway.baseUrl, apiKey: config.gateway.apiKey };

	const baseUrl = m.baseUrl || ch?.baseUrl || fallback.baseUrl;
	const apiKey = m.apiKey || ch?.apiKey || fallback.apiKey;

	const textReasoningDefaults = m.capability === 'text'
		? Object.fromEntries(m.params.filter(field => ['thinkingMode', 'reasoning_effort'].includes(field.key) && field.default !== undefined).map(field => [field.key, field.default]))
		: undefined;
	return { baseUrl: strip(baseUrl), apiKey, upstreamModel, imageMaterialMode: effectiveImageMaterialMode(m, upstreamModel), textReasoningDefaults };
}
