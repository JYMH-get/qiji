/**
 * rtcEditActions —— 时间轴基础剪辑动作的**统一入口**（快捷键 / 工具条 / 右键菜单共用同一份实现）。
 *
 * ⚠ 数据变更红线：一切改 doc 的动作只走 `useRtcStore.getState().commitActive(mutator)`（编辑层感知：主层=commit 同义、子层写进子文档），
 *   **一次用户动作 = 一次 commit = 一条 undo**（剪切=复制+删除也只 commit 一次）；
 *   纯逻辑在 [rtcClipboardCore] 与 [@/lib/rtcOps]，本文件只做「取状态 → 算 → 提交 → 收选中态」。
 */
import { genId } from "@/lib/id";
import {
	cutPoints,
	docDurationUs,
	frameDurationUs,
	groupSegments,
	nextCutPoint,
	pasteSegments,
	pruneEmptyTracks,
	removeSegments,
	rippleDeleteSegments,
	segmentIdsSideOf,
	splitAllAtPlayhead,
	splitSegment,
	stepPlayheadUs,
	trimSegmentToPlayhead,
	ungroupSegments,
} from "@/lib/rtcOps";
import { normalizeRotation } from "@/lib/rtcTransformCore";
import { segTransform, type RtcDoc, type RtcSegment, type RtcTrack, type RtcTransform } from "@/types/rtc";
import { activeRtcDoc, useRtcStore } from "@/store/rtcStore";
import { useRtcClipboard } from "../rtcClipboard";
import { withSegmentTransform } from "../rtcTransform";
import { applyAttrsToDoc, extractSegAttrs, useRtcAttrClipboard } from "../rtcAttrClipboard";
import { useRtcEditorSettingsStore } from "../settings/rtcEditorSettingsStore";
import { buildClipEntries, duplicateAnchorUs, materializePasteEntries, type RtcClipEntry } from "./rtcClipboardCore";
/* 集成轮 glue（关键帧 T / 倒放 D / 裁剪 C 的键盘入口） */
import { toggleKeyframeAtPlayhead } from "@/lib/rtcKeyframes";
import type { RtcKfProp } from "@/types/rtc";
import { toggleReverse } from "../panel/reverseActions";
import { requestCropEditor } from "../panel/cropEditorStore";

/* ────────────────────────── 复制 / 剪切 / 粘贴 / 副本 ────────────────────────── */

/** 复制选中片段到会话剪贴板；返回条数（0=选区为空，此时**不清空**已有剪贴板） */
export function copySelection(): number {
	const st = useRtcStore.getState();
	const doc = activeRtcDoc(st); // 编辑层视图：主层=doc、子层=子文档（第四批集成）
	if (!doc || st.selection.length === 0) return 0;
	const entries = buildClipEntries(doc, st.selection);
	if (entries.length === 0) return 0;
	useRtcClipboard.getState().setEntries(entries);
	return entries.length;
}

/** 剪切 = 复制到剪贴板 + 删除（**一次 commit**，删除留下空隙，与 Delete 同语义） */
export function cutSelection(): number {
	const st = useRtcStore.getState();
	const doc = activeRtcDoc(st); // 编辑层视图：主层=doc、子层=子文档（第四批集成）
	if (!doc || st.selection.length === 0) return 0;
	const n = copySelection();
	if (n === 0) return 0;
	const ids = [...st.selection];
	st.commitActive((d) => pruneEmptyTracks(removeSegments(d, ids))); // 空轨自动回收
	return n;
}

/** 把剪贴板内容粘到指定位置（缺省=播放头）；成功后选中新片段。返回粘贴条数 */
export function pasteClipboard(atUs?: number): number {
	const st = useRtcStore.getState();
	const doc = activeRtcDoc(st); // 编辑层视图：主层=doc、子层=子文档（第四批集成）
	const entries: RtcClipEntry[] = useRtcClipboard.getState().entries;
	if (!doc || entries.length === 0) return 0;
	const prepared = materializePasteEntries(entries, () => genId("seg"));
	const anchor = atUs ?? st.playheadUs;
	st.commitActive((d) => pasteSegments(d, prepared, anchor));
	useRtcStore.getState().setSelection(prepared.map((p) => p.seg.id));
	return prepared.length;
}

