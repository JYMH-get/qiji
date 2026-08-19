/**
 * shotWorkbenchParts —— 分镜占位符工作台的共享小件（中栏「AI 工作台」RtcShotAiWorkbench 与
 * 右栏「AI 生成属性」RtcShotWorkbench 共用；原样自 RtcShotWorkbench 抽出，**逻辑零重写只搬家**）。
 *
 * 内容：
 *  - useShotJobs / useShotInferring：在途任务态（持久化 pendingGens/inferTasks，与 Frame161195 同源）；
 *  - JobChips：生成中/重连/失败 chips；
 *  - ShotPromptField：单个提示词栏位（PromptMentionEditor + @素材引用 + #导入 + ▦预设 + 放大弹窗全委托）
 *    ——新增可选 editorMinHeight（中栏灯箱式大编辑区用；缺省 92 与右栏旧观感一致）；
 *  - HistoryGrid：历史结果缩略网格（点击放大 / 设为当前）；
 *  - secTitle / secBox / btnSt：区块样式。
 *
 * 红线（沿用勿回退）：客户端只插胶囊标记（【预设:id】/@ImageN），展开收口在提交（shotGenActions
 * 的 resolvePresets / 上游 @tag 注入）；放大弹窗「匹配资产」永远委托宿主（第108轮）。
 */
import { useEffect, useRef, useState } from "react";
import { useProjectStore } from "@/store/projectStore";
import { recallPendingGeneration } from "@/services/generationQueue";
import { PromptExpandButton } from "@/components/PromptExpandButton";
import PromptMentionEditor, { type PromptMentionHandle } from "@/components/PromptMentionEditor";
import { AssetImportDropdown } from "@/components/AssetImportDropdown";
import { openLightbox } from "@/store/lightboxStore";
import type { PresetScheme } from "@/lib/presetSchemes";
import { materialTags, mediaOf, BADGE_BG } from "@/lib/shotMaterials";
import { importAssetToShot, addLocalShotMaterials } from "@/lib/shotMaterialOps";
import type { PendingGen, StoryboardShot } from "@/services/projectFile";
import { RtcMaterialStrip } from "./RtcMaterialStrip";
import { matchShotAssets, type ShotPromptFieldKey } from "./shotMatchActions";

/* ────────────────────────── 在途任务态 ────────────────────────── */

/** 该分镜某字段的在途任务（持久化 pendingGens，与表格页同源） */
export function useShotJobs(shotId: string, field: "storyboard" | "video"): PendingGen[] {
	const pendingGens = useProjectStore((s) => s.pendingGens);
	return pendingGens.filter((p) => p.shot?.shotId === shotId && p.shot.field === field);
}

/** 该分镜单镜推理是否在途（hook 版，订阅 inferTasks） */
export function useShotInferring(shotId: string): boolean {
	return useProjectStore((s) => s.inferTasks.some((t) => t.shotId === shotId && t.mode === "single" && t.status === "running"));
}

/** 在途任务状态 chips：生成中转圈 / 服务端异常可重连 / 失败可移除（与 Frame161195 jobChips 同语义） */
export function JobChips({ shotId, field }: { shotId: string; field: "storyboard" | "video" }) {
	const jobs = useShotJobs(shotId, field);
	if (jobs.length === 0) return null;
	return (
		<div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
			{jobs.map((p) =>
				p.status === "running" ? (
					<span key={p.id} title="生成中（切页/重启会自动找回，完成后加入历史）"
						style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, padding: "2px 8px", borderRadius: 4, border: "1px solid rgba(139,92,246,0.5)", background: "rgba(139,92,246,0.15)", color: "#c4b5fd" }}>
						<span className="sb-spin" style={{ display: "inline-block" }}>↻</span>生成中
					</span>
				) : p.recoverable ? (
					<button key={p.id} title={`${p.error || "服务端异常"}（点击重连原任务找回结果，不重新生成不再扣费）`} onClick={() => recallPendingGeneration(p.id)}
						style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, padding: "2px 8px", borderRadius: 4, cursor: "pointer", border: "1px solid rgba(251,191,36,0.6)", background: "rgba(251,191,36,0.14)", color: "#fbbf24" }}>
						↻ 重连原任务
					</button>
				) : (
					<button key={p.id} title={`${p.error || "生成失败"}（点击移除）`} onClick={() => useProjectStore.getState().removePendingGen(p.id)}
						style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, cursor: "pointer", border: "1px solid rgba(248,113,113,0.5)", background: "rgba(248,113,113,0.12)", color: "#f87171" }}>
						失败 ✕
					</button>
				),
			)}
		</div>
	);
}

