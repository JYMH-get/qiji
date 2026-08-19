/**
 * AssetImportDropdown —— 提示词框输入 # 时弹出的「导入并引用项目资产」待选框。
 * 列出当前项目全部已出图资产（角色/群像/场景/生物/物品，含变体），可搜索；
 * 选中 → 上层把该资产加入素材区并在光标处 @ 引用（# 符号被吃掉、不出现）。
 * portal 到 body，zIndex 高于放大弹窗（100000）。
 */
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { getProjectAssetCandidates, kindLabel, type ProjectAssetCandidate } from "@/lib/projectAssets";

export function AssetImportDropdown({
	pos,
	onPick,
	onClose,
}: {
	pos: { x: number; y: number };
	onPick: (a: ProjectAssetCandidate) => void;
	onClose: () => void;
}) {
	const [q, setQ] = useState("");
	const all = useMemo(() => getProjectAssetCandidates(), []);
	const list = useMemo(() => {
		const kw = q.trim().toLowerCase();
		return kw ? all.filter((a) => (a.name || "").toLowerCase().includes(kw) || kindLabel(a.kind).includes(kw)) : all;
	}, [all, q]);

	const left = Math.min(pos.x, window.innerWidth - 300);
	const top = Math.min(pos.y + 18, window.innerHeight - 340);

	return createPortal(
		<>
			<div onMouseDown={onClose} style={{ position: "fixed", inset: 0, zIndex: 100050 }} />
			<div
				className="Qiji-scroll-thin"
				onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
				style={{ position: "fixed", left, top, width: 288, maxHeight: 320, display: "flex", flexDirection: "column", background: "rgba(28,33,45,0.99)", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 10, boxShadow: "0 12px 40px rgba(0,0,0,0.6)", zIndex: 100051, overflow: "hidden" }}
			>
				<div style={{ padding: 6, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
					<input
						autoFocus
						value={q}
						onChange={(e) => setQ(e.target.value)}
						placeholder="搜索资产（导入并引用）…"
						style={{ width: "100%", padding: "5px 8px", fontSize: 12, color: "#e6e6e6", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, outline: "none" }}
					/>
				</div>
				<div className="Qiji-scroll-thin" style={{ overflowY: "auto", padding: 4 }}>
					{list.length === 0 ? (
						<div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", padding: "8px 6px" }}>
							{all.length === 0 ? "本项目暂无已出图资产" : "无匹配资产"}
						</div>
					) : list.map((a, i) => (
						<div
							key={a.assetId + i}
							onClick={() => onPick(a)}
							style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 6px", borderRadius: 6, cursor: "pointer" }}
							onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
							onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
						>
							<div style={{ width: 32, height: 32, borderRadius: 5, overflow: "hidden", flexShrink: 0, background: "rgba(255,255,255,0.06)" }}>
								{a.uri ? <img src={a.uri} style={{ width: "100%", height: "100%", objectFit: "cover" }} draggable={false} /> : null}
							</div>
							<div style={{ minWidth: 0, flex: 1 }}>
								<div style={{ fontSize: 12, color: "#e6e6e6", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
									{a.name}{a.label ? <span style={{ color: "rgba(255,255,255,0.45)" }}>·{a.label}</span> : null}
								</div>
								<div style={{ fontSize: 10, color: "rgba(255,255,255,0.45)" }}>{kindLabel(a.kind)}</div>
							</div>
						</div>
					))}
				</div>
			</div>
		</>,
		document.body,
	);
}
