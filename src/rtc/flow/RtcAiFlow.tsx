/**
 * RtcAiFlow —— 实时剪辑右栏三页签的分步工作台区块（原「AI 生成」子栏拆分而来）：
 *   「剧本」页 = RtcFlowScriptPage：① 剧本编辑 → ② 剧集拆分 → ③ 资产拆分；
 *   「分镜」页 = RtcFlowShotsPage：④ 逐集 智能推理/智能拆分 + 生成占位入轨。
 *
 * 让实时剪辑不依赖资产模式独立完成全套流程：
 *   ① 剧本：折叠摘要（字数/前几行）；⚠ 第251轮需求⑩——正文编辑**不再在右栏窄 textarea**，
 *     「整理剧本」改为在**中栏摊开剧本处理面**（flow/RtcScriptEditorPane，保存才回写）；
 *     右栏两页从此只做「属性选择」：步骤卡 + 各动作按钮；
 *   ② 剧集拆分：本地快拆四模式（episodeSplit）+ catalog「剧集」LLM 模板，重拆覆盖须 confirmDialog；
 *   ③ 资产拆分：runPurpose("script.analyze") 全链（模板与 Frame1693 同数据源；流式进度；断连保护；
 *      mergeApply 落库内挂 attachSplitPresets 预设胶囊）+ 续提；完成显示五类资产计数；
 *   ④ 分镜：逐集卡片——智能推理（整集）/ 智能拆分（只拆原文），运行态派生自 inferTasks；
 *      完成后「生成占位入轨」（复用 rtcShotPlaceholders + rtcStore.commit）。
 * 步骤联动：无剧本 → ②③ 灰态带提示；未拆分 → ④ 引导先拆分。
 *
 * 动作全部在 ./flowActions（复用 Frame1693/161195 的既有链路）；本文件只做 UI 与状态派生。
 * 断连恢复（resumeAnalysisTask）挂在 RtcPropertyPanel 顶层（RTC 模式常驻），不在本文件——
 * 页签切换会卸载本区块，挂这里会丢重连时机。
 */
import { useEffect, useMemo, useState } from "react";
import { useProjectStore } from "@/store/projectStore";
import { useCatalogStore } from "@/store/catalogStore";
import { EPISODE_SPLIT_MODES } from "@/lib/episodeSplit";
import type { VideoEpisode } from "@/services/projectFile";
import { openRtcScriptEditor, useRtcCenterTabStore } from "../panel/rtcCenterTabStore";
import { scriptBrief, episodesBrief } from "./flowCore";
import {
	splitEpisodesFlow, extractAssetsFlow, continueExtractionFlow,
	smartInferEpisode, smartSplitEpisode, appendEpisodeToTimeline,
	type FlowResult,
} from "./flowActions";

/* ── 局部样式（与子栏既有观感一致） ── */
const cardStyle: React.CSSProperties = { padding: 12, borderRadius: 10, border: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.03)" };
const hintStyle: React.CSSProperties = { fontSize: 11, color: "rgba(255,255,255,0.45)", lineHeight: 1.8 };
const selectStyle: React.CSSProperties = { flex: 1, minWidth: 0, padding: "6px 8px", fontSize: 12, borderRadius: 6, border: "1px solid rgba(255,255,255,0.16)", background: "rgba(255,255,255,0.07)", color: "rgba(255,255,255,0.88)", outline: "none" };
const optStyle: React.CSSProperties = { background: "#1a1a24", color: "#fff" };
const btnStyle = (kind: "primary" | "plain", disabled: boolean): React.CSSProperties => ({
	padding: "7px 14px", fontSize: 12, borderRadius: 7, whiteSpace: "nowrap",
	cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1,
	border: kind === "primary" ? "1px solid rgba(139,92,246,0.6)" : "1px solid rgba(255,255,255,0.16)",
	background: kind === "primary" ? "rgba(139,92,246,0.24)" : "rgba(255,255,255,0.07)",
	color: kind === "primary" ? "#d6c8ff" : "rgba(255,255,255,0.88)",
});

/** 步骤壳：编号 + 标题 + 右侧状态角标；disabled=灰态（内容仍渲染，交互由子组件禁用） */
function StepCard({ n, title, chip, disabled, children }: { n: number; title: string; chip?: string; disabled?: boolean; children: React.ReactNode }) {
	return (
		<div style={{ ...cardStyle, opacity: disabled ? 0.55 : 1 }}>
			<div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
				<span style={{ width: 18, height: 18, flexShrink: 0, borderRadius: "50%", background: "rgba(139,92,246,0.28)", color: "#d6c8ff", fontSize: 11, display: "inline-flex", alignItems: "center", justifyContent: "center", alignSelf: "center" }}>{n}</span>
				<span style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>{title}</span>
				{chip && <span style={{ marginLeft: "auto", fontSize: 10, color: "rgba(255,255,255,0.45)", whiteSpace: "nowrap" }}>{chip}</span>}
			</div>
			{children}
		</div>
	);
}

