/**
 * shotMatchActions —— 实时剪辑分镜工作台的「匹配资产」（=资产模式 Frame161195「提取资产」的属性化版）。
 *
 * 链路（与 Frame161195.matchAssets 同尺）：
 *   扫 原文分段 + 故事板/视频/同源提示词（提示词先 stripLegendForMatch 剥「【素材图例】」防自我循环）
 *   → matchAssetsInText（assetMatch 同一把尺：名称/别名/造型名命中；**用图=原文点名造型 >
 *     assetFormStore 选中造型 > 基础形象**，第78轮语义在 matchAssetsInText 内部实现）
 *   → 逐个 addShotMaterialFromAsset（shotMaterialOps 统一入口：去重 + 图例/@ 编号自动重建，第142轮红线）
 *   → 角色带音色的自动加声音素材（voiceForAssetId 标记 → 图例配对「@ImageN的声音参考@AudioM」，第86轮）。
 *
 * 提示词放大弹窗的「匹配资产」按第108轮规则**委托本实现**（onMatchAssets 宿主委托，
 * 绝不在 PromptModal 内重写匹配）——draftOv 以弹窗草稿代替该栏已存提示词参与匹配与图例写入。
 *
 * 纯逻辑（composeShotMatchText / planShotMatch）与 store 编排（matchShotAssets）分层，纯逻辑可单测。
 */
import { useProjectStore } from "@/store/projectStore";
import { matchAssetsInText, stripLegendForMatch, type MatchedAsset } from "@/lib/assetMatch";
import { addShotMaterialFromAsset, resyncShotLegend } from "@/lib/shotMaterialOps";
import type { ShotMaterial, StoryboardShot } from "@/services/projectFile";

/** 可作匹配草稿覆盖的提示词栏位 */
export type ShotPromptFieldKey = "storyboardPrompt" | "videoPrompt" | "unifiedPrompt";

/** MatchedAsset.kind → ShotMaterial.kind（群像与 Frame161195 同尺归入 character；无 crowd 枚举） */
export const MATCH_KIND_TO_MATERIAL: Record<MatchedAsset["kind"], ShotMaterial["kind"]> = {
	character: "character",
	crowd: "character",
	scene: "scene",
	creature: "creature",
	prop: "prop",
};

/**
 * 组装参与匹配的文本（与 Frame161195.matchAssets 同源）：
 * 原文分段 + 三份提示词（剥图例）+ 旧字段 prompt；draftOv 覆盖对应栏位（弹窗草稿优先）。
 */
export function composeShotMatchText(
	shot: Pick<StoryboardShot, "scriptSegment" | "storyboardPrompt" | "videoPrompt" | "unifiedPrompt" | "prompt">,
	draftOv?: { field: ShotPromptFieldKey; text: string },
): string {
	const sb = draftOv?.field === "storyboardPrompt" ? draftOv.text : (shot.storyboardPrompt || "");
	const vd = draftOv?.field === "videoPrompt" ? draftOv.text : (shot.videoPrompt || "");
	const uni = draftOv?.field === "unifiedPrompt" ? draftOv.text : (shot.unifiedPrompt || "");
	return [
		shot.scriptSegment,
		stripLegendForMatch(sb),
		stripLegendForMatch(vd),
		stripLegendForMatch(uni),
		shot.prompt,
	].filter(Boolean).join("\n");
}

/** 单条待加入素材规格（喂 addShotMaterialFromAsset） */
export interface PlannedMaterialAdd {
	assetId?: string;
	uri: string;
	name: string;
	media: "image" | "audio";
	kind: ShotMaterial["kind"];
	voiceForAssetId?: string;
}

/**
 * 由命中资产规划「要加入的素材」与「空 uri 回填」（纯函数）：
 *  - 有图命中 → 图片素材（addShotMaterialFromAsset 会按 assetId/uri 去重，已在素材区的不重复添加）；
 *  - ⚠ 无图资产不推图片素材（空 uri 占 @ 编号=编号错位红线），但其绑定音色仍加（与 Frame161195 同尺）；
 *  - 带音色 → 声音参考音频素材（voiceForAssetId=角色资产 id，图例自动配对）；已有同源音频不重复；
 *  - backfill：素材区里同 assetId 的**空 uri**旧素材（此前无图时提取进来的）→ 资产出图后回填新图，
 *    不再永久空占编号（Frame161195 同款语义）。
 */
