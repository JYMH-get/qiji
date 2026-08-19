/**
 * compoundActions —— 复合片段的用户动作入口（第四批；⚠ 快捷键/右键菜单**尚未接线**，
 * 由时间轴交互批次收口：建议 Alt+G → createCompoundFromSelection、Alt+Shift+G →
 * dissolveSelectedCompound，右键菜单同名两项）。
 *
 * 与 rtcEditActions 同一约定：一次用户动作 = 一次 commit = 一条 undo；纯逻辑在
 * lib/rtcCompound，本文件只做「取状态 → 算 → 提交 → 收选中态」。
 */
import { genId } from "@/lib/id";
import { createCompound, dissolveCompound, nextCompoundName } from "@/lib/rtcCompound";
import { pruneEmptyTracks } from "@/lib/rtcOps";
import { useRtcStore } from "@/store/rtcStore";

export interface CompoundActionResult {
	ok: boolean;
	/** 失败原因（面向用户可直显；ok=true 时缺省） */
	reason?: string;
}

/**
 * 把当前选中的片段打包为复合片段（选中 ≥1 条 media，可跨轨）。
 * 成功后选中新的复合片段。拒绝：子层编辑中（嵌套深度 1）/ 空选区 / 选区含占位符或复合片段。
 */
export function createCompoundFromSelection(name?: string): CompoundActionResult {
	const st = useRtcStore.getState();
	if (!st.doc) return { ok: false, reason: "剪辑文档未载入" };
	if (st.editingSubDocId) return { ok: false, reason: "复合片段内不能再新建复合片段（先返回主时间轴）" };
	if (st.selection.length === 0) return { ok: false, reason: "先在时间轴选中要打包的素材片段" };
	// 预检选区形态（createCompound 对非法选区返回原引用，这里提前给出可读原因）
	const selected = new Set(st.selection);
	let found = 0;
	for (const t of st.doc.tracks) {
		for (const s of t.segments) {
			if (!selected.has(s.id)) continue;
			found++;
			if (s.kind === "placeholder") return { ok: false, reason: "选区里有未生成的占位符——先生成或移出选区" };
			if (s.kind === "compound") return { ok: false, reason: "复合片段不能再嵌进复合片段" };
		}
	}
	if (found !== selected.size) return { ok: false, reason: "选区已失效，请重新选择" };

	const segId = genId("seg");
	const subDocId = genId("sub");
	const finalName = name || nextCompoundName(st.doc);
	st.commit((d) => pruneEmptyTracks(createCompound(d, [...selected], { segId, subDocId, name: finalName }))); // 被并走的源轨空了就回收
	const created = useRtcStore
		.getState()
		.doc?.tracks.some((t) => t.segments.some((s) => s.id === segId));
	if (!created) return { ok: false, reason: "创建失败（选区不满足条件）" };
	useRtcStore.getState().setSelection([segId]);
	return { ok: true };
}

/**
 * 解除当前选中的复合片段（子时间轴片段平移回主时间轴，放不下就近落新轨）。
 * 多选时对选区里全部复合片段生效（一次 commit = 一条 undo）。
 */
export function dissolveSelectedCompound(): CompoundActionResult {
	const st = useRtcStore.getState();
	if (!st.doc) return { ok: false, reason: "剪辑文档未载入" };
	if (st.editingSubDocId) return { ok: false, reason: "先返回主时间轴再解除复合片段" };
	const ids: string[] = [];
	for (const t of st.doc.tracks) {
		for (const s of t.segments) {
			if (st.selection.includes(s.id) && s.kind === "compound") ids.push(s.id);
		}
	}
	if (ids.length === 0) return { ok: false, reason: "选中的不是复合片段" };
	st.commit((d) => {
		let next = d;
		for (const id of ids) next = dissolveCompound(next, id);
		return pruneEmptyTracks(next); // 复合段原轨空了就回收
	});
	useRtcStore.getState().setSelection([]);
	return { ok: true };
}

/** 进入选中的复合片段编辑（属性面板「进入编辑」与双击共用；未选复合片段 = no-op） */
export function enterSelectedCompound(): CompoundActionResult {
	const st = useRtcStore.getState();
	if (!st.doc) return { ok: false, reason: "剪辑文档未载入" };
	for (const t of st.doc.tracks) {
		for (const s of t.segments) {
			if (st.selection.includes(s.id) && s.kind === "compound" && s.subDocId) {
				st.enterCompound(s.subDocId);
				return { ok: true };
			}
		}
	}
	return { ok: false, reason: "选中的不是复合片段" };
}
