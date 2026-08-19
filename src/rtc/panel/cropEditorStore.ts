/**
 * cropEditorStore —— 「打开画面裁剪编辑器」的跨组件请求通道（集成轮新增）。
 *
 * 裁剪编辑器（RtcCropEditor）挂在属性面板 RtcMediaProps 内（选中片段才存在）。键盘快捷键 C 与
 * 右键菜单「裁剪画面…」发生在时间轴侧，够不到面板的本地 open 态——经这里发一个「请为 segId 打开
 * 裁剪」的请求，RtcMediaProps 命中自己的片段即打开并清除请求。纯会话态，不落盘不进 undo。
 */
import { create } from "zustand";

interface CropEditorRequestState {
	/** 待打开裁剪编辑器的片段 id（null=无请求） */
	segId: string | null;
	request: (segId: string) => void;
	clear: () => void;
}

export const useCropEditorRequest = create<CropEditorRequestState>((set) => ({
	segId: null,
	request: (segId) => set({ segId }),
	clear: () => set({ segId: null }),
}));

/** 请求为某片段打开裁剪编辑器（调用方须先把该片段设为选中——面板只在选中时渲染） */
export function requestCropEditor(segId: string): void {
	useCropEditorRequest.getState().request(segId);
}
