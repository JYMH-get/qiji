/**
 * projectAssets —— 汇总「当前项目全部资产」（角色/群像/场景/生物/物品，含变体），供提示词框输入 # 时的
 * 「导入并引用」待选框使用。只收录**已生成主图**（有 image uri）的资产/变体——引用需要缩略图。
 * 返回同时带 entity assetId（分镜素材用）与 blobId/publicUrl（画布节点素材用）。
 */
import { useProjectStore } from "@/store/projectStore";

export interface ProjectAssetCandidate {
	assetId: string;   // 资产/变体实体 id（分镜素材 material.assetId 用）
	blobId?: string;   // 二进制资产 id（画布节点 input 用）
	url?: string;      // 公网直链（画布节点请求用）
	name: string;
	uri: string;       // 展示 uri（asset:// 本地优先）
	media: "image";
	kind: "character" | "scene" | "creature" | "prop";
	label?: string;    // 变体徽标（基础形象为空）
}

const KIND_CN: Record<ProjectAssetCandidate["kind"], string> = {
	character: "角色", scene: "场景", creature: "生物", prop: "物品",
};
export function kindLabel(k: ProjectAssetCandidate["kind"]): string { return KIND_CN[k]; }

/** 素材反查命中的项目资产（第114轮补：绑定图/出图写回的图以资产身份进图例与音色配对） */
export interface BoundAssetHit {
	/** 基础资产实体 id（音色「声音参考」配对按它） */
	assetId: string;
	/** 展示名：基础图/历史图命中用资产名，变体图命中用造型名 */
	name: string;
	voiceUri?: string;
	voiceAssetId?: string;
	voiceName?: string;
}

/**
 * 反查：某素材（显示 uri / 二进制资产 id）是否是项目资产的图（主图/历史/变体图均认——
 * 绑定后即使换了主图，历史里的这张图仍属于该资产）。
 * 比对两条腿：uri 直等，或双方经 blobByUri 归一到同一个二进制资产 id。
 * 用途：上游连线/拖拽/粘贴进来的素材不是靠名字匹配的——命中则图例写「@ImageN 是 资产名」
 * 并带出该资产绑定的音色（「匹配资产」把声音参考一并加入）。
 */
export function findProjectAssetByImage(uri?: string, blobId?: string): BoundAssetHit | null {
	if (!uri && !blobId) return null;
	const s = useProjectStore.getState();
	const idOf = (u?: string): string | undefined => (u ? s.blobByUri(u)?.id : undefined);
	const probeId = blobId || idOf(uri);
	const eq = (img?: string): boolean =>
		!!img && ((!!uri && img === uri) || (!!probeId && idOf(img) === probeId));
	const hit = (a: any, name: string): BoundAssetHit => ({
		assetId: a.id, name, voiceUri: a.voiceUri, voiceAssetId: a.voiceAssetId, voiceName: a.voiceName,
	});
	const scan = (a: any): BoundAssetHit | null => {
		if (eq(a.image) || (a.images || []).some((u: string) => eq(u))) return hit(a, a.name);
		for (const v of a.variants || []) if (eq(v.image)) return hit(a, v.name || a.name);
		return null;
	};
	for (const arr of [s.characters, s.crowds, s.scenes, s.organisms, s.items]) {
		for (const a of arr as any[]) {
			const h = scan(a);
			if (h) return h;
		}
	}
	return null;
}

export function getProjectAssetCandidates(): ProjectAssetCandidate[] {
	const s = useProjectStore.getState();
	const out: ProjectAssetCandidate[] = [];
	const push = (kind: ProjectAssetCandidate["kind"], a: any) => {
		if (a.image) {
			const b = s.blobByUri(a.image);
			out.push({ assetId: a.id, blobId: b?.id, url: b?.url, name: a.name, uri: a.image, media: "image", kind });
		}
		for (const v of (a.variants || [])) {
			if (!v.image) continue;
			const b = s.blobByUri(v.image);
			out.push({ assetId: v.id || `${a.id}:${v.label}`, blobId: b?.id, url: b?.url, name: v.name || a.name, uri: v.image, media: "image", kind, label: v.label });
		}
	};
	for (const c of s.characters) push("character", c);
	for (const g of s.crowds) push("character", g);
	for (const sc of s.scenes) push("scene", sc);
	for (const o of s.organisms) push("creature", o);
	for (const i of s.items) push("prop", i);
	return out.filter((x) => x.uri);
}
