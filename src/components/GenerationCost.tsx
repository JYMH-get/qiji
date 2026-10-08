import { useEffect, type CSSProperties } from "react";
import { useCatalogStore } from "@/store/catalogStore";
import { ensureVideoDuration, useVideoDurationStore } from "@/store/videoDurationStore";
import { localChannelOf } from "@/services/adapters/localChannels";
import { thirdPartyFeeCredits } from "@/services/thirdPartyFee";
import { generationCostLabel, sumGenerationCosts, type GenerationCostRequest } from "@/lib/generationCost";

export function useGenerationCosts(requests: readonly GenerationCostRequest[]): number | null {
	const catalog = useCatalogStore(s => s.catalog);
	const videoSeconds = useVideoDurationStore(s => s.seconds);
	const videoSignature = JSON.stringify([...new Set(requests.flatMap(request => {
		const model = catalog?.models.find(item => item.id === request.modelKey);
		return (model?.refVideoSecondsWeight ?? 0) > 0 ? request.refVideoUris ?? [] : [];
	}))]);
	useEffect(() => {
		for (const uri of JSON.parse(videoSignature) as string[]) ensureVideoDuration(uri);
	}, [videoSignature]);
	return sumGenerationCosts(requests, {
		models: catalog?.models ?? [], videoSeconds,
		localModelKeys: requests.flatMap(request => request.modelKey && localChannelOf(request.modelKey) ? [request.modelKey] : []),
		thirdPartyFee: thirdPartyFeeCredits(),
	});
}

export type GenerationCostProps = GenerationCostRequest & {
	cost?: number | null;
	className?: string;
	style?: CSSProperties;
};

/** Compact, shared suffix for generation and chargeable retry buttons. */
export function GenerationCost({ cost, className, style, ...request }: GenerationCostProps) {
	const estimated = useGenerationCosts(cost === undefined ? [request] : []);
	const model = useCatalogStore(s => s.catalog?.models.find(item => item.id === request.modelKey));
	const hidden = cost === undefined && request.count !== 0 && !!model?.pricingHidden;
	const local = !!localChannelOf(request.modelKey);
	const title = hidden ? "实际积分按请求用量结算" : local
		? "Qiji 手续费标准价预估；实际结算以账户折扣为准，第三方平台费用另计"
		: "按当前参数的标准价预估，实际结算以账户折扣为准";
	return <span className={className} style={{ whiteSpace: "nowrap", ...style }} title={title} data-generation-cost>
		{" · "}{generationCostLabel(cost === undefined ? estimated : cost, hidden)}
	</span>;
}