/**
 * 创建副本（Ctrl+D）：复制选中片段并落在**选区右缘之后**，保持整批相对关系；
 * ⚠ 刻意**不动剪贴板**（用户手里可能还揣着别的东西要粘）。
 */
export function duplicateSelection(): number {
	const st = useRtcStore.getState();
	const doc = activeRtcDoc(st); // 编辑层视图：主层=doc、子层=子文档（第四批集成）
	if (!doc || st.selection.length === 0) return 0;
	const entries = buildClipEntries(doc, st.selection);
	const anchor = duplicateAnchorUs(doc, st.selection);
	if (entries.length === 0 || anchor == null) return 0;
	const prepared = materializePasteEntries(entries, () => genId("seg"));
	st.commitActive((d) => pasteSegments(d, prepared, anchor));
	useRtcStore.getState().setSelection(prepared.map((p) => p.seg.id));
	return prepared.length;
}

/* ────────────────────────── 删除 / 分割 ────────────────────────── */

/** 全选（Ctrl+A，注意力在时间轴时）：当前编辑层全部**未锁定轨**上的片段；返回选中数 */
export function selectAllSegments(): number {
	const st = useRtcStore.getState();
	const doc = activeRtcDoc(st);
	if (!doc) return 0;
	const ids: string[] = [];
	for (const t of doc.tracks) {
		if (t.locked) continue;
		for (const s of t.segments) ids.push(s.id);
	}
	st.setSelection(ids);
	return ids.length;
}

/** 删除选中（留下空隙）——与 Delete 键、工具条删除同一入口 */
export function deleteSelection(): number {
	const st = useRtcStore.getState();
	const doc = activeRtcDoc(st); // 编辑层视图：主层=doc、子层=子文档（第四批集成）
	if (!doc || st.selection.length === 0) return 0;
	const ids = [...st.selection];
	st.commitActive((d) => pruneEmptyTracks(removeSegments(d, ids))); // 空轨自动回收
	return ids.length;
}

/** 波纹删除（Shift+Delete）：删除后**同轨**右侧片段左移补位，其它轨道不动 */
export function rippleDeleteSelection(): number {
	const st = useRtcStore.getState();
	const doc = activeRtcDoc(st); // 编辑层视图：主层=doc、子层=子文档（第四批集成）
	if (!doc || st.selection.length === 0) return 0;
	const ids = [...st.selection];
	st.commitActive((d) => pruneEmptyTracks(rippleDeleteSegments(d, ids))); // 空轨自动回收
	return ids.length;
}

/** 在播放头处分割选中片段（播放头不在片段内/贴边=该片段 no-op，由 splitSegment 兜底） */
export function splitSelectionAtPlayhead(): void {
	const st = useRtcStore.getState();
	const doc = activeRtcDoc(st); // 编辑层视图：主层=doc、子层=子文档（第四批集成）
	if (!doc || st.selection.length === 0) return;
	const ids = [...st.selection];
	const at = st.playheadUs;
	st.commitActive((d) => ids.reduce((acc, id) => splitSegment(acc, id, at), d));
}

/** 批量分割（Ctrl+B）：全部未锁定轨道上跨过播放头的 media 片段各切一刀（无需选中；一次 commit） */
export function splitAllTracksAtPlayhead(): void {
	const st = useRtcStore.getState();
	const doc = activeRtcDoc(st); // 编辑层视图：主层=doc、子层=子文档（第四批集成）
	if (!doc) return;
	const at = st.playheadUs;
	st.commitActive((d) => splitAllAtPlayhead(d, at));
}

