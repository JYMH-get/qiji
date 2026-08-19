/**
 * rtcAssetSelStore —— 实时剪辑「选中的素材」跨面板共享态（左栏资产面板 ↔ 中栏预览 ↔ 右栏属性面板）。
 *
 * 两类选中，**互斥**（面板同一时刻只有一张卡处于选中态，中栏单一预览视口据此切换）：
 *  - selected：项目五类资产（角色/场景/生物/群像/道具），{ cat, id } 唯一定位 projectStore 资产
 *    （右栏资产属性视图数据源；中栏显示资产主图大图）；
 *  - mediaSel：项目「视频/音频」分类的媒体卡（中栏显示 video/audio 预览；右栏无编辑语义不进 selected）。
 *  收藏/共享/其他卡不进本 store。
 *
 * 右栏显示优先级（RtcPropertyPanel）：rtcStore.selection（时间轴片段）非空 → 片段视图优先；
 * 其次本 store 的资产视图；两边都空 → 引导提示。纯 UI 态，不落盘。
 *
 * 项目隔离：cat+id 只在其所属项目内有意义——模块级订阅 projectStore，projectInstanceId
 * 变化（新建/加载/导入项目）即清空选中，防旧项目的 cat+id 在新项目串显同位资产。
 */
import { create } from "zustand";
import { useProjectStore, type AssetCat } from "@/store/projectStore";

export interface RtcAssetSel {
	cat: AssetCat;
	id: string;
}

/** 媒体卡选中（素材页 视频/音频/图片/收藏/共享 各栏通用）：key=面板卡片稳定键（台账 id 优先，退 uri），
 *  高亮与再点取消判定用；media=image 时中栏显示图片大图预览 */
export interface RtcMediaSel {
	key: string;
	uri: string;
	media: "image" | "video" | "audio";
	name: string;
}

interface RtcAssetSelState {
	selected: RtcAssetSel | null;
	mediaSel: RtcMediaSel | null;
	select: (sel: RtcAssetSel) => void;
	/** 再点已选中的卡 = 取消选中；否则选中（并清媒体选中——两类互斥） */
	toggle: (sel: RtcAssetSel) => void;
	/** 媒体卡（视频/音频）：再点已选中 = 取消；否则选中（并清资产选中——两类互斥） */
	toggleMedia: (sel: RtcMediaSel) => void;
	clear: () => void;
}

export const useRtcAssetSelStore = create<RtcAssetSelState>((set, get) => ({
	selected: null,
	mediaSel: null,
	select: (sel) => set({ selected: sel, mediaSel: null }),
	toggle: (sel) => {
		const cur = get().selected;
		set({ selected: cur && cur.cat === sel.cat && cur.id === sel.id ? null : sel, mediaSel: null });
	},
	toggleMedia: (sel) => {
		const cur = get().mediaSel;
		set({ mediaSel: cur && cur.key === sel.key ? null : sel, selected: null });
	},
	clear: () => set({ selected: null, mediaSel: null }),
}));

/* 项目切换即清空（模块级订阅，随首次 import 常驻）：selected 的 cat+id 与 mediaSel 的
 * key/uri 都只在其所属项目内有意义，跨项目残留会串显/预览旧项目资产。 */
let prevInstanceId = useProjectStore.getState().projectInstanceId;
useProjectStore.subscribe((ps) => {
	if (ps.projectInstanceId === prevInstanceId) return;
	prevInstanceId = ps.projectInstanceId;
	const s = useRtcAssetSelStore.getState();
	if (s.selected || s.mediaSel) s.clear();
});
