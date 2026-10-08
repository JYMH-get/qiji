import { useLibraryStore } from "@/store/libraryStore";
import { useProjectStore } from "@/store/projectStore";

/** Completed media belongs to its episode even after its timeline placement is deleted. */
export function registerRtcGeneratedAsset(args: {
	owner: string;
	episodeId: string;
	taskKey: string;
	media: "image" | "video" | "audio";
	uri: string;
	assetId?: string;
	name: string;
	createdAt?: number;
}): boolean {
	const project = useProjectStore.getState();
	if (project.projectInstanceId !== args.owner || project.isProjectLoading || !args.uri || !args.taskKey) return false;
	const library = useLibraryStore.getState();
	const id = `rtc-generated:${JSON.stringify([args.episodeId, args.taskKey])}`;
	// A replay must not duplicate the result or undo an explicit library deletion/rename.
	if (library.assets[id]) return true;
	const blob = (args.assetId ? project.assetBlobs[args.assetId] : undefined) ?? project.blobByUri(args.uri);
	library.addAsset({
		id, kind: args.media, name: args.name, uri: args.uri,
		thumbnailUri: args.media === "image" ? args.uri : null,
		createdAt: new Date(args.createdAt ?? Date.now()).toISOString(), deletedByUser: false,
		serverAssetId: args.assetId ?? blob?.id ?? null, localPath: blob?.localPath ?? null,
		origin: "generated", episodeId: args.episodeId || null,
	});
	project.markDirty();
	return true;
}