/** 动作结果内联显示（成功=绿、失败=红；点击可关闭） */
function ResultLine({ res, onClose }: { res: FlowResult | null; onClose: () => void }) {
	if (!res || !res.message) return null;
	return (
		<div
			onClick={onClose}
			title="点击关闭"
			style={{ marginTop: 8, fontSize: 11, lineHeight: 1.7, cursor: "pointer", whiteSpace: "pre-wrap", color: res.ok ? "#a7f3d0" : "#fca5a5" }}
		>
			{res.message}
		</div>
	);
}

/* ════════════════ ① 剧本 ════════════════ */

function StepScript() {
	const scriptText = useProjectStore((s) => s.scriptText);
	const editing = useRtcCenterTabStore((s) => s.scriptEditorOpen);
	const brief = useMemo(() => scriptBrief(scriptText), [scriptText]);
	return (
		<StepCard n={1} title="剧本" chip={brief.empty ? "未填写" : `${brief.chars} 字`}>
			{brief.empty ? (
				<div style={hintStyle}>还没有剧本——点「整理剧本」在**中栏**摊开大编辑面粘贴全文；后续拆分/提取/推理都以它为源。</div>
			) : (
				<div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", lineHeight: 1.7, overflow: "hidden", textOverflow: "ellipsis" }}>{brief.preview}</div>
			)}
			<button
				style={{ ...btnStyle(brief.empty ? "primary" : "plain", false), marginTop: 8 }}
				title="在中栏摊开剧本处理面（整块大编辑区），保存后回到原来的页"
				onClick={() => openRtcScriptEditor()}
			>
				{editing ? "剧本面已摊开（中栏）" : "整理剧本"}
			</button>
			{editing && <div style={{ ...hintStyle, marginTop: 6 }}>正在中栏编辑——保存后回到工作台/预览。</div>}
		</StepCard>
	);
}

/* ════════════════ ② 剧集拆分 ════════════════ */

/** 本地快拆模式显示名（值=EPISODE_SPLIT_MODES 原值，直接传 splitEpisodes） */
const SPLIT_MODE_LABELS: Record<string, string> = {
	"按第N集": "按「第N集/章/回」标记",
	"按双换行": "按空行（双换行）",
	"n-n": "n-n（逐编号，最细）",
	"n-1": "n-1（逐主编号）",
};

function StepSplit({ hasScript }: { hasScript: boolean }) {
	const episodes = useProjectStore((s) => s.episodes);
	const allTemplates = useCatalogStore((s) => s.catalog?.templates);
	const llmTpls = useMemo(() => (allTemplates ?? []).filter((t) => t.category === "剧集"), [allTemplates]);
	const [mode, setMode] = useState<string>("n-n"); // 默认 n-n（第121轮用户定，与 Frame1693 一致）
	const [busy, setBusy] = useState(false);
	const [res, setRes] = useState<FlowResult | null>(null);
	const brief = useMemo(() => episodesBrief(episodes), [episodes]);
	const disabled = !hasScript || busy;

	const run = async () => {
		if (disabled) return;
		setBusy(true);
		setRes(null);
		try {
			const r = await splitEpisodesFlow(mode);
			if (r.message) setRes(r);
		} finally {
			setBusy(false);
		}
	};

	return (
		<StepCard n={2} title="剧集拆分" chip={brief.hasContent ? `已拆 ${brief.count} 集` : "未拆分"} disabled={!hasScript}>
			{!hasScript ? (
				<div style={hintStyle}>先在第①步填写剧本，再拆分成集。</div>
			) : (
				<>
					<div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
						<select value={mode} onChange={(e) => { setMode(e.target.value); setRes(null); }} style={selectStyle}>
							<optgroup label="快速拆分（本地，不调大模型）">
								{EPISODE_SPLIT_MODES.map((m) => (
									<option key={m} value={m} style={optStyle}>{SPLIT_MODE_LABELS[m] || m}</option>
								))}
							</optgroup>
							{llmTpls.length > 0 && (
								<optgroup label="LLM 模板拆分">
									{llmTpls.map((t) => (
										<option key={t.id} value={t.id} style={optStyle}>{t.name}</option>
									))}
								</optgroup>
							)}
						</select>
						<button style={btnStyle("primary", disabled)} disabled={disabled} onClick={() => void run()}>
							{busy ? "拆分中…" : brief.hasContent ? "重新拆分" : "拆分"}
						</button>
					</div>
					{brief.hasContent && (
						<div style={{ ...hintStyle, marginTop: 6 }}>
							已拆 {brief.count} 集{brief.shotCount ? `（含 ${brief.shotCount} 个分镜）` : ""}——重新拆分将整体覆盖（会弹确认）。
						</div>
					)}
					<ResultLine res={res} onClose={() => setRes(null)} />
				</>
			)}
		</StepCard>
	);
}

