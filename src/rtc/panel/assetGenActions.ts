/**
 * assetGenActions —— 实时剪辑右栏「项目资产」的基础形象出图动作。
 *
 * ⚠ 红线（勿回退）：生成请求**只走库内唯一路径** generationQueue.startGeneration
 *   （断连保护/任务态/结果落资产全由它承载）；本文件不拼任何提示词模板正文——
 *   参数组装逐字段对齐 AssetWorkbench.generateForm（同一资产行为的属性化视图，两处必须同尺）。
 *   变体出图（图生图/垫图）本轮不做——本文件只出**基础形象**（variantId 恒 null，无 input/refs）。
 *
 * 基础形象没有异步素材准备：输入读取与队列受理同步完成，避免模块加载期间切项目串写。
 */
import type { Purpose } from "@/contract";
import { startGeneration, type GenSpec } from "@/services/generationQueue";
import { useProjectStore, type AssetCat } from "@/store/projectStore";
import { effectiveModelKey } from "@/components/ModelPicker";
import { useCatalogStore } from "@/store/catalogStore";
import { buildImageParams, imageResolutionOptions } from "@/lib/genParams";
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
 * 图片参数完整保留，purpose 按分类映射、variantId=null）。
 * 无提示词返回 { error }（明确报错不发请求）；resOptions=当前生效图像模型开放的分辨率档
 * （仅在请求未指定分辨率时选择默认档，不改写显式选择）。
 */
export function buildAssetBaseGenSpec(
	cat: AssetCat,
	asset: AssetGenInput,
	modelKey: string,
	resOptions?: { v: string }[],
	ui?: Record<string, unknown>,
): { spec: GenSpec } | { error: string } {
	const prompt = (asset.prompt || "").trim();
	if (!prompt) return { error: "该资产暂无出图提示词，请先填写出图提示词。" };
	return {
		spec: {
			cat,
			assetId: asset.id,
			variantId: null,
			purpose: ASSET_IMAGE_PURPOSE[cat],
			prompt,
			modelKey: modelKey || undefined,
			params: { ...buildImageParams(ui ?? {}, resOptions), idPrefix: ui?.idPrefix !== undefined ? ui.idPrefix : ASSET_CAT_PREFIX[cat], assetName: ui?.assetName !== undefined ? ui.assetName : asset.name },
			label: asset.name,
		},
	};
}

/**
 * 提交「生成基础形象 / 重新生成」：读最新资产 → 组装 spec → startGeneration（唯一路径）。
 * 受理前没有异步间隙；startGeneration 同步登记 pending，同资产连点由现有在途状态去重。
 * 保持 Promise 返回值以兼容调用方；不要在读输入与受理之间插入 await。
 */
export async function generateAssetBaseImage(cat: AssetCat, assetId: string): Promise<boolean> {
	const st = useProjectStore.getState();
	if (st.isProjectLoading) return false;
	const asset = (st[cat] as AssetGenInput[]).find((a) => a.id === assetId);
	if (!asset) return false;
	if (st.pendingGens.some((p) => p.cat === cat && p.assetId === assetId && (p.variantId ?? null) === null && p.status === "running")) return false;
	const modelKey = effectiveModelKey("image");
	const catalog = useCatalogStore.getState();
	// 第243轮比例决定链：资产拆分模板名内嵌比例 > 项目默认影片比例 > 16:9。
	const aspect = assetImageAspectFrom(catalog.catalog?.templates, st.mediaSettings?.assetExtractTplId, st.mediaSettings?.imageAspect);
	const r = buildAssetBaseGenSpec(cat, asset, modelKey, imageResolutionOptions(catalog.model(modelKey)), { aspect });
	if ("error" in r) { alert(r.error); return false; }
	startGeneration(r.spec);
	return true;
}
