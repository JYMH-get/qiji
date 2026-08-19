/**
 * RtcAssetProps —— 右栏「项目资产」属性视图（实时剪辑内完成资产出图，不切回资产模式）。
 *
 * 区块：资产身份（名/类别/编号）→ 出图提示词（可编辑回写 projectStore）→ 生图模型 →
 *   「生成基础形象 / 重新生成」→ 在途任务 chips → **分体（造型）选择网格**。
 *
 * 分体选择（第237轮定稿，替代原「主图+历史图」区——生成历史在中栏历史条已有位置）：
 *   网格列出该资产的 基础形象 + 全部已出图造型变体（collectAssetForms，与左栏「N造型」右键选单、
 *   AssetAssistant 造型选单同一份清单）；**单击=切换选中造型（写 useAssetFormStore，与资产助手/
 *   左栏选单同一个 store 三方天然同步）**——匹配素材/拖拽用图/显示图全部跟随（第78轮：全库资产
 *   匹配优先 assetFormStore 选中造型）；双击或右上放大镜角标=灯箱查看。「设为主图」不在本区
 *   （中栏历史条已有）。
 *
 * ⚠ 红线：生成只走 assetGenActions.generateAssetBaseImage → generationQueue.startGeneration
 *   唯一路径；不拼提示词模板正文；变体出图（图生图）本轮不做（仅基础形象，variantId=null）。
 * 任务态由持久化 pendingGens 驱动（与资产模式 AssetWorkbench 同一数据源——两处看到同一份在途状态）。
 */
import { useEffect, useState } from "react";
import { Maximize2 } from "lucide-react";
import { useProjectStore, type AssetCat } from "@/store/projectStore";
import { recallPendingGeneration, retryGeneration } from "@/services/generationQueue";
import ModelPicker from "@/components/ModelPicker";
import { PromptExpandButton } from "@/components/PromptExpandButton";
import { openLightbox } from "@/store/lightboxStore";
import type { PendingGen } from "@/services/projectFile";
import { useAssetFormStore } from "@/store/assetFormStore";
import { useRtcAssetSelStore } from "../rtcAssetSelStore";
import { collectAssetForms, type ProjectCatAsset } from "./rtcAssetData";
import { ASSET_CAT_LABEL, generateAssetBaseImage } from "../panel/assetGenActions";

interface AssetLite extends ProjectCatAsset {
	prompt?: string;
}

/** 该资产**基础形象**（variantId=null）的在途任务（持久化 pendingGens，与 AssetWorkbench 同源） */
function useAssetBaseJobs(cat: AssetCat, assetId: string): PendingGen[] {
	const pendingGens = useProjectStore((s) => s.pendingGens);
	return pendingGens.filter((p) => p.cat === cat && p.assetId === assetId && (p.variantId ?? null) === null);
}

/** 在途任务 chips：生成中转圈 / 服务端异常可重连（不再扣费）/ 失败可重试或移除（与 JobChips 同语义的资产版） */
function AssetJobChips({ cat, assetId }: { cat: AssetCat; assetId: string }) {
	const jobs = useAssetBaseJobs(cat, assetId);
	if (jobs.length === 0) return null;
	return (
		<div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
			{jobs.map((p) =>
				p.status === "running" ? (
					<span key={p.id} title="生成中（切页/重启会自动找回，完成后自动设为主图并加入历史）"
						style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, padding: "2px 8px", borderRadius: 4, border: "1px solid rgba(139,92,246,0.5)", background: "rgba(139,92,246,0.15)", color: "#c4b5fd" }}>
						<span className="sb-spin" style={{ display: "inline-block" }}>↻</span>生成中
					</span>
				) : p.recoverable ? (
					<button key={p.id} title={`${p.error || "服务端异常"}（点击重连原任务找回结果，不重新生成不再扣费）`} onClick={() => recallPendingGeneration(p.id)}
						style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, padding: "2px 8px", borderRadius: 4, cursor: "pointer", border: "1px solid rgba(251,191,36,0.6)", background: "rgba(251,191,36,0.14)", color: "#fbbf24" }}>
						↻ 重连原任务
					</button>
				) : (
					<span key={p.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10, padding: "2px 8px", borderRadius: 4, border: "1px solid rgba(248,113,113,0.5)", background: "rgba(248,113,113,0.12)", color: "#f87171" }}>
						<button title={`${p.error || "生成失败"}（点击按原请求重试，会再次扣费）`} onClick={() => retryGeneration(p.id)}
							style={{ background: "none", border: "none", color: "inherit", fontSize: 10, cursor: "pointer", padding: 0 }}>
							失败·重试
						</button>
						<button title="移除该失败记录" onClick={() => useProjectStore.getState().removePendingGen(p.id)}
							style={{ background: "none", border: "none", color: "inherit", fontSize: 10, cursor: "pointer", padding: 0 }}>
							✕
						</button>
					</span>
				),
			)}
		</div>
	);
}