/* ════════════════ ③ 资产拆分 ════════════════ */

function StepExtract({ hasScript }: { hasScript: boolean }) {
	const running = useProjectStore((s) => s.analysisRunning);
	const progress = useProjectStore((s) => s.analysisProgress);
	const isAnalyzed = useProjectStore((s) => s.isAnalyzed);
	const nChars = useProjectStore((s) => (s.characters || []).length);
	const nScenes = useProjectStore((s) => (s.scenes || []).length);
	const nItems = useProjectStore((s) => (s.items || []).length);
	const nOrgs = useProjectStore((s) => (s.organisms || []).length);
	const nCrowds = useProjectStore((s) => (s.crowds || []).length);
	const total = nChars + nScenes + nItems + nOrgs + nCrowds;

	// 模板：与 Frame1693 同数据源（catalog purpose=script.analyze，排除内部；默认 isDefault 优先）
	const allTemplates = useCatalogStore((s) => s.catalog?.templates);
	const extractTpls = useMemo(
		() => (allTemplates ?? []).filter((t) => t.purpose === "script.analyze" && t.category !== "内部"),
		[allTemplates],
	);
	const [tplId, setTplId] = useState("");
	useEffect(() => {
		if (extractTpls.length === 0) { setTplId(""); return; }
		if (!extractTpls.some((t) => t.id === tplId)) {
			setTplId((extractTpls.find((t) => t.isDefault) ?? extractTpls[0]).id);
		}
	}, [extractTpls, tplId]);

	const [res, setRes] = useState<FlowResult | null>(null);
	const runExtract = async () => {
		setRes(null);
		setRes(await extractAssetsFlow(tplId));
	};
	const runContinue = async () => {
		setRes(null);
		setRes(await continueExtractionFlow(tplId));
	};
	const busy = running;
	const disabled = !hasScript || busy || !tplId;

	return (
		<StepCard n={3} title="资产拆分" chip={busy ? "提取中…" : total > 0 ? `${total} 个资产` : "未提取"} disabled={!hasScript}>
			{!hasScript ? (
				<div style={hintStyle}>先在第①步填写剧本，再提取角色/场景等资产。</div>
			) : (
				<>
					<div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
						<select value={tplId} onChange={(e) => { setTplId(e.target.value); setRes(null); }} disabled={busy} style={selectStyle}>
							{extractTpls.length === 0 ? (
								<option value="" style={optStyle}>无可用模板（需管理端配置并连接）</option>
							) : (
								extractTpls.map((t) => (
									<option key={t.id} value={t.id} style={optStyle}>{t.name}{t.isDefault ? "（默认）" : ""}</option>
								))
							)}
						</select>
						<button style={btnStyle("primary", disabled)} disabled={disabled} onClick={() => void runExtract()}>
							{busy ? "提取中…" : isAnalyzed ? "重新提取" : "开始拆分"}
						</button>
						<button
							style={btnStyle("plain", disabled || !isAnalyzed)}
							disabled={disabled || !isAnalyzed}
							title="把已提取资产作查重清单喂回模型，只补新增、不重复、不覆盖已有；可反复点击直到提示无新增"
							onClick={() => void runContinue()}
						>
							继续提取
						</button>
					</div>
					{busy && (
						<div style={{ marginTop: 8 }}>
							<div style={{ height: 4, borderRadius: 2, background: "rgba(255,255,255,0.1)", overflow: "hidden" }}>
								<div style={{ height: "100%", width: `${progress}%`, borderRadius: 2, background: "linear-gradient(90deg,#7c3aed,#8b5cf6)", transition: "width .3s" }} />
							</div>
							<div style={{ ...hintStyle, marginTop: 4 }}>提取中（流式落库，提取一个并入一个）… {progress}%</div>
						</div>
					)}
					{total > 0 && (
						<div style={{ ...hintStyle, marginTop: 6, color: "rgba(255,255,255,0.6)" }}>
							角色 {nChars} · 场景 {nScenes} · 物品 {nItems} · 生物 {nOrgs} · 群像 {nCrowds}（左侧素材面板可查看/出图）
						</div>
					)}
					<ResultLine res={res} onClose={() => setRes(null)} />
				</>
			)}
		</StepCard>
	);
}

/* ════════════════ ④ 分镜（逐集卡片） ════════════════ */

