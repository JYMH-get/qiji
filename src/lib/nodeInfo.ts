import type { AssetBlob } from "@/services/projectFile";
import type { CanvasNode, NodeRuntime } from "@/types";
import { isWebviewLocalUri } from "@/lib/publicUrl";

export interface NodeInfoAsset {
	id: string;
	uri: string;
	serverAssetId?: string | null;
	localPath?: string | null;
}

export interface NodeInfoSnapshot {
	typeLabel: string;
	status: {
		kind: "node" | "running" | "result" | "failed";
		label: string;
		progress: number | null;
	};
	currentResult: {
		assetId: string;
		remoteUrl: string;
		localPath: string;
	} | null;
	modelLabel: string;
	aspect: string;
	duration: string;
	prompt: string;
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function resultIdsOf(node: CanvasNode): string[] {
	const ids = [
		...(node.data.shotAssets ?? []),
		...(node.data.resultHistory ?? []),
		...(node.data.resultAssetId ? [node.data.resultAssetId] : []),
	].filter(Boolean);
	return [...new Set(ids)];
}

function activeResultIdOf(node: CanvasNode): string {
	const shots = node.data.shotAssets ?? [];
	return node.data.resultAssetId ?? shots[shots.length - 1] ?? "";
}

export function buildNodeInfoSnapshot(args: {
	node: CanvasNode;
	runtime?: NodeRuntime | null;
	typeLabel: string;
	modelLabel?: string;
	assets: Record<string, NodeInfoAsset | undefined>;
	assetBlobs: Record<string, AssetBlob | undefined>;
}): NodeInfoSnapshot {
	const { node, runtime, assets, assetBlobs } = args;
	const params = node.data.params ?? {};
	const resultIds = resultIdsOf(node);
	const resultCount = resultIds.length || (text(node.data.resultText) ? 1 : 0);
	const runtimeStatus = runtime?.status ?? "idle";
	const running = runtimeStatus === "uploading"
		|| runtimeStatus === "queued"
		|| runtimeStatus === "scheduled"
		|| runtimeStatus === "running";
	const status: NodeInfoSnapshot["status"] = running
		? { kind: "running", label: "生成中", progress: Math.max(0, Math.min(100, Math.round(runtime?.progress ?? 0))) }
		: runtimeStatus === "failed"
			? { kind: "failed", label: "失败", progress: null }
			: resultCount > 0
				? { kind: "result", label: `结果 ×${resultCount}`, progress: null }
				: { kind: "node", label: "节点", progress: null };

	const resultId = activeResultIdOf(node);
	const resultMeta = resultId ? node.data.resultMetaByAssetId?.[resultId] : undefined;
	const asset = resultId ? assets[resultId] : undefined;
	const serverId = asset?.serverAssetId || resultId;
	const blob = (serverId && assetBlobs[serverId])
		|| (resultId && assetBlobs[resultId])
		|| (asset?.uri
			? Object.values(assetBlobs).find((b) => b && [b.localUri, b.localPath, b.url, b.srcUri, ...(b.pastUrls ?? [])].includes(asset.uri))
			: undefined);
	const remoteFromAsset = asset?.uri && /^https?:/i.test(asset.uri) && !isWebviewLocalUri(asset.uri)
		? asset.uri
		: "";
	const currentResult = resultId ? {
		assetId: blob?.id || serverId || resultId,
		remoteUrl: blob?.url || remoteFromAsset,
		localPath: blob?.localPath || asset?.localPath || "",
	} : null;

	const aspectRaw = text(resultMeta?.aspect ?? params.aspect_ratio ?? params.aspect ?? params.ratio);
	const durationRaw = resultMeta?.duration ?? params.duration ?? params.durationSec;
	const durationNum = Number(durationRaw);

	return {
		typeLabel: args.typeLabel || node.type,
		status,
		currentResult,
		modelLabel: args.modelLabel || text(params.model) || "",
		aspect: aspectRaw.replace(/:/g, "："),
		duration: Number.isFinite(durationNum) && durationNum > 0 ? `${durationNum}s` : "",
		prompt: text(resultMeta?.prompt ?? params.prompt ?? params.composerContent ?? params.content),
	};
}
