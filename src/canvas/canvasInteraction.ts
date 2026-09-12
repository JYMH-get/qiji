import type { CanvasGroup, CanvasNode } from "@/types";

export type CanvasMediaKind = "image" | "video" | "audio";

export interface CanvasMediaRef {
	id?: string;
	assetId?: string;
	url: string;
	name: string;
	media: CanvasMediaKind;
}

type LibraryAssetLike = {
	id: string;
	kind: string;
	name?: string;
	uri?: string;
	serverAssetId?: string | null;
};

export function mediaKindFromMime(mime?: string | null): CanvasMediaKind | null {
	if (mime?.startsWith("image/")) return "image";
	if (mime?.startsWith("video/")) return "video";
	if (mime?.startsWith("audio/")) return "audio";
	return null;
}

/** 画布参考素材资格只看实际媒体格式；id 只是有则携带的映射信息。 */
export function resolveCanvasMediaRef(
	node: CanvasNode,
	asset: LibraryAssetLike | null | undefined,
	displayKind?: string | null,
): CanvasMediaRef | null {
	const assetMedia = asset && (asset.kind === "image" || asset.kind === "video" || asset.kind === "audio")
		? asset.kind
		: null;
	const fileMedia = mediaKindFromMime(node.data.fileMime);
	const displayMedia = displayKind === "image" || displayKind === "video" || displayKind === "audio"
		? displayKind
		: null;
	const media = assetMedia || fileMedia || displayMedia;
	const url = asset?.uri || node.data.fileUri || "";
	if (!media || !url) return null;
	return {
		id: asset?.serverAssetId || asset?.id || undefined,
		url,
		name: asset?.name || node.data.fileName || String(node.data.title || "画布素材"),
		media,
	};
}

export function isCanvasMediaAlreadyAdded(
	ref: CanvasMediaRef,
	materials: Array<{ id?: string; url?: string; uri?: string }>,
): boolean {
	return materials.some((it) =>
		(!!ref.id && it.id === ref.id) ||
		(!!ref.url && (it.url === ref.url || it.uri === ref.url)),
	);
}

export function orderedMaterialGroupIds(
	groups: Record<string, CanvasGroup>,
	nodes: Record<string, CanvasNode>,
): string[] {
	return Object.values(groups)
		.filter((g) => g.kind === "material" && !!nodes[g.id])
		.sort((a, b) => {
			const an = nodes[a.id];
			const bn = nodes[b.id];
			return an.y - bn.y || an.x - bn.x || a.id.localeCompare(b.id);
		})
		.map((g) => g.id);
}

export function nextMaterialGroupId(
	currentId: string | null,
	groups: Record<string, CanvasGroup>,
	nodes: Record<string, CanvasNode>,
): string | null {
	const ids = orderedMaterialGroupIds(groups, nodes);
	if (!ids.length) return null;
	const index = currentId ? ids.indexOf(currentId) : -1;
	return ids[(index + 1 + ids.length) % ids.length];
}
