/**
 * shotMaterialOps —— 分镜素材的增删（读最新 store，避免闭包过期），供视频界面与提示词放大弹窗共用。
 * 上传走 OSS（TP 临时资产）+ 本地副本显示；删除按 id 过滤。
 */
import { useProjectStore } from "@/store/projectStore";
import { uploadMediaToCanvasAsset } from "@/canvas/nodeUpload";
import { useUploadStore, uploadKeys } from "@/store/uploadStore";
import { mediaFromMime, materialTags, mediaOf, buildLegend, applyLegend, remapBodyTags, LEGEND_START, type MediaKind } from "./shotMaterials";
import type { ShotMaterial, StoryboardShot } from "@/services/projectFile";
import type { ProjectAssetCandidate } from "./projectAssets";

function liveShot(epId: string, shotId: string) {
	const ep = useProjectStore.getState().episodes.find((e) => e.id === epId);
	return ep?.shots.find((s) => s.id === shotId);
}

/**
 * 按当前 materials 同步分镜图例前缀（与画布模式一致，杜绝删素材后「是xxx」残留）：
 *  按项目模式把图例写进当前生效的提示词——图视同源=unifiedPrompt（含声音配对，该提示词同时喂图片与视频）、
 *  双结果=videoPrompt 全模态 + storyboardPrompt 仅图像；非当前模式的提示词不新增图例，但**已有图例仍随素材重建**
 *  （模式来回切换不留陈旧编号）；removed 给出被删素材的 media+全局@号时，三份提示词的正文内联 @ 引用一并重编号。
 * shot.materials 传**更新后**的素材集；各提示词传旧值（applyLegend 会逐条合并，保留用户改过的说明）。
 */
function syncShotLegend(shot: StoryboardShot, removed?: { media: MediaKind; n: number }): Partial<StoryboardShot> {
	const sameSource = !!useProjectStore.getState().mediaSettings?.imgVideoSameSource;
	const vp = shot.videoPrompt || "", sp = shot.storyboardPrompt || "", up = shot.unifiedPrompt || "";
	// 当前模式的提示词：添加=始终补/更新图例，删除=仅当已有图例才重建；非当前模式：已有图例才跟随重建
	const legFor = (text: string, active: boolean, imagesOnly: boolean): string =>
		(active ? !removed || text.includes(LEGEND_START) : text.includes(LEGEND_START))
			? buildLegend(shot.materials, imagesOnly)
			: "";
	const patch: Partial<StoryboardShot> = {
		videoPrompt: applyLegend(vp, legFor(vp, !sameSource, false), removed),
		storyboardPrompt: applyLegend(sp, legFor(sp, !sameSource, true), removed),
	};
	// unifiedPrompt 只在同源模式或本就有内容时写回（双结果项目不凭空多出空字段）
	if (sameSource || up) patch.unifiedPrompt = applyLegend(up, legFor(up, sameSource, false), removed);
	return patch;
}

/**
 * 按最新素材集刷新某分镜的图例前缀（素材已由调用方写入 store 的路径复用，如上传占位加入后）。
 * removed 语义同 syncShotLegend。
 */
export function resyncShotLegend(epId: string, shotId: string, removed?: { media: MediaKind; n: number }): void {
	const sh = liveShot(epId, shotId);
	if (!sh) return;
	useProjectStore.getState().updateShot(epId, shotId, syncShotLegend(sh, removed));
}

/**
 * 拖拽重排素材：素材顺序=@ 编号顺序——重排后图例整体重建 + 三份提示词的正文内联 @ 引用按新旧编号重映射。
 * ⚠ 任何改变素材顺序的路径都必须走这里（只写 materials 数组会让图例/正文编号与素材区错位——
 * 「(孟金珠) 是 贺长安」一类图例错位的直接根源，勿回退成裸 update）。
 */
export function reorderShotMaterial(epId: string, shotId: string, fromId: string, toId: string): void {
	const sh = liveShot(epId, shotId);
	if (!sh || fromId === toId) return;
	const arr = [...sh.materials];
	const fi = arr.findIndex((m) => m.id === fromId);
	const ti = arr.findIndex((m) => m.id === toId);
	if (fi < 0 || ti < 0) return;
	const [moved] = arr.splice(fi, 1);
	const insertAt = arr.findIndex((m) => m.id === toId);
	arr.splice(fi < ti ? insertAt + 1 : insertAt, 0, moved);
	// 正文内联 @ 引用重映射（旧编号→新编号）；图例块随后由 syncShotLegend 按新素材整体重建
	const oldTags = materialTags(sh.materials);
	const newTags = materialTags(arr);
	const mapping: Record<string, string> = {};
	for (const m of arr) {
		const o = oldTags[m.id], n = newTags[m.id];
		if (o && n && o !== n) mapping[o] = n;
	}
	const remapped: StoryboardShot = {
		...sh,
		materials: arr,
		videoPrompt: remapBodyTags(sh.videoPrompt || "", mapping),
		storyboardPrompt: remapBodyTags(sh.storyboardPrompt || "", mapping),
		unifiedPrompt: remapBodyTags(sh.unifiedPrompt || "", mapping),
	};
	useProjectStore.getState().updateShot(epId, shotId, {
		materials: arr,
		videoPrompt: remapped.videoPrompt,
		storyboardPrompt: remapped.storyboardPrompt,
		...(remapped.unifiedPrompt || sh.unifiedPrompt !== undefined ? { unifiedPrompt: remapped.unifiedPrompt } : {}),
		...syncShotLegend(remapped),
	});
}

