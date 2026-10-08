import { useProjectStore } from "@/store/projectStore";
import { openLightboxGallery, type LightboxItem } from "@/store/lightboxStore";
import { usePromptModalStore, type PromptModalApi } from "@/store/promptModalStore";
import { reorderShotMaterial } from "./shotMaterialOps";
import { materialTags, mediaOf, remapBodyTags } from "./shotMaterials";

interface ShotMaterialLightboxOptions {
	/** 来源组件渲染时的项目身份；迟到双击不能打开另一项目的同 ID 分镜。 */
	owner?: string;
	/** 只影响排序，仍允许查看；每次拖动提交都重新校验。 */
	canReorder?: () => boolean;
	/** 放大编辑器的未保存草稿，排序只改其编号，不提前保存正文。 */
	promptApi?: PromptModalApi;
	promptSessionId?: number;
}

/** 分镜垫图只保留身份，不缓存素材数组；所有查看和排序读取同一份最新分镜。 */
export function createShotMaterialLightboxSource(episodeId: string, shotId: string, options: ShotMaterialLightboxOptions = {}): Parameters<typeof openLightboxGallery>[0] {
	const owner = options.owner ?? useProjectStore.getState().projectInstanceId;
	const promptSession = options.promptApi ? options.promptSessionId ?? usePromptModalStore.getState().sessionId : undefined;
	const promptCurrent = () => {
		const modal = usePromptModalStore.getState();
		return promptSession === undefined || (modal.open && modal.sessionId === promptSession);
	};
	const liveShot = () => {
		const state = useProjectStore.getState();
		if (state.projectInstanceId !== owner || state.isProjectLoading || !promptCurrent()) return null;
		return state.episodes.find(episode => episode.id === episodeId)?.shots.find(shot => shot.id === shotId) ?? null;
	};
	const canReorder = () => !!liveShot() && (options.canReorder?.() ?? true)
		&& (!options.promptApi || (!!options.promptApi.getValue && !!options.promptApi.setValue && !usePromptModalStore.getState().readOnly));
	return {
		getItems: () => {
			const shot = liveShot();
			if (!shot) return null;
			// 上传占位仍参与原始编号，但没有 URI 时不能成为可浏览的媒体。
			const tags = materialTags(shot.materials), seen = new Set<string>();
			return shot.materials.flatMap(material => {
				if (!material.id || !material.uri || seen.has(material.id)) return [];
				seen.add(material.id);
				const media = mediaOf(material);
				const label = tags[material.id].replace(/^@Image/, "图片").replace(/^@Video/, "视频").replace(/^@Audio/, "音频");
				return [{ id: material.id, uri: material.uri, name: material.name || "", media, label,
					...(media === "image" ? { thumbnailUri: material.uri } : {}),
				} satisfies LightboxItem];
			});
		},
		subscribe: listener => {
			const unsubscribeProject = useProjectStore.subscribe(listener);
			const unsubscribePrompt = options.promptApi ? usePromptModalStore.subscribe(listener) : undefined;
			return () => { unsubscribeProject(); unsubscribePrompt?.(); };
		},
		canReorder,
		reorder: (fromId, toId) => {
			if (!canReorder()) return;
			const shot = liveShot();
			if (!shot || fromId === toId) return;
			// 旧数据重复 ID 或已删除/尚未上传的目标不允许猜测重排对象。
			const source = shot.materials.filter(material => material.id === fromId);
			const target = shot.materials.filter(material => material.id === toId);
			if (source.length !== 1 || target.length !== 1 || !source[0].uri || !target[0].uri) return;
			const draft = options.promptApi?.getValue?.();
			const oldTags = materialTags(shot.materials);
			reorderShotMaterial(episodeId, shotId, fromId, toId);
			const after = liveShot();
			if (draft !== undefined && after && canReorder()) {
				const newTags = materialTags(after.materials);
				const mapping = Object.fromEntries(Object.entries(oldTags).filter(([id, tag]) => newTags[id] && newTags[id] !== tag).map(([id, tag]) => [tag, newTags[id]]));
				options.promptApi?.setValue?.(remapBodyTags(draft, mapping));
			}
		},
	};
}

export function openShotMaterialLightbox(episodeId: string, shotId: string, materialId: string, options?: ShotMaterialLightboxOptions): void {
	const source = createShotMaterialLightboxSource(episodeId, shotId, options);
	if (!source.getItems()?.some(item => item.id === materialId)) return;
	openLightboxGallery(source, materialId);
}