/** 向左/向右裁剪（Q / W）：选中片段里播放头落在其时间窗内的，把对应缘裁到播放头（一次 commit） */
export function trimSelectionToPlayhead(edge: "start" | "end"): void {
	const st = useRtcStore.getState();
	const doc = activeRtcDoc(st); // 编辑层视图：主层=doc、子层=子文档（第四批集成）
	if (!doc || st.selection.length === 0) return;
	const ids = [...st.selection];
	const at = st.playheadUs;
	st.commitActive((d) => ids.reduce((acc, id) => trimSegmentToPlayhead(acc, id, edge, at), d));
}

/* ────────────────────────── 选择 / 组合 ────────────────────────── */

/** 向左/向右全选（[ / ]）：选中播放头一侧的全部片段（锁定轨跳过）。纯选区变更不进撤销栈。 */
export function selectSideOfPlayhead(side: "left" | "right"): number {
	const st = useRtcStore.getState();
	const doc = activeRtcDoc(st); // 编辑层视图：主层=doc、子层=子文档（第四批集成）
	if (!doc) return 0;
	const ids = segmentIdsSideOf(doc, st.playheadUs, side);
	st.setSelection(ids);
	return ids.length;
}

/** 创建组合（Ctrl+G）：选中片段（≥2）归入同一组；跨轨允许。一次 commit。 */
export function groupSelection(): void {
	const st = useRtcStore.getState();
	const doc = activeRtcDoc(st); // 编辑层视图：主层=doc、子层=子文档（第四批集成）
	if (!doc || st.selection.length < 2) return;
	const ids = [...st.selection];
	st.commitActive((d) => groupSegments(d, ids));
}

/** 解除组合（Ctrl+Shift+G）：选中片段所属的组全部解散。一次 commit。 */
export function ungroupSelection(): void {
	const st = useRtcStore.getState();
	const doc = activeRtcDoc(st); // 编辑层视图：主层=doc、子层=子文档（第四批集成）
	if (!doc || st.selection.length === 0) return;
	const ids = [...st.selection];
	st.commitActive((d) => ungroupSegments(d, ids));
}

/* ────────────────────────── 画面快捷变换（镜像 / 旋转） ────────────────────────── */

/** 全 doc 找片段 + 所在轨道（选区可能来自任何轨） */
function findSegWithTrack(doc: RtcDoc, segId: string): { track: RtcTrack; seg: RtcSegment } | null {
	for (const t of doc.tracks) {
		const seg = t.segments.find((s) => s.id === segId);
		if (seg) return { track: t, seg };
	}
	return null;
}

/**
 * 对选中片段逐个改画面变换（一次 commit）：经 withSegmentTransform 落库
 * （规整/缺省删字段/值未变保持引用——与属性面板、预览拖动完全同一把尺）。
 * 音频片段与锁定轨道跳过（画面变换对声音无意义；锁轨不可改）。
 */
function patchSelectionTransforms(fn: (t: RtcTransform) => RtcTransform): void {
	const st = useRtcStore.getState();
	const doc = activeRtcDoc(st); // 编辑层视图：主层=doc、子层=子文档（第四批集成）
	if (!doc || st.selection.length === 0) return;
	const ids = [...st.selection];
	st.commitActive((d) =>
		ids.reduce((acc, id) => {
			const found = findSegWithTrack(acc, id);
			if (!found || found.track.locked) return acc;
			if (found.track.type !== "video" || (found.seg.media ?? "video") === "audio") return acc;
			return withSegmentTransform(acc, id, fn(segTransform(found.seg)));
		}, d),
	);
}

/** 镜像（F）：选中片段水平翻转取反 */
export function mirrorSelection(): void {
	patchSelectionTransforms((t) => ({ ...t, flipH: !t.flipH }));
}

/** 旋转（R）：选中片段顺时针 +90°（角度经 normalizeRotation 归一到 [0,360)） */
export function rotateSelection(): void {
	patchSelectionTransforms((t) => ({ ...t, rotation: normalizeRotation(t.rotation + 90) }));
}

