/**
 * 把一个模型定义解析成上游调用参数（地址 / 密钥 / 上游模型名）。
 * 模型未单独配置时回退到网关默认。这样管理端编辑"翻译格式"即生效。
 */
import { config } from "../config.ts";
import type { ModelDef } from "../store/models.ts";

export interface Upstream {
	baseUrl: string;
	apiKey: string;
	upstreamModel: string;
}

export function resolveUpstream(m: ModelDef): Upstream {
	// 简梦视频走独立渠道（不同 baseUrl + 不同 sk-），模型未覆盖时回退到 config.jianmeng
	if (m.protocol === "jianmeng-video") {
		return {
			baseUrl: (m.baseUrl || config.jianmeng.baseUrl).replace(/\/+$/, ""),
			apiKey: m.apiKey || config.jianmeng.apiKey || config.gateway.apiKey,
			upstreamModel: m.upstreamModel || m.id,
		};
	}
	return {
		baseUrl: (m.baseUrl || config.gateway.baseUrl).replace(/\/+$/, ""),
		apiKey: m.apiKey || config.gateway.apiKey,
		upstreamModel: m.upstreamModel || m.id,
	};
}