/* ────────────────────────── 区块样式 ────────────────────────── */

export const secTitle: React.CSSProperties = { fontSize: 11, color: "rgba(255,255,255,0.55)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 };
export const secBox: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };

export const btnSt = (kind: "primary" | "plain" = "plain", disabled = false): React.CSSProperties => ({
	flex: 1,
	padding: "7px 8px",
	fontSize: 12,
	borderRadius: 6,
	cursor: disabled ? "not-allowed" : "pointer",
	opacity: disabled ? 0.5 : 1,
	border: kind === "primary" ? "1px solid rgba(139,92,246,0.6)" : "1px solid rgba(255,255,255,0.14)",
	background: kind === "primary" ? "rgba(139,92,246,0.22)" : "rgba(255,255,255,0.06)",
	color: kind === "primary" ? "#d6c8ff" : "rgba(255,255,255,0.85)",
	whiteSpace: "nowrap",
});

/* ────────────────────────── 草稿式多行编辑 ────────────────────────── */

/** 草稿式多行编辑：非编辑期跟随 store（推理流式回填实时可见），失焦才回写（不逐击落盘） */
export function DraftArea({ value, placeholder, rows = 4, onCommit }: { value: string; placeholder?: string; rows?: number; onCommit: (v: string) => void }) {
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

/* ────────────────────────── 提示词栏（富文本 + @/#/预设 + 放大弹窗全委托） ────────────────────────── */

/**
 * 单个提示词栏位：PromptMentionEditor（@素材胶囊/#导入/预设 pill）+ 标题行（▦预设 + 放大）。
 * 与 Frame161195 的提示词区同一套组件与语义：客户端只插胶囊标记（【预设:id】/@ImageN），
 * 展开收口在提交（shotGenActions 的 resolvePresets / 上游 @tag 注入）。
 * editorMinHeight：编辑区最小高（缺省 92=右栏旧观感；中栏工作台传大值走灯箱式布局）。
 */
export function ShotPromptField({ episodeId, shotId, fieldKey, label, shot, presetSchemes, inferring, editorMinHeight = 92 }: {
	episodeId: string;
	shotId: string;
	fieldKey: ShotPromptFieldKey;
	label: string;
	shot: StoryboardShot;
	presetSchemes: PresetScheme[];
	inferring: boolean;
	editorMinHeight?: number | string;
}) {
	const editorRef = useRef<PromptMentionHandle | null>(null);
	const [mention, setMention] = useState<{ x: number; y: number; viaAt: boolean } | null>(null);
	const [importPos, setImportPos] = useState<{ x: number; y: number } | null>(null);
	const [presetPos, setPresetPos] = useState<{ x: number; y: number } | null>(null);
	const update = (patch: Partial<StoryboardShot>) => useProjectStore.getState().updateShot(episodeId, shotId, patch);
	const live = () => useProjectStore.getState().episodes.find((e) => e.id === episodeId)?.shots.find((x) => x.id === shotId);
	const matTags = materialTags(shot.materials);

	return (
		<div style={{ ...secBox, position: "relative" }}>
			<div style={{ ...secTitle, fontSize: 10 }}>
				<span>{label}</span>
				<span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
					{presetSchemes.length > 0 && (
						<button
							title="插入出图预设方案（提交时替换为完整预设词；双击胶囊可展开为可编辑文本）"
							onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setPresetPos(presetPos ? null : { x: r.left, y: r.bottom }); }}
							style={{ padding: "2px 7px", fontSize: 10.5, cursor: "pointer", borderRadius: 6, border: "1px solid rgba(245,158,11,0.4)", background: presetPos ? "rgba(245,158,11,0.22)" : "rgba(245,158,11,0.12)", color: "#fcd34d" }}>
							▦ 预设
						</button>
					)}
					<PromptExpandButton
						title={`${shot.title || "分镜"} · ${label}`}
						getValue={() => live()?.[fieldKey] || ""}
						onSave={(v) => update({ [fieldKey]: v })}
						size={11}
						getExtra={() => <RtcMaterialStrip episodeId={episodeId} shotId={shotId} />}
						getMentions={() => {
							const mats = live()?.materials ?? [];
							const tg = materialTags(mats);
							return mats.map((m) => ({ tag: tg[m.id], name: m.name, uri: m.uri, media: mediaOf(m) }));
						}}
						onImport={(cand) => importAssetToShot(episodeId, shotId, cand)}
						getPresets={presetSchemes.length ? () => presetSchemes : undefined}
						// 第108轮红线：弹窗「匹配资产」永远委托宿主实现（=垫图区「匹配资产」同一函数），以弹窗草稿为本栏提示词
						onMatchAssets={(draft) => matchShotAssets(episodeId, shotId, { field: fieldKey, text: draft })}
					/>
				</span>
			</div>
			<PromptMentionEditor
				ref={(h) => { editorRef.current = h; }}
				value={shot[fieldKey] || ""}
				materials={shot.materials}
				presets={presetSchemes}
				onChange={(text) => update({ [fieldKey]: text })}
				onMentionProbe={(pos) => {
					if (pos) setMention({ x: pos.x, y: pos.y, viaAt: true });
					else setMention((cur) => (cur?.viaAt ? null : cur));
				}}
				onImportProbe={(pos) => setImportPos(pos ? { x: pos.x, y: pos.y } : null)}
				onPasteMedia={(files) => { if (files.length) void addLocalShotMaterials(episodeId, shotId, files); }}
				placeholder={inferring ? "推理中，结果将流式回填…" : "点「推理提示词」生成，或手动填写；输入 @ 引用素材、# 导入项目资产"}
				style={{ minHeight: editorMinHeight, width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, color: "#fff", fontSize: 12, padding: "6px 8px", lineHeight: 1.6 }}
			/>
			{/* @ 素材引用待选框（与 Frame161195 同款：选中即光标处插胶囊） */}
			{mention && (
				<>
					<div onClick={() => setMention(null)} style={{ position: "fixed", inset: 0, zIndex: 100150 }} />
					<div style={{ position: "fixed", zIndex: 100151, top: Math.min(mention.y + 4, window.innerHeight - 260), left: Math.max(8, Math.min(mention.x - 110, window.innerWidth - 232)), width: 220, border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, padding: 8, background: "#161b26", maxHeight: 250, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
						{shot.materials.length === 0 ? (
							<div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>本分镜暂无素材，先在垫图区添加</div>
						) : shot.materials.map((m) => (
							<div key={m.id} onMouseDown={(ev) => ev.preventDefault()}
								onClick={() => { const viaAt = mention.viaAt; setMention(null); const tag = materialTags(live()?.materials ?? [])[m.id]; if (tag) editorRef.current?.insertMaterial(tag, viaAt); }}
								style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 6px", borderRadius: 6, cursor: "pointer", fontSize: 12, color: "#e7e7ee" }}
								onMouseEnter={(ev) => (ev.currentTarget.style.background = "rgba(255,255,255,0.06)")}
								onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}>
								<span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 4, background: BADGE_BG[mediaOf(m)], color: "#fff", flexShrink: 0 }}>{matTags[m.id]}</span>
								<span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
							</div>
						))}
					</div>
				</>
			)}
			{/* # 导入项目资产：加入垫图区 + 光标处 @ 引用（# 被吃掉），与 Frame161195 importMention 同链路 */}
			{importPos && (
				<AssetImportDropdown
					pos={importPos}
					onClose={() => setImportPos(null)}
					onPick={(cand) => {
						setImportPos(null);
						const r = importAssetToShot(episodeId, shotId, cand);
						if (r) editorRef.current?.insertMaterial(r.tag, true, r.mat);
					}}
				/>
			)}
			{/* 预设方案下拉：选中即光标处插入预设胶囊（客户端只插标记，展开在提交收口） */}
			{presetPos && presetSchemes.length > 0 && (
				<>
					<div onClick={() => setPresetPos(null)} style={{ position: "fixed", inset: 0, zIndex: 100150 }} />
					<div style={{ position: "fixed", zIndex: 100151, top: Math.min(presetPos.y + 4, window.innerHeight - 320), left: Math.max(8, Math.min(presetPos.x - 140, window.innerWidth - 300)), width: 288, border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, padding: 4, background: "#161b26", maxHeight: 300, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
						{presetSchemes.map((p) => (
							<div key={p.id} onMouseDown={(ev) => ev.preventDefault()}
								onClick={() => { editorRef.current?.insertPreset(p.id, p.name); setPresetPos(null); }}
								style={{ padding: "6px 8px", borderRadius: 6, cursor: "pointer" }}
								onMouseEnter={(ev) => (ev.currentTarget.style.background = "rgba(255,255,255,0.06)")}
								onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}>
								<div style={{ fontSize: 12, color: "#fcd34d", fontWeight: 600 }}>▦ {p.name}</div>
								<div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", marginTop: 2, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{p.body}</div>
							</div>
						))}
					</div>
				</>
			)}
		</div>
	);
}

