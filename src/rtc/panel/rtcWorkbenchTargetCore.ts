export interface WorkbenchSegmentLike {
	kind: string;
	shotRef?: unknown;
}

/** 占位符=待生成坑位；带 shotRef 的成片=可回到同一分镜继续编辑。 */
export function workbenchEditable(seg: WorkbenchSegmentLike): boolean {
	return seg.kind === "placeholder" || !!seg.shotRef;
}

/**
 * 工作台以当前时间为准：播放头下存在可编辑分镜时必须跟随播放头。
 * 只有播放头处为空白/纯素材时，才保留显式选中作为编辑兜底。
 */
export function chooseWorkbenchSegment<T extends WorkbenchSegmentLike>(
	selected: T | null,
	playhead: T | null,
): T | null {
	if (playhead && workbenchEditable(playhead)) return playhead;
	if (selected && workbenchEditable(selected)) return selected;
	return null;
}