/** 草稿式多行编辑（与 RtcShotWorkbench.DraftArea 同款）：非编辑期跟随 store，失焦才回写（不逐击落盘） */
function DraftArea({ value, placeholder, rows = 5, onCommit }: { value: string; placeholder?: string; rows?: number; onCommit: (v: string) => void }) {
	const [draft, setDraft] = useState(value);
	const [editing, setEditing] = useState(false);
	useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
	return (
		<textarea
			value={draft}
			rows={rows}
			placeholder={placeholder}
			onChange={(e) => setDraft(e.target.value)}
			onFocus={() => setEditing(true)}
			onBlur={() => { setEditing(false); if (draft !== value) onCommit(draft); }}
			style={{ width: "100%", resize: "vertical", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, color: "#fff", padding: "6px 8px", fontSize: 12, lineHeight: 1.5, outline: "none" }}
		/>
	);
}

const secTitle: React.CSSProperties = { fontSize: 11, color: "rgba(255,255,255,0.55)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 };
const secBox: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };

export function RtcAssetProps({ cat, id }: { cat: AssetCat; id: string }) {
	const asset = useProjectStore((s) => (s[cat] as AssetLite[]).find((a) => a.id === id));
	const jobs = useAssetBaseJobs(cat, id);
	const running = jobs.some((p) => p.status === "running");
	// 当前选中造型（与 AssetAssistant/左栏「N造型」选单同一 store 同一键结构：assetId → variantId|null）
	const selForm = useAssetFormStore((s) => s.selForm);

	// 资产已被删除/切换项目后不存在 → 自动清选中（右栏回落引导）
	useEffect(() => {
		if (!asset) {
			const cur = useRtcAssetSelStore.getState().selected;
			if (cur && cur.cat === cat && cur.id === id) useRtcAssetSelStore.getState().clear();
		}
	}, [asset, cat, id]);
	if (!asset) return null;

	// 分体清单：基础形象 + 全部已出图造型变体（与 AssetAssistant/左栏选单同一份收敛逻辑）
	const forms = collectAssetForms(asset);
	// 当前选中造型判定与 AssetAssistant 逐字对齐：sel 未设=基础形象（null），找不到回退第一个有图造型
	const sel = selForm[id];
	const curVariantId = (forms.find((f) => f.variantId === (sel ?? null)) ?? forms[0])?.variantId ?? null;
	const update = (patch: Record<string, unknown>) => useProjectStore.getState().updateAsset(cat, id, patch);
	const livePrompt = () => (useProjectStore.getState()[cat] as AssetLite[]).find((a) => a.id === id)?.prompt || "";

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "12px 12px 24px" }}>
			{/* 头部：资产身份（名 / 类别 / 编号） */}
			<div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
				<div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
					<span style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>{asset.name || "未命名资产"}</span>
					<span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{ASSET_CAT_LABEL[cat]} · 资产</span>
				</div>
				<div title="资产编号（项目内唯一标识）" style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", wordBreak: "break-all" }}>编号：{asset.id}</div>
			</div>

			{/* 出图提示词（可编辑回写 projectStore；与资产模式同一字段 prompt） */}
			<div style={secBox}>
				<div style={secTitle}>
					<span>出图提示词</span>
					<PromptExpandButton title={`${asset.name || "资产"} · 出图提示词`} getValue={livePrompt} onSave={(v) => update({ prompt: v })} size={11} />
				</div>
				<DraftArea value={asset.prompt || ""} rows={5} placeholder="描述该资产的基础形象（与资产模式共用同一提示词字段）…" onCommit={(v) => update({ prompt: v })} />
			</div>

			{/* 生图模型 */}
			<div style={secBox}>
				<ModelPicker cap="image" label="生图模型" />
			</div>

			{/* 动作 + 任务态 */}
			<div style={secBox}>
				{!asset.image && !running && (
					<div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.45)", lineHeight: 1.6 }}>
						该资产尚未出图——确认上方提示词后点「生成基础形象」；完成后左栏占位符卡自动变为图卡，即可拖入时间轴/垫图。
					</div>
				)}
				<button
					disabled={running}
					title={asset.image ? "按提示词重新生成基础形象（新结果设为主图并加入历史）" : "按提示词生成基础形象"}
					onClick={() => void generateAssetBaseImage(cat, id)}
					style={{ padding: "7px 8px", fontSize: 12, borderRadius: 6, cursor: running ? "not-allowed" : "pointer", opacity: running ? 0.5 : 1, border: "1px solid rgba(139,92,246,0.6)", background: "rgba(139,92,246,0.22)", color: "#d6c8ff", whiteSpace: "nowrap" }}>
					{running ? "生成中…" : asset.image ? "重新生成" : "生成基础形象"}
				</button>
				<AssetJobChips cat={cat} assetId={id} />
			</div>

			{/* 分体（造型）选择：基础形象 + 全部已出图造型变体（与左栏「N造型」右键选单同一份清单）。
			    单击=切换选中造型（写 assetFormStore，与资产助手/左栏选单三方同步——匹配素材/拖拽用图跟随）；
			    双击或右上放大镜角标=灯箱。生成历史在中栏右缘历史条查看，「设为主图」也在那里。 */}
			{forms.length ? (
				<div style={secBox}>
					<div style={{ ...secTitle, fontSize: 10 }}>
						<span>分体选择（{forms.length}）</span>
						<span style={{ fontSize: 9.5, color: "rgba(255,255,255,0.35)" }}>点击=选中 · 双击/🔍=放大</span>
					</div>
					<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))", gap: 6 }}>
						{forms.map((f) => {
							const active = (f.variantId ?? null) === curVariantId;
							return (
								<div key={f.variantId ?? "__base"} className="group"
									title={`${f.name}${active ? "（当前选中）" : ""}——单击选中该造型（匹配素材/拖拽用图跟随），双击放大查看`}
									onClick={() => useAssetFormStore.getState().setSelForm(id, f.variantId ?? null)}
									onDoubleClick={() => openLightbox({ uri: f.uri, name: f.name })}
									style={{ position: "relative", aspectRatio: "1/1", borderRadius: 6, overflow: "hidden", cursor: "pointer", border: active ? "2px solid rgba(139,92,246,0.95)" : "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.05)" }}>
									<img src={f.uri} style={{ width: "100%", height: "100%", objectFit: "cover" }} draggable={false} />
									{active && <span style={{ position: "absolute", inset: 0, background: "rgba(139,92,246,0.18)", pointerEvents: "none" }} />}
									{active && (
										<span style={{ position: "absolute", top: 0, left: 0, fontSize: 9, lineHeight: "13px", padding: "0 4px", background: "rgba(139,92,246,0.92)", color: "#fff", borderBottomRightRadius: 4 }}>当前</span>
									)}
									{/* 放大镜角标：单击=灯箱（stopPropagation 不触发选中切换） */}
									<button
										onClick={(e) => { e.stopPropagation(); openLightbox({ uri: f.uri, name: f.name }); }}
										onDoubleClick={(e) => e.stopPropagation()}
										title="放大查看"
										className="hidden group-hover:flex"
										style={{ position: "absolute", top: 2, right: 2, width: 18, height: 18, alignItems: "center", justifyContent: "center", borderRadius: 4, color: "#fff", background: "rgba(0,0,0,0.6)", border: "none", cursor: "zoom-in", padding: 0 }}
									><Maximize2 size={10} /></button>
									<span style={{ position: "absolute", left: 0, right: 0, bottom: 0, fontSize: 9, color: "#fff", background: "rgba(0,0,0,0.6)", padding: "1px 4px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textAlign: "center" }}>
										{f.variantId === null ? "基础" : f.label}
									</span>
								</div>
							);
						})}
					</div>
				</div>
			) : null}

			<div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", lineHeight: 1.6 }}>
				分体选择与资产助手、左栏造型选单实时同步；生成历史与「设为主图」在中栏预览右缘的历史条操作；变体/图生图请在资产模式操作。
			</div>
		</div>
	);
}