/** 删除某分镜的一条素材，并同步重建图例（+重编号正文 @ 引用） */
export function removeShotMaterial(epId: string, shotId: string, matId: string): void {
	const sh = liveShot(epId, shotId);
	if (!sh) return;
	// 被删素材的媒体类型 + 全局 @ 号（删前算，供正文 @ 引用重编号）
	const tag = materialTags(sh.materials)[matId];
	const delMat = sh.materials.find((m) => m.id === matId);
	const mNum = tag ? Number(/(\d+)$/.exec(tag)?.[1] ?? 0) : 0;
	const removed = delMat && mNum > 0 ? { media: mediaOf(delMat), n: mNum } : undefined;
	const newMaterials = sh.materials.filter((m) => m.id !== matId);
	useProjectStore.getState().updateShot(epId, shotId, { materials: newMaterials, ...syncShotLegend({ ...sh, materials: newMaterials }, removed) });
}

/** 从资产（资产助手/本地素材库/跨分镜复制）加一条垫图到分镜素材（去重：同 assetId/uri 不重复）。 */
export function addShotMaterialFromAsset(
	epId: string,
	shotId: string,
	a: { assetId?: string; uri: string; name?: string; media?: MediaKind; kind?: ShotMaterial["kind"]; voiceForAssetId?: string },
): void {
	const sh = liveShot(epId, shotId);
	if (!sh || !a.uri) return;
	if (sh.materials.some((m) => (a.assetId && m.assetId === a.assetId) || (a.uri && m.uri === a.uri))) return;
	const newMaterials = [...sh.materials, { id: `mat-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, assetId: a.assetId, kind: a.kind || "local", media: a.media || "image", name: a.name || "", uri: a.uri, ...(a.voiceForAssetId ? { voiceForAssetId: a.voiceForAssetId } : {}) } as ShotMaterial];
	useProjectStore.getState().updateShot(epId, shotId, { materials: newMaterials, ...syncShotLegend({ ...sh, materials: newMaterials }) });
}

/**
 * 输入 # 导入：把项目资产加入分镜素材区并返回其 @tag + 素材数据（供提示词框立即插入胶囊）。
 * 已在本镜则复用（不重复加），返回既有 tag。找不到返回 null。
 */
export function importAssetToShot(epId: string, shotId: string, cand: ProjectAssetCandidate): { tag: string; mat: ShotMaterial } | null {
	addShotMaterialFromAsset(epId, shotId, { assetId: cand.assetId, uri: cand.uri, name: cand.name, media: "image" });
	const sh = liveShot(epId, shotId);
	if (!sh) return null;
	const m = sh.materials.find((x) => (cand.assetId && x.assetId === cand.assetId) || x.uri === cand.uri);
	if (!m) return null;
	const tag = materialTags(sh.materials)[m.id];
	if (!tag) return null;
	return { tag, mat: { id: m.id, kind: m.kind ?? "local", media: "image", name: m.name, uri: m.uri, assetId: m.assetId } as ShotMaterial };
}

/**
 * 上传本地文件为分镜素材（原图 → OSS + 本地副本显示）。
 * 去重：① 上传按内容 sha256 去重（相同文件复用同一资产，uploadMediaToCanvasAsset）；
 *       ② 加入前按 assetId/uri 查重——相同资产不重复加入本镜。
 */
export async function addLocalShotMaterials(epId: string, shotId: string, files: File[]): Promise<void> {
	const key = uploadKeys.shot(epId, shotId);
	for (const file of files) {
		const media = mediaFromMime(file.type || "");
		let up: { assetId: string; displayUri: string };
		useUploadStore.getState().begin(key); // 素材条显示占位符+转圈
		try {
			up = await uploadMediaToCanvasAsset(file, "TP"); // 内含 sha256 去重
		} catch (e) {
			console.warn("[shotMaterialOps] 素材上传失败：", e);
			continue;
		} finally {
			useUploadStore.getState().end(key);
		}
		const cur = liveShot(epId, shotId);
		if (!cur) return;
		// 去重：同一资产（同 assetId 或同 uri）已在本镜 → 跳过
		if (cur.materials.some((m) => (up.assetId && m.assetId === up.assetId) || (up.displayUri && m.uri === up.displayUri))) continue;
		const newMaterials = [...cur.materials, { id: `mat-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, assetId: up.assetId, kind: "local", media, name: file.name.replace(/\.[^.]+$/, ""), uri: up.displayUri } as ShotMaterial];
		useProjectStore.getState().updateShot(epId, shotId, { materials: newMaterials, ...syncShotLegend({ ...cur, materials: newMaterials }) });
	}
}