/* ────────────────────────── 历史结果网格 ────────────────────────── */

export function HistoryGrid({ kind, uris, currentUri, name, onSetCurrent }: {
	kind: "image" | "video";
	uris: string[];
	currentUri?: string;
	name: string;
	onSetCurrent: (u: string) => void;
}) {
	if (uris.length === 0) return null;
	return (
		<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
			{uris.map((u, i) => {
				const isCur = u === currentUri;
				return (
					<div key={`${u}-${i}`} className="group" title={`${name} 记录 ${i + 1}（点击放大查看）`}
						onClick={() => openLightbox({ uri: u, media: kind, name: `${name} ${i + 1}` })}
						style={{ position: "relative", width: 64, height: 44, borderRadius: 6, overflow: "hidden", flexShrink: 0, cursor: "zoom-in", border: isCur ? "1px solid rgba(139,92,246,0.9)" : "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.05)" }}>
						{kind === "video"
							? <video src={u} style={{ width: "100%", height: "100%", objectFit: "cover" }} muted preload="metadata" />
							: <img src={u} style={{ width: "100%", height: "100%", objectFit: "cover" }} draggable={false} />}
						{isCur ? (
							<span style={{ position: "absolute", top: 0, left: 0, fontSize: 9, lineHeight: "13px", padding: "0 4px", background: "rgba(139,92,246,0.9)", color: "#fff", borderBottomRightRadius: 4 }}>当前</span>
						) : (
							<button
								onClick={(e) => { e.stopPropagation(); onSetCurrent(u); }}
								title="设为当前"
								className="hidden group-hover:flex"
								style={{ position: "absolute", inset: "auto 0 0 0", height: 16, alignItems: "center", justifyContent: "center", fontSize: 9, color: "#fff", background: "rgba(0,0,0,0.65)", border: "none", cursor: "pointer" }}
							>设为当前</button>
						)}
					</div>
				);
			})}
		</div>
	);
}