/* ────────────────────────── 属性剪贴板（Ctrl+Shift+C / V） ────────────────────────── */

/**
 * 复制属性：从选区**首个仍存在的片段**取属性快照（transform/音量/变速/静音）。
 * 返回是否真的复制到了（选区为空/片段已删=false，且**不清空**已有属性剪贴板）。
 */
export function copySelectionAttrs(): boolean {
	const st = useRtcStore.getState();
	const doc = activeRtcDoc(st); // 编辑层视图：主层=doc、子层=子文档（第四批集成）
	if (!doc || st.selection.length === 0) return false;
	for (const id of st.selection) {
		const found = findSegWithTrack(doc, id);
		if (found) {
			useRtcAttrClipboard.getState().setAttrs(extractSegAttrs(found.seg));
			return true;
		}
	}
	return false;
}

/** 粘贴属性：把属性剪贴板应用到当前选中的全部片段（一次 commit）。返回应用条数（0=没贴） */
export function pasteSelectionAttrs(): number {
	const st = useRtcStore.getState();
	const doc = activeRtcDoc(st); // 编辑层视图：主层=doc、子层=子文档（第四批集成）
	const attrs = useRtcAttrClipboard.getState().attrs;
	if (!doc || st.selection.length === 0 || !attrs) return 0;
	const ids = [...st.selection];
	st.commitActive((d) => applyAttrsToDoc(d, ids, attrs));
	return ids.length;
}


/* ────────────────────────── 播放与走带 ────────────────────────── */

/** 播放头相对步进（微秒，可负）；钳在 [0, 文档时长] */
export function nudgePlayhead(deltaUs: number): void {
	const st = useRtcStore.getState();
	const doc = activeRtcDoc(st); // 编辑层视图：主层=doc、子层=子文档（第四批集成）
	if (!doc) return;
	st.setPlayhead(stepPlayheadUs(st.playheadUs, deltaUs, docDurationUs(doc)));
}

/** 逐帧步进（帧长按 doc.fps 算，缺省 30fps） */
export function stepPlayheadFrames(frames: number): void {
	const doc = useRtcStore.getState().doc;
	if (!doc) return;
	nudgePlayhead(frames * frameDurationUs(doc.fps));
}

/** 时间轴大幅移动（+ / −）：播放头按设置里的「大幅移动步长（帧）」走一大步 */
export function bigStepPlayhead(dir: 1 | -1): void {
	const frames = useRtcEditorSettingsStore.getState().bigStepFrames;
	stepPlayheadFrames(dir * frames);
}

/** 上/下一分割点（↑ / ↓）：播放头跳到最近的前/后剪辑点（片段边界 + 0；没有就不动） */
export function jumpToCutPoint(dir: 1 | -1): void {
	const st = useRtcStore.getState();
	const doc = activeRtcDoc(st); // 编辑层视图：主层=doc、子层=子文档（第四批集成）
	if (!doc) return;
	const p = nextCutPoint(cutPoints(doc), st.playheadUs, dir);
	if (p != null) st.setPlayhead(p);
}

/** 播放头跳到开头 / 结尾 */
export function seekPlayheadEdge(edge: "start" | "end"): void {
	const st = useRtcStore.getState();
	const doc = activeRtcDoc(st); // 编辑层视图：主层=doc、子层=子文档（第四批集成）
	if (!doc) return;
	st.setPlayhead(edge === "start" ? 0 : docDurationUs(doc));
}

/**
 * 播放 / 暂停预览：**点一下预览播放器控制条上的播放键**。
 *
 * ⚠ 为什么走 DOM 而不是调 store：播放态（rAF 循环、各图层 `<video>` 的 play/pause、
 *   「播完再按=从头」）全是 RtcSequencePlayer 的局部状态，本轮不改那个文件。经它自己的按钮触发，
 *   语义与用户亲手点击**完全一致**，不会出现第二个播放驱动。将来播放态若上提到 rtcStore，
 *   把这里换成 store 调用即可（选择器已预留 `[data-rtc-play-toggle]`，届时给按钮加个属性也行）。
 *   选择器安全性：RTC 页面里只有播放器用 `<button>` 且 title 为「播放/暂停」
 *   （素材卡的试听键是 `<span>`、标题也不同），不会误点。
 * 返回是否真的点到了（播放器未挂载=时间轴还没有任何片段，此时无事可做）。
 */
