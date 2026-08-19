/**
 * RtcTransitionPicker —— 片段「转场」选择区（第三批，挂在 RtcMediaProps 里，仅视频轨片段显示）。
 *
 * 语义：转场挂在**前一段**上（seg.transitionAfter），作用于与下一段的衔接；
 * 资源表=lib/jyTransitions（剪映内置转场 effect_id/resource_id）；时长默认取该资源默认档、可改。
 * ⚠ 预览不渲染转场效果（导出剪映后生效）——UI 明示，勿让用户误以为坏了。
 * 写库一律 rtcStore.commit + patchSegmentDoc 内联不可变（值未变不 commit，不污染撤销栈）。
 */
import { useEffect, useState } from "react";
import type { RtcSegment } from "@/types/rtc";
import { JY_PREVIEW_TRANSITIONS, clampTransitionUs, findJyTransition } from "@/lib/jyTransitions";
import { commitSegmentPatch } from "./rtcSegUtils";

const rowSt: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, fontSize: 11, color: "rgba(255,255,255,0.6)" };
const ctlSt: React.CSSProperties = { width: 130, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, color: "#fff", padding: "5px 8px", fontSize: 12, outline: "none" };

/** 转场时长输入（秒，草稿式；失焦/回车提交，夹 0.1–5s） */
function DurationInput({ segId, seg }: { segId: string; seg: RtcSegment }) {
	const tr = seg.transitionAfter;
	const sec = tr ? tr.durationUs / 1_000_000 : 0.5;
	const [draft, setDraft] = useState(String(sec));
	useEffect(() => { setDraft(String(sec)); }, [sec, segId, tr?.effectId]);
	if (!tr) return null;
	const commit = () => {
		const n = Number(draft);
		const us = clampTransitionUs(Number.isFinite(n) ? Math.round(n * 1_000_000) : NaN, tr.effectId);
		setDraft(String(us / 1_000_000));
		if (us !== tr.durationUs) commitSegmentPatch(segId, { transitionAfter: { ...tr, durationUs: us } });
	};
	return (
		<div style={rowSt}>
			<span>转场时长（秒）</span>
			<input
				type="number" min={0.1} max={5} step={0.1} value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
				style={{ ...ctlSt, width: 90 }}
				title="转场时长（0.1–5 秒）"
			/>
		</div>
	);
}

export function RtcTransitionPicker({ seg }: { seg: RtcSegment }) {
	const cur = seg.transitionAfter;
	const onSelect = (effectId: string) => {
		if (!effectId) {
			if (cur) commitSegmentPatch(seg.id, { transitionAfter: undefined });
			return;
		}
		const meta = findJyTransition(effectId);
		if (!meta) return;
		if (cur?.effectId === effectId) return; // 同款不重复写
		commitSegmentPatch(seg.id, {
			transitionAfter: {
				effectId: meta.effectId,
				resourceId: meta.resourceId,
				name: meta.name,
				durationUs: meta.defaultDurationUs,
			},
		});
	};
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.07)" }}>
			<div style={rowSt}>
				<span>转场（与下一段衔接）</span>
				<select
					value={cur?.effectId ?? ""}
					onChange={(e) => onSelect(e.target.value)}
					style={{ ...ctlSt, cursor: "pointer" }}
					title="转场挂在本片段尾部，作用于与下一段的衔接（预览与导出剪映观感一致）"
				>
					<option value="">无</option>
					{JY_PREVIEW_TRANSITIONS.map((t) => (
						<option key={t.effectId} value={t.effectId}>{t.name}</option>
					))}
					{/* 旧文档里选过的不可预览款：保留可见可清除，但不再推荐（新选只给可预览款） */}
					{cur && !JY_PREVIEW_TRANSITIONS.some((t) => t.effectId === cur.effectId) ? (
						<option value={cur.effectId}>{cur.name}（无预览·不推荐）</option>
					) : null}
				</select>
			</div>
			<DurationInput segId={seg.id} seg={seg} />
			{cur ? (
				<div style={{ fontSize: 10, lineHeight: 1.6, color: "rgba(255,255,255,0.38)" }}>
					预览播放器会渲染该转场（与剪映「{cur.name}」观感一致）；导出草稿用剪映内置资源。
				</div>
			) : null}
		</div>
	);
}
