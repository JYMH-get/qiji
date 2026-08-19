/**
 * AssetBindModal —— 「绑定/添加到项目资产」弹窗（第113轮；第120轮泛化支持任意绑定源）。
 *  - mode="image"：图片 → 选现有资产（写主图+历史）或新建资产命名后绑定；
 *  - mode="voice"：音频 → 选现有资产绑定音色（与资产模式绑音色同格式，已绑则替换）。
 * 绑定源二选一：nodeId（画布节点结果，第113轮语义）或 source（直接给 uri，如共享资产卡）。
 * 资产卡按五类页签展示（缩略图+名称，可搜索）；绑定后资产助手/匹配资产即可调用。
 */
import { useMemo, useState } from "react";
import { useProjectStore, type AssetCat } from "@/store/projectStore";
import { useCanvasStore } from "@/store/canvasStore";
import {
	BIND_CATS,
	bindImageToAsset,
	bindImageToNewAsset,
	bindAudioToAsset,
	nodeResultLibAsset,
	type BindSource,
} from "@/canvas/assetBind";

const ghost: React.CSSProperties = { padding: "7px 14px", borderRadius: 8, fontSize: 12, cursor: "pointer", border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.05)", color: "#fff" };
const primary: React.CSSProperties = { padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", border: "none", background: "linear-gradient(90deg,#8b5cf6,#7c3aed)", color: "#fff" };
const inputSt: React.CSSProperties = { flex: 1, minWidth: 0, padding: "7px 10px", borderRadius: 8, fontSize: 12, border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.06)", color: "#fff", outline: "none" };

export default function AssetBindModal({ nodeId, source, mode, onCancel }: {
	/** 画布节点绑定源（与 source 二选一） */
	nodeId?: string;
	/** 直接绑定源（共享资产卡等：uri=显示 uri，serverAssetId 供音色绑定） */
	source?: BindSource;
	mode: "image" | "voice";
	onCancel: () => void;
}) {
	const cats = useProjectStore((s) => ({
		characters: s.characters, crowds: s.crowds, scenes: s.scenes, organisms: s.organisms, items: s.items,
	}));
	const [tab, setTab] = useState<AssetCat>("characters");
	const [q, setQ] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [newName, setNewName] = useState("");
	const [err, setErr] = useState("");

	// 绑定源解析：显式 source 优先（共享资产卡）；否则取节点结果资产（第113轮语义，含出图提示词）
	const lib = source ? null : nodeId ? nodeResultLibAsset(nodeId) : null;
	const src: BindSource = source ?? (() => {
		const node = nodeId ? useCanvasStore.getState().nodes[nodeId] : null;
		const prompt = typeof node?.data.params.prompt === "string" ? node.data.params.prompt : "";
		return { uri: lib?.uri || "", name: lib?.name, serverAssetId: lib?.serverAssetId || lib?.id, prompt };
	})();
	const srcUri = src.uri || "";
	const srcName = src.name || "";

	const list = useMemo(() => {
		const kw = q.trim().toLowerCase();
		const arr = cats[tab] as Array<{ id: string; name: string; image?: string; voiceName?: string }>;
		return kw ? arr.filter((a) => a.name.toLowerCase().includes(kw)) : arr;
	}, [cats, tab, q]);

	const finish = (r: { ok: true; assetName: string } | { ok: false; error: string }) => {
		if (!r.ok) { setErr(r.error); return; }
		onCancel();
		alert(mode === "image"
			? `已绑定到资产「${r.assetName}」：该图已设为主图并进入历史，可在资产助手/匹配资产中调用。`
			: `已绑定为「${r.assetName}」的音色：匹配资产命中该资产时，此音频将作为声音参考一起加入素材区。`);
	};

	const onBind = () => {
		setErr("");
		if (!selectedId) { setErr("请先在下方选择一个资产"); return; }
		finish(mode === "image" ? bindImageToAsset(src, tab, selectedId) : bindAudioToAsset(src, tab, selectedId));
	};
	const onCreate = () => {
		setErr("");
		finish(bindImageToNewAsset(src, tab, newName));
	};

	return (
		<>
			<div onClick={onCancel} style={{ position: "fixed", inset: 0, zIndex: 10500, background: "rgba(0,0,0,0.55)" }} />
			<div style={{ position: "fixed", zIndex: 10501, top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 620, maxWidth: "94vw", maxHeight: "88vh", padding: 18, borderRadius: 12, background: "#161b26", border: "1px solid rgba(255,255,255,0.14)", boxShadow: "0 12px 40px rgba(0,0,0,0.6)", display: "flex", flexDirection: "column", gap: 12 }}>
				<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
					<div style={{ fontSize: 14, fontWeight: 600, color: "#fff" }}>
						{mode === "image" ? "绑定到资产" : "绑定音色到资产"}
					</div>
					<span style={{ fontSize: 12, color: "rgba(255,255,255,0.55)" }}>
						{mode === "image" ? "把本节点的图片设为所选资产的主图（进入历史，可追溯）" : "把本节点的音频绑为所选资产的声音参考（已绑则替换）"}
					</span>
				</div>

				{/* 源预览 */}
				<div style={{ display: "flex", alignItems: "center", gap: 12, padding: 10, borderRadius: 8, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
					{mode === "image" ? (
						srcUri ? <img src={srcUri} alt="" style={{ width: 84, height: 48, objectFit: "cover", borderRadius: 6 }} /> : <span style={{ fontSize: 12, color: "#f26d8d" }}>没有可绑定的图片</span>
					) : (
						srcUri ? <audio src={srcUri} controls style={{ height: 32, maxWidth: 320 }} /> : <span style={{ fontSize: 12, color: "#f26d8d" }}>没有可绑定的音频</span>
					)}
					<span style={{ fontSize: 11.5, color: "rgba(255,255,255,0.45)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{srcName}</span>
				</div>

				{/* 分类页签 + 搜索 */}
				<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
					{BIND_CATS.map(({ cat, label }) => (
						<button
							key={cat}
							onClick={() => { setTab(cat); setSelectedId(null); setErr(""); }}
							style={{
								padding: "5px 12px", borderRadius: 999, fontSize: 12, cursor: "pointer",
								border: "1px solid " + (tab === cat ? "rgba(139,124,247,0.7)" : "rgba(255,255,255,0.12)"),
								background: tab === cat ? "rgba(139,124,247,0.22)" : "rgba(255,255,255,0.04)",
								color: tab === cat ? "#cbb8ff" : "rgba(255,255,255,0.7)",
							}}
						>
							{label}（{(cats[cat] as unknown[]).length}）
						</button>
					))}
					<span style={{ flex: 1 }} />
					<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索资产名" style={{ ...inputSt, flex: "0 0 150px" }} />
				</div>

				{/* 资产卡列表 */}
				<div className="Qiji-scroll-thin" style={{ overflowY: "auto", minHeight: 120, maxHeight: "42vh", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8, border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 8 }}>
					{list.length === 0 ? (
						<div style={{ gridColumn: "1/-1", fontSize: 12, color: "rgba(255,255,255,0.5)", padding: "22px 0", textAlign: "center" }}>
							{q.trim() ? "没有匹配的资产" : "该分类下还没有资产" + (mode === "image" ? "——可在下方直接新建" : "")}
						</div>
					) : (
						list.map((a) => {
							const on = selectedId === a.id;
							return (
								<div
									key={a.id}
									onClick={() => { setSelectedId(on ? null : a.id); setErr(""); }}
									onDoubleClick={() => { setSelectedId(a.id); setTimeout(onBind, 0); }}
									title={a.name}
									style={{
										cursor: "pointer", borderRadius: 8, overflow: "hidden",
										border: on ? "2px solid #8b7cf7" : "1px solid rgba(255,255,255,0.1)",
										background: on ? "rgba(139,124,247,0.12)" : "rgba(255,255,255,0.03)",
									}}
								>
									{a.image ? (
										<img src={a.image} alt="" style={{ width: "100%", height: 68, objectFit: "cover", display: "block" }} />
									) : (
										<div style={{ width: "100%", height: 68, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "rgba(255,255,255,0.35)", background: "rgba(255,255,255,0.04)" }}>未出图</div>
									)}
									<div style={{ padding: "5px 7px", fontSize: 12, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
										{a.name}
										{mode === "voice" && a.voiceName ? <span style={{ marginLeft: 4, fontSize: 10.5, color: "#e8b06a" }}>已有音色</span> : null}
									</div>
								</div>
							);
						})
					)}
				</div>

				{/* 新建资产（仅图片绑定） */}
				{mode === "image" && (
					<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
						<span style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", whiteSpace: "nowrap" }}>或新建{BIND_CATS.find((c) => c.cat === tab)?.label}：</span>
						<input
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
							onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) onCreate(); }}
							placeholder="输入新资产名称（如 张三）"
							style={inputSt}
						/>
						<button style={{ ...ghost, whiteSpace: "nowrap", opacity: newName.trim() && srcUri ? 1 : 0.5 }} disabled={!newName.trim() || !srcUri} onClick={onCreate}>
							新建并绑定
						</button>
					</div>
				)}

				{err && <div style={{ fontSize: 12, color: "#f26d8d" }}>{err}</div>}

				<div style={{ display: "flex", justifyContent: "flex-end", gap: 9 }}>
					<button style={ghost} onClick={onCancel}>取消</button>
					<button style={{ ...primary, opacity: selectedId && srcUri ? 1 : 0.55 }} disabled={!selectedId || !srcUri} onClick={onBind}>
						{mode === "image" ? "绑定到所选资产" : "绑定音色"}
					</button>
				</div>
			</div>
		</>
	);
}
