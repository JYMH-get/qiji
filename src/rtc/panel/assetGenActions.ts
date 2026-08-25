/**
 * assetGenActions —— 实时剪辑右栏「项目资产」的基础形象出图动作。
 *
 * ⚠ 红线（勿回退）：生成请求**只走库内唯一路径** generationQueue.startGeneration
 *   （断连保护/任务态/结果落资产全由它承载）；本文件不拼任何提示词模板正文——
 *   参数组装逐字段对齐 AssetWorkbench.generateForm（同一资产行为的属性化视图，两处必须同尺）。
 *   变体出图（图生图/垫图）本轮不做——本文件只出**基础形象**（variantId 恒 null，无 input/refs）。
 *
 * 模块保持纯可测：顶层只静态引类型与 genParams 纯函数；store/队列等重依赖在
 * generateAssetBaseImage 内动态 import（与 shotGenActions 引 inferRun 同模式）。
 */
import type { Purpose } from "@/contract";
import type { GenSpec } from "@/services/generationQueue";
import type { AssetCat } from "@/store/projectStore";
import { resolveSize, clampImageResolution, imageResolutionOptions } from "@/lib/genParams";
import { assetImageAspectFrom } from "@/lib/templateAspect";

/** 五类资产 → 出图 purpose（与 AssetWorkbench 各页 imagePurpose 一致：群像与角色共用 character 出图用途，前缀 G） */
export const ASSET_IMAGE_PURPOSE: Record<AssetCat, Purpose> = {
	characters: "asset.character.image",
	crowds: "asset.character.image",
	scenes: "asset.scene.image",
	organisms: "asset.creature.image",
	items: "asset.prop.image",
};

/** 资产 id 类型前缀（与 AssetWorkbench CAT_PREFIX 同表：管理端据此分配 C00000123 等台账编号） */
export const ASSET_CAT_PREFIX: Record<AssetCat, string> = { characters: "C", crowds: "G", scenes: "S", organisms: "M", items: "P" };

/** 分类中文名（右栏资产视图显示用；items 在实时剪辑面板沿用「道具」叫法） */
export const ASSET_CAT_LABEL: Record<AssetCat, string> = { characters: "角色", crowds: "群像", scenes: "场景", organisms: "生物", items: "道具" };

export interface AssetGenInput {
	id: string;
	name: string;
	prompt?: string;
}

/**
 * 纯函数：组装基础形象出图 GenSpec（与 AssetWorkbench.generateForm 逐字段对齐——
 * params={size,quality,idPrefix,assetName}、purpose 按分类映射、variantId=null）。
 * 无提示词返回 { error }（明确报错不发请求）；resOptions=当前生效图像模型开放的分辨率档
 * （服务端 catalog 控档，选择不在开放集时归一到第一档——与资产模式同一把尺）。
 */
export function buildAssetBaseGenSpec(
	cat: AssetCat,
	asset: AssetGenInput,
	modelKey: string,
	resOptions?: { v: string }[],
	ui?: { aspect?: string; resolution?: string; quality?: string },
): { spec: GenSpec } | { error: string } {
	const prompt = (asset.prompt || "").trim();
	if (!prompt) return { error: "该资产暂无出图提示词，请先填写出图提示词。" };
	const aspect = ui?.aspect || "16:9";
	const resolution = clampImageResolution(ui?.resolution ?? "2k", resOptions);
	const quality = ui?.quality || "high";
	return {
		spec: {
			cat,
			assetId: asset.id,
			variantId: null,
			purpose: ASSET_IMAGE_PURPOSE[cat],
			prompt,
			modelKey: modelKey || undefined,
			params: { size: resolveSize(aspect, resolution), quality, idPrefix: ASSET_CAT_PREFIX[cat], assetName: asset.name },
			label: asset.name,
		},
	};
}

/**
 * 提交「生成基础形象 / 重新生成」：读最新资产 → 组装 spec → startGeneration（唯一路径）。
 * 已有同资产基础形象在途（running）时忽略（按钮已禁用，双保险）。返回是否已提交。
 */
export async function generateAssetBaseImage(cat: AssetCat, assetId: string): Promise<boolean> {
	const { useProjectStore } = await import("@/store/projectStore");
	const st = useProjectStore.getState();
	const asset = (st[cat] as AssetGenInput[]).find((a) => a.id === assetId);
	if (!asset) return false;
	if (st.pendingGens.some((p) => p.cat === cat && p.assetId === assetId && (p.variantId ?? null) === null && p.status === "running")) return false;
	const { effectiveModelKey } = await import("@/components/ModelPicker");
	const { useCatalogStore } = await import("@/store/catalogStore");
	const modelKey = effectiveModelKey("image");
	const model = useCatalogStore.getState().model(modelKey);
	// 第243轮比例决定链（与 AssetWorkbench 初始值同一把尺）：资产拆分模板名内嵌比例 > 项目默认影片比例 > 16:9
	const aspect = assetImageAspectFrom(
		useCatalogStore.getState().catalog?.templates,
		st.mediaSettings?.assetExtractTplId,
		st.mediaSettings?.imageAspect,
	);
	const r = buildAssetBaseGenSpec(cat, asset, modelKey, imageResolutionOptions(model), { aspect });
	if ("error" in r) { alert(r.error); return false; }
	const { startGeneration } = await import("@/services/generationQueue");
	startGeneration(r.spec);
	return true;
}