function EpisodeShotCard({ ep }: { ep: VideoEpisode }) {
	const inferring = useProjectStore((s) => s.inferTasks.some((t) => t.episodeId === ep.id && t.mode === "multi" && t.status === "running"));
	const splitting = useProjectStore((s) => s.inferTasks.some((t) => t.episodeId === ep.id && t.mode === "split" && t.status === "running"));
	const lastError = useProjectStore((s) =>
		s.inferTasks.find((t) => t.episodeId === ep.id && (t.mode === "multi" || t.mode === "split") && t.status === "failed")?.error,
	);
	const locked = inferring || splitting;
	const [res, setRes] = useState<FlowResult | null>(null);
	const [placeMsg, setPlaceMsg] = useState("");

	const onInfer = async () => {
		setRes(null);
		const r = await smartInferEpisode(ep.id);
		if (r.message) setRes(r);
	};
	const onSplit = async () => {
		setRes(null);
		const r = await smartSplitEpisode(ep.id);
		if (r.message) setRes(r);
	};
	// 生成占位入轨：复用既有 rtcShotPlaceholders 逻辑（幂等，一次 commit=一步撤销）
	const onAppend = () => {
		const r = appendEpisodeToTimeline(ep.id);
		if (r) setPlaceMsg(`已添加 ${r.added} 个占位（跳过 ${r.skipped} 个已存在）`);
	};

	return (
		<div style={{ padding: 10, borderRadius: 8, border: "1px solid rgba(255,255,255,0.07)", background: "rgba(255,255,255,0.02)" }}>
			<div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
				<span style={{ fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.9)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ep.title || `第${ep.index}集`}</span>
				<span style={{ marginLeft: "auto", flexShrink: 0, fontSize: 10, color: "rgba(255,255,255,0.45)" }}>
					{locked ? `已出 ${ep.shots.length} 镜…` : ep.shots.length > 0 ? `${ep.shots.length} 镜` : "无分镜"}
				</span>
			</div>
			<div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
				<button style={btnStyle("plain", locked)} disabled={locked} title="整集推理：原文 → 每镜 原文+提示词（流式边出边填）" onClick={() => void onInfer()}>
					{inferring ? "推理中…" : "智能推理"}
				</button>
				<button style={btnStyle("plain", locked)} disabled={locked} title="整集拆分：只拆原文分段，不产提示词" onClick={() => void onSplit()}>
					{splitting ? "拆分中…" : "智能拆分"}
				</button>
				<button
					style={btnStyle("primary", locked || ep.shots.length === 0)}
					disabled={locked || ep.shots.length === 0}
					title="把本集分镜按顺序追加为时间轴占位符（已在轨的自动跳过；已有成片的镜直接落成片片段）"
					onClick={onAppend}
				>
					生成占位入轨
				</button>
			</div>
			{locked && <div style={{ ...hintStyle, marginTop: 6 }}>运行中（切页/重启不丢，可随时回来看进度）…</div>}
			{!locked && lastError && <div style={{ marginTop: 6, fontSize: 11, color: "#fca5a5", lineHeight: 1.6 }}>上次失败：{lastError}</div>}
			{placeMsg && <div style={{ marginTop: 6, fontSize: 11, color: "#a7f3d0" }}>{placeMsg}</div>}
			<ResultLine res={res} onClose={() => setRes(null)} />
		</div>
	);
}

function StepShots() {
	const episodes = useProjectStore((s) => s.episodes);
	const brief = useMemo(() => episodesBrief(episodes), [episodes]);
	return (
		<StepCard n={4} title="分镜" chip={brief.hasContent ? `${brief.count} 集 · ${brief.shotCount} 镜` : "待拆分"} disabled={!brief.hasContent}>
			{!brief.hasContent ? (
				<div style={hintStyle}>先在第②步把剧本拆成分集，再逐集「智能推理/智能拆分」产出分镜；分镜可一键落到时间轴。</div>
			) : (
				<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
					{episodes.map((ep) => <EpisodeShotCard key={ep.id} ep={ep} />)}
				</div>
			)}
		</StepCard>
	);
}

/* ════════════════ 页签区块（RtcPropertyPanel 三页签挂载；页签容器提供滚动，本组件自带内边距） ════════════════ */

/** 「剧本」页：① 剧本编辑 → ② 剧集拆分 → ③ 资产拆分 */
export function RtcFlowScriptPage() {
	const hasScript = useProjectStore((s) => !!(s.scriptText || "").trim());
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "12px 12px 20px" }}>
			<StepScript />
			<StepSplit hasScript={hasScript} />
			<StepExtract hasScript={hasScript} />
		</div>
	);
}

/** 「分镜」页：④ 逐集 智能推理/智能拆分 + 生成占位入轨 */
export function RtcFlowShotsPage() {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "12px 12px 20px" }}>
			<StepShots />
		</div>
	);
}
