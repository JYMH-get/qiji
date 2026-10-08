export interface WorkbenchSegmentLike {
	kind: string;
	shotRef?: unknown;
}

/** 工作台临时选中优先只属于当前会话/编辑层，不进入剪辑文档。 */
export interface WorkbenchFocusScope {
	ownerProjectId: string | null;
	ownerEpisodeKey: string | null;
	editingSubDocId: string | null;
}

export interface WorkbenchSelectionFocus extends WorkbenchFocusScope {
	segId: string;
	playheadUs: number;
	revision: number;
	/** 同一次同步选中→定位可重锚一次；事件结束后关闭。 */
	allowImmediateSeek: boolean;
}

export function workbenchFocusMatches(
	focus: WorkbenchSelectionFocus | null | undefined,
	scope: WorkbenchFocusScope & { selection: string[]; playheadUs: number },
): boolean {
	return !!focus && scope.selection.includes(focus.segId) && focus.playheadUs === scope.playheadUs
		&& focus.ownerProjectId === scope.ownerProjectId && focus.ownerEpisodeKey === scope.ownerEpisodeKey
		&& focus.editingSubDocId === scope.editingSubDocId;
}

/** 编辑多选集合和当前工作台焦点分开；点组内第 N 段不把整组重排。 */
export function workbenchSelectedId(scope: WorkbenchFocusScope & {
	selection: string[]; playheadUs: number; workbenchFocus?: WorkbenchSelectionFocus | null;
}): string | undefined {
	return workbenchFocusMatches(scope.workbenchFocus, scope) ? scope.workbenchFocus!.segId : scope.selection[0];
}

/** 播放/寻址移动后恢复跟随主轨；列表双击的同步定位仍保留刚选中的上层片段。 */
export function focusAfterPlayhead(
	focus: WorkbenchSelectionFocus | null | undefined,
	scope: WorkbenchFocusScope & { selection: string[]; playheadUs: number },
	nextUs: number,
	selected: { targetStartUs: number; targetDurationUs: number } | null,
): WorkbenchSelectionFocus | null {
	if (!workbenchFocusMatches(focus, scope)) return null;
	if (nextUs === scope.playheadUs) return focus!;
	if (focus!.allowImmediateSeek && selected && nextUs >= selected.targetStartUs
		&& nextUs < selected.targetStartUs + selected.targetDurationUs) {
		return { ...focus!, playheadUs: nextUs, allowImmediateSeek: false };
	}
	return null;
}

/** 占位符=待生成坑位；带 shotRef 的成片=可回到同一分镜继续编辑。 */
export function workbenchEditable(seg: WorkbenchSegmentLike): boolean {
	return seg.kind === "placeholder" || !!seg.shotRef;
}

/**
 * 新选中可临时接管工作台；临时优先结束后，播放头下存在可编辑分镜时跟随播放头。
 * 播放头处为空白/纯素材时，保留显式选中作为编辑兜底。
 */
export function chooseWorkbenchSegment<T extends WorkbenchSegmentLike>(
	selected: T | null,
	playhead: T | null,
	preferSelection = false,
): T | null {
	if (preferSelection && selected) return workbenchEditable(selected) ? selected : null;
	if (playhead && workbenchEditable(playhead)) return playhead;
	if (selected && workbenchEditable(selected)) return selected;
	return null;
}
