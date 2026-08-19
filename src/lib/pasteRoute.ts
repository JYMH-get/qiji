/**
 * pasteRoute —— 画布 Ctrl+V 粘贴内容分流的纯判定（第113轮）。
 *
 * 三路：internal=内部节点克隆粘贴；files=系统剪贴板媒体文件→导入建节点；text=纯文字→文本节点。
 * 内部优先判据（有内部剪贴板节点时任一命中）：
 *  - 系统剪贴板文本 == NODE_COPY_MARKER（节点复制时写入系统剪贴板的标记）；
 *  - 系统剪贴板为空（无文件无文字）；
 *  - 「复制节点后从未离开过本窗口」（copiedAt > blurAt）——标记写入失败（权限/焦点）时的兜底：
 *    没离开过窗口就不可能从外部复制到新内容，系统剪贴板里是陈旧外部内容。
 */
export const NODE_COPY_MARKER = "[Qiji画布节点·请在画布内 Ctrl+V 粘贴]";

export function pasteRoute(input: {
	/** 系统剪贴板 text/plain */
	text: string;
	/** 系统剪贴板媒体文件数 */
	fileCount: number;
	/** 内部节点剪贴板是否有内容 */
	hasInternalNodes: boolean;
	/** 最近一次内部节点复制时间（0=从未） */
	copiedAt: number;
	/** 最近一次窗口失焦时间（0=从未失焦） */
	blurAt: number;
}): "internal" | "files" | "text" | "none" {
	const { text, fileCount, hasInternalNodes, copiedAt, blurAt } = input;
	const preferInternal =
		hasInternalNodes &&
		(text === NODE_COPY_MARKER || (fileCount === 0 && !text.trim()) || (copiedAt > 0 && copiedAt > blurAt));
	if (preferInternal) return "internal";
	if (fileCount > 0) return "files";
	if (text.trim()) return "text";
	return "none";
}