export function togglePreviewPlayback(): boolean {
	if (typeof document === "undefined") return false;
	const btn = document.querySelector<HTMLElement>(
		'[data-rtc-play-toggle], button[title="播放"], button[title="暂停"]',
	);
	if (!btn) return false;
	btn.click();
	return true;
}

/* ────────────────────────── 集成轮：关键帧 / 倒放 / 裁剪 的键盘入口 ────────────────────────── */

/**
 * 添加关键帧（T，对标剪映）：对选中的 media 画面片段在播放头处 toggle x/y/scale/rotation 四属性
 * （逐属性语义：该属性此刻有帧→删、无帧→按当下生效值加——加帧瞬间画面零跳变；一次按键=一次 undo）。
 * 音频片段/锁定轨/占位符跳过；不透明度与音量的关键帧走属性面板菱形按钮。
 */
export function toggleSelectionKeyframes(): void {
	const st = useRtcStore.getState();
	const doc = activeRtcDoc(st);
	if (!doc || st.selection.length === 0) return;
	const sel = new Set(st.selection);
	const targets: string[] = [];
	for (const t of doc.tracks) {
		if (t.locked || t.type === "text") continue;
		for (const sgm of t.segments) {
			if (sel.has(sgm.id) && sgm.kind === "media" && sgm.media !== "audio") targets.push(sgm.id);
		}
	}
	if (targets.length === 0) return;
	const ph = st.playheadUs;
	st.commitActive((d) =>
		targets.reduce(
			(acc, id) => KF_T_PROPS.reduce((a, prop) => toggleKeyframeAtPlayhead(a, id, prop, ph), acc),
			d,
		),
	);
}
const KF_T_PROPS: RtcKfProp[] = ["x", "y", "scale", "rotation"];

/** 倒放（D）：选区里第一个视频 media 片段 → toggleReverse（异步转码，失败明确报错） */
export function reverseSelection(): void {
	const st = useRtcStore.getState();
	const doc = activeRtcDoc(st);
	if (!doc || st.selection.length === 0) return;
	const sel = new Set(st.selection);
	for (const t of doc.tracks) {
		if (t.type !== "video") continue;
		for (const sgm of t.segments) {
			if (!sel.has(sgm.id) || sgm.kind !== "media" || sgm.media !== "video" || !sgm.uri) continue;
			if (t.locked) { alert("该片段所在轨道已锁定，无法倒放。"); return; }
			void toggleReverse(sgm.id).then((r) => { if (!r.ok && r.error) alert(r.error); });
			return;
		}
	}
	alert("请先选中一个视频片段再倒放。");
}

/** 裁剪画面（C）：选区里第一个画面 media 片段 → 请求属性面板打开裁剪编辑器 */
export function cropSelection(): void {
	const st = useRtcStore.getState();
	const doc = activeRtcDoc(st);
	if (!doc || st.selection.length === 0) return;
	const sel = new Set(st.selection);
	for (const t of doc.tracks) {
		if (t.type !== "video") continue;
		for (const sgm of t.segments) {
			if (!sel.has(sgm.id) || sgm.kind !== "media" || sgm.media === "audio" || !sgm.uri) continue;
			if (t.locked) { alert("该片段所在轨道已锁定，无法裁剪。"); return; }
			st.setSelection([sgm.id]); // 面板只对单选中片段渲染裁剪入口
			requestCropEditor(sgm.id);
			return;
		}
	}
	alert("请先选中一个视频或图片片段再裁剪画面。");
}
