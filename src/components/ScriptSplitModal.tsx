/**
 * ScriptSplitModal —— 画布「原文节点拆分」弹窗：以**行为单位**把一段原文拆成多段。
 * 逐行显示原文（空行不计），行与行之间可插「拆分点」；每段=拆分点之间的连续行。
 * 确认后由调用方（NodeProcessModals → buildScriptSplitRows）牵出多个新「分镜n原文」节点。
 */
import { useMemo, useState } from "react";
import { splitLines, segmentsFromBoundaries } from "@/lib/scriptSplit";

const ghost: React.CSSProperties = { padding: "7px 14px", borderRadius: 8, fontSize: 12, cursor: "pointer", border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.05)", color: "#fff" };
const primary: React.CSSProperties = { padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", border: "none", background: "linear-gradient(90deg,#8b5cf6,#7c3aed)", color: "#fff" };
const miniBtn: React.CSSProperties = { whiteSpace: "nowrap", padding: "4px 9px", borderRadius: 6, fontSize: 11, cursor: "pointer", border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.06)", color: "#fff" };

// 段落配色（循环）：让相邻段一眼可辨
const SEG_COLORS = ["#8b7cf7", "#5aa7f0", "#41d392", "#e8b06a", "#f26d8d", "#5bd6c8", "#c084fc"];

export default function ScriptSplitModal({ text, onCancel, onConfirm }: {
	text: string;
	onCancel: () => void;
	onConfirm: (segments: string[]) => void;
}) {
	const lines = useMemo(() => splitLines(text), [text]);
	// 拆分点：含 i 表示「在第 i 行之前断开」（i∈[1, lines.length-1]）
	const [cuts, setCuts] = useState<Set<number>>(new Set());

	const segs = useMemo(() => segmentsFromBoundaries(lines, cuts), [lines, cuts]);
	// 每行属于第几段（0 起）——用于给行标色
	const segOfLine = useMemo(() => {
		const out: number[] = [];
		let s = 0;
		for (let i = 0; i < lines.length; i++) {
			if (i > 0 && cuts.has(i)) s++;
			out.push(s);
		}
		return out;
	}, [lines, cuts]);

	const toggleCut = (i: number) => setCuts((prev) => {
		const next = new Set(prev);
		if (next.has(i)) next.delete(i); else next.add(i);
		return next;
	});
	const splitEvery = () => setCuts(new Set(lines.map((_, i) => i).filter((i) => i >= 1)));
	const clearCuts = () => setCuts(new Set());

	const canConfirm = lines.length > 0 && segs.length >= 2;

	return (
		<>
			<div onClick={onCancel} style={{ position: "fixed", inset: 0, zIndex: 10500, background: "rgba(0,0,0,0.55)" }} />
			<div style={{ position: "fixed", zIndex: 10501, top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 560, maxWidth: "94vw", maxHeight: "88vh", padding: 18, borderRadius: 12, background: "#161b26", border: "1px solid rgba(255,255,255,0.14)", boxShadow: "0 12px 40px rgba(0,0,0,0.6)", display: "flex", flexDirection: "column", gap: 12 }}>
				<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
					<div style={{ fontSize: 14, fontWeight: 600, color: "#fff" }}>拆分原文（以行为单位）</div>
					<span style={{ fontSize: 12, color: "rgba(255,255,255,0.55)" }}>点击行间「＋ 在此拆分」设拆分点，将拆成 <b style={{ color: "#cbb8ff" }}>{segs.length}</b> 段</span>
					<span style={{ flex: 1 }} />
					<button style={miniBtn} onClick={splitEvery}>每行一段</button>
					<button style={miniBtn} onClick={clearCuts}>清除拆分</button>
				</div>

				{lines.length === 0 ? (
					<div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", padding: "24px 0", textAlign: "center" }}>该节点没有可拆分的原文（内容为空）。</div>
				) : (
					<div className="Qiji-scroll-thin" style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 0, border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 8 }}>
						{lines.map((line, i) => {
							const color = SEG_COLORS[segOfLine[i] % SEG_COLORS.length];
							const cutHere = cuts.has(i);
							return (
								<div key={i}>
									{i > 0 && (
										<div
											onClick={() => toggleCut(i)}
											title={cutHere ? "点击取消此拆分点" : "点击在此拆分（上下分成两段）"}
											style={{
												display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
												padding: "3px 6px", margin: "2px 0", borderRadius: 6,
												color: cutHere ? "#cbb8ff" : "rgba(255,255,255,0.32)",
												background: cutHere ? "rgba(139,124,247,0.14)" : "transparent",
												fontSize: 11, userSelect: "none",
											}}
										>
											<span style={{ flex: 1, height: 1, background: cutHere ? "rgba(139,124,247,0.5)" : "rgba(255,255,255,0.08)" }} />
											{cutHere ? "✂ 拆分点（点击取消）" : "＋ 在此拆分"}
											<span style={{ flex: 1, height: 1, background: cutHere ? "rgba(139,124,247,0.5)" : "rgba(255,255,255,0.08)" }} />
										</div>
									)}
									<div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "5px 6px" }}>
										<span style={{ flex: "none", width: 34, textAlign: "center", fontSize: 10, fontWeight: 600, color, background: `${color}22`, border: `1px solid ${color}55`, borderRadius: 5, padding: "1px 0", marginTop: 1 }}>段{segOfLine[i] + 1}</span>
										<span style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: 1.5, color: "#e6e9f0", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{line}</span>
									</div>
								</div>
							);
						})}
					</div>
				)}

				<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
					<span style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>确认后为每段牵出一个新「原文节点」，接在本节点之后（可各自推理）。</span>
					<span style={{ flex: 1 }} />
					<button style={ghost} onClick={onCancel}>取消</button>
					<button style={{ ...primary, opacity: canConfirm ? 1 : 0.5, cursor: canConfirm ? "pointer" : "not-allowed" }} disabled={!canConfirm} onClick={() => onConfirm(segs)}>
						拆成 {segs.length} 段
					</button>
				</div>
			</div>
		</>
	);
}