export function planShotMatch(
	existing: ShotMaterial[],
	matched: MatchedAsset[],
): { adds: PlannedMaterialAdd[]; backfills: Array<{ matId: string; uri: string }> } {
	const adds: PlannedMaterialAdd[] = [];
	const backfills: Array<{ matId: string; uri: string }> = [];
	const hasExisting = (assetId?: string, uri?: string) =>
		existing.some((m) => (!!assetId && m.assetId === assetId) || (!!uri && m.uri === uri));
	const hasPlanned = (assetId?: string, uri?: string) =>
		adds.some((a) => (!!assetId && a.assetId === assetId) || (!!uri && a.uri === uri));
	for (const m of matched) {
		if (m.image) {
			const empty = existing.find((x) => !!m.assetId && x.assetId === m.assetId && !x.uri);
			if (empty) {
				backfills.push({ matId: empty.id, uri: m.image });
			} else if (!hasExisting(m.assetId, m.image) && !hasPlanned(m.assetId, m.image)) {
				adds.push({ assetId: m.assetId, uri: m.image, name: m.name, media: "image", kind: MATCH_KIND_TO_MATERIAL[m.kind] });
			}
		}
		// 音色独立于图片判重（第86轮教训：图已在素材区不能短路音色）
		if (m.voiceUri && !hasExisting(m.voiceAssetId, m.voiceUri) && !hasPlanned(m.voiceAssetId, m.voiceUri)) {
			adds.push({
				assetId: m.voiceAssetId, uri: m.voiceUri, name: m.voiceName || `${m.name}的声音`,
				media: "audio", kind: "local", voiceForAssetId: m.assetId,
			});
		}
	}
	return { adds, backfills };
}

function liveShot(epId: string, shotId: string): StoryboardShot | undefined {
	return useProjectStore.getState().episodes.find((e) => e.id === epId)?.shots.find((s) => s.id === shotId);
}

/**
 * 对一个分镜执行「匹配资产」（工作台按钮与放大弹窗 onMatchAssets 共用的宿主实现）。
 * draftOv：以弹窗草稿代替该栏已存提示词（匹配范围与图例落点都用草稿——草稿先写回 store，
 * 图例经 shotMaterialOps 在其上重建；弹窗保存时再落一次同值幂等，与 Frame161195 同语义）。
 * 返回 { prompt: 该栏更新后的提示词, added: 新增素材数 }；无资产可匹配且素材区为空 → null。
 */
export function matchShotAssets(
	episodeId: string,
	shotId: string,
	draftOv?: { field: ShotPromptFieldKey; text: string },
): { prompt: string; added: number } | null {
	const shot = liveShot(episodeId, shotId);
	if (!shot) return null;
	const matched = matchAssetsInText(composeShotMatchText(shot, draftOv));
	if (matched.length === 0 && shot.materials.length === 0) return null; // 无命中且无现有素材=无图例可生成
	const st = useProjectStore.getState();
	// 弹窗草稿先写回该栏（图例将基于草稿正文重建；保存时同值幂等）
	if (draftOv) st.updateShot(episodeId, shotId, { [draftOv.field]: draftOv.text });
	const before = liveShot(episodeId, shotId);
	if (!before) return null;
	const { adds, backfills } = planShotMatch(before.materials, matched);
	// 空 uri 旧素材回填新图（集合/顺序不变，仅补 uri；图例随后统一重建）
	if (backfills.length) {
		const cur = liveShot(episodeId, shotId);
		if (cur) {
			const byId = new Map(backfills.map((b) => [b.matId, b.uri]));
			st.updateShot(episodeId, shotId, {
				materials: cur.materials.map((m) => (byId.has(m.id) && !m.uri ? { ...m, uri: byId.get(m.id)! } : m)),
			});
		}
	}
	const beforeCount = before.materials.length;
	// 逐个走统一入口（第142轮红线：素材集合变更必须经带图例重建的 shotMaterialOps）
	for (const a of adds) addShotMaterialFromAsset(episodeId, shotId, a);
	// 收尾统一刷新图例（覆盖「零新增但需补写/刷新图例」与回填路径；增补路径已各自重建，幂等）
	resyncShotLegend(episodeId, shotId);
	const after = liveShot(episodeId, shotId);
	if (!after) return null;
	const field: ShotPromptFieldKey = draftOv?.field
		?? (useProjectStore.getState().mediaSettings?.imgVideoSameSource ? "unifiedPrompt" : "videoPrompt");
	return { prompt: after[field] || "", added: Math.max(0, after.materials.length - beforeCount) };
}
