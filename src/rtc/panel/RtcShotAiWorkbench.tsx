/**
 * RtcShotAiWorkbench —— 中栏「AI 工作台」页正文（中栏双页签改版：工作台/预览，见 rtcCenterTabCore）。
 * 绑定时间轴当前选中的「分镜占位符」（placeholder+shotRef，useRtcSelected），三栏布局参考表格模式视频界面：
 *   - 左上：故事板预览（当前图点击放大 + 历史缩略条「设为当前」）；
 *   - 左下：原文对照（**锁定只读，右键进入编辑**——用户定稿；保存走 updateShot）；
 *   - 右列：提示词工作区（观感参考提示词放大编辑灯箱 PromptModal）——垫图素材区（RtcMaterialStrip +
 *     匹配资产）在上，提示词大编辑区在下（同源=单栏「同源提示词」；否则「故事板提示词/视频提示词」
 *     小页签切换），底部动作行（推理提示词/生成故事板/生成视频）+ 在途 chips + 视频历史。
 *
 * 红线（勿回退）：
 *  - 生成/推理只走 shotGenActions（inferShotPrompts/genShotStoryboard/genShotVideo）唯一路径，
 *    生成视频带 swapSegId=当前占位符 id（成功原位替换）；
 *  - 提示词/原文/素材都是 projectStore.updateShot / shotMaterialOps 语义（不碰 rtcDoc）；
 *  - 提示词编辑件=shotWorkbenchParts.ShotPromptField（与右栏旧版同一套 @/#/预设/放大弹窗行为，只搬家）。
 * 参数选择（渠道/模型/比例/画质等）不在本页——在右栏「属性」页（RtcShotWorkbench「AI 生成属性」）。
 */
import { useMemo, useState } from "react";
import { useProjectStore } from "@/store/projectStore";
import { useCatalogStore } from "@/store/catalogStore";
import { useSettingsStore } from "@/store/settingsStore";
import { openLightbox } from "@/store/lightboxStore";
import { listPresetSchemes } from "@/lib/presetSchemes";
import type { StoryboardShot } from "@/services/projectFile";
import { useRtcSelected } from "./useRtcSelected";
import { RtcMaterialStrip } from "./RtcMaterialStrip";
import { inferShotPrompts, genShotStoryboard, genShotVideo } from "./shotGenActions";
import { matchShotAssets, type ShotPromptFieldKey } from "./shotMatchActions";
import { JobChips, HistoryGrid, ShotPromptField, useShotJobs, useShotInferring, secTitle, secBox, btnSt } from "./shotWorkbenchParts";

const em = (text: string) => <span style={{ color: "rgba(255,255,255,0.75)" }}>{text}</span>;

/** 无占位符选中时的引导（观感对齐 RtcPropertyPanel.EmptyHint） */
function WorkbenchHint() {
	return (
		<div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
			<div style={{ maxWidth: 460, fontSize: 12, color: "rgba(255,255,255,0.5)", lineHeight: 2 }}>
				<div style={{ fontSize: 13, color: "rgba(255,255,255,0.8)", marginBottom: 6 }}>AI 工作台 · 未选中分镜占位符</div>
				在下方时间轴{em("选中一个分镜占位符")}，这里就是它的生成工作台：
				<br />左侧{em("故事板预览 + 原文对照")}（原文右键进入编辑），右侧{em("提示词编辑与垫图")}，
				一站式 推理提示词 → 生成故事板 → 生成视频（成片自动替换占位符）。
				<div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
					还没有占位符？在右栏{em("「剧本」页签")}：①编辑剧本 → ②剧集拆分 → ③资产拆分；
					<br />再到{em("「分镜」页签")}：④逐集智能推理/智能拆分，点「生成占位入轨」把分镜铺上时间轴。
					<br />生图/生视频的{em("渠道、模型、比例、画质")}等要求在右栏「属性」页选择。
				</div>
			</div>
		</div>
	);
}

/** 原文对照：锁定只读（滚动），右键进入编辑态（textarea + 保存/取消；保存走 updateShot） */
function ScriptCompare({ episodeId, shotId, shot }: { episodeId: string; shotId: string; shot: StoryboardShot }) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const update = (patch: Partial<StoryboardShot>) => useProjectStore.getState().updateShot(episodeId, shotId, patch);
	return (
		<div style={{ ...secBox, flex: "1 1 42%", minHeight: 0 }}>
			<div style={secTitle}>
				<span>原文对照 <span style={{ color: "rgba(255,255,255,0.32)" }}>（锁定 · 右键编辑）</span></span>
				{editing && (
					<span style={{ display: "inline-flex", gap: 4 }}>
						<button style={{ ...btnSt("primary"), flex: "none", padding: "2px 10px", fontSize: 10.5 }}
							onClick={() => { update({ scriptSegment: draft }); setEditing(false); }}>保存</button>
						<button style={{ ...btnSt("plain"), flex: "none", padding: "2px 10px", fontSize: 10.5 }}
							onClick={() => setEditing(false)}>取消</button>
					</span>
				)}
			</div>
			{editing ? (
				<textarea
					value={draft}
					autoFocus
					onChange={(e) => setDraft(e.target.value)}
					style={{ flex: 1, minHeight: 0, width: "100%", resize: "none", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(139,92,246,0.5)", borderRadius: 6, color: "#fff", padding: "6px 8px", fontSize: 12, lineHeight: 1.7, outline: "none" }}
				/>
			) : (
				<div
					title="本分镜对应的原始剧本文本（只读对照）——右键进入编辑"
					onContextMenu={(e) => { e.preventDefault(); setDraft(shot.scriptSegment || ""); setEditing(true); }}
					style={{ flex: 1, minHeight: 0, overflowY: "auto", whiteSpace: "pre-wrap", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, color: shot.scriptSegment ? "rgba(255,255,255,0.82)" : "rgba(255,255,255,0.35)", padding: "6px 8px", fontSize: 12, lineHeight: 1.7, cursor: "context-menu", userSelect: "text" }}
				>
					{shot.scriptSegment || "（本分镜暂无原文——右键此处编辑填写）"}
				</div>
			)}
		</div>
	);
}

/** 故事板预览：当前图（点击放大）+ 历史缩略条（设为当前） */
function StoryboardPreview({ episodeId, shotId, shot }: { episodeId: string; shotId: string; shot: StoryboardShot }) {
	const update = (patch: Partial<StoryboardShot>) => useProjectStore.getState().updateShot(episodeId, shotId, patch);
	const name = `${shot.title || "分镜"}·故事板`;
	return (
		<div style={{ ...secBox, flex: "1 1 58%", minHeight: 0 }}>
			<div style={secTitle}><span>故事板预览{shot.storyboardImages?.length ? `（历史 ${shot.storyboardImages.length}）` : ""}</span></div>
			<div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, overflow: "hidden" }}>
				{shot.storyboardUri ? (
					<img
						key={shot.storyboardUri}
						src={shot.storyboardUri}
						onClick={() => openLightbox({ uri: shot.storyboardUri!, media: "image", name })}
						style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", cursor: "zoom-in" }}
					/>
				) : (
					<span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", padding: 12, textAlign: "center", lineHeight: 1.8 }}>
						尚未生成故事板<br />在右侧填好提示词后点「生成故事板」
					</span>
				)}
			</div>
			{shot.storyboardImages?.length ? (
				<div style={{ flexShrink: 0, maxHeight: 100, overflowY: "auto" }}>
					<HistoryGrid kind="image" uris={shot.storyboardImages} currentUri={shot.storyboardUri} name={name}
						onSetCurrent={(u) => update({ storyboardUri: u })} />
				</div>
			) : null}
		</div>
	);
}

/** 有占位符选中时的工作台正文（key=segId 由外层挂，换选中即重置本地页签态） */
function WorkbenchBody({ episodeId, shotId, segId }: { episodeId: string; shotId: string; segId: string }) {
	const shot = useProjectStore((s) => s.episodes.find((e) => e.id === episodeId)?.shots.find((x) => x.id === shotId));
	const epTitle = useProjectStore((s) => s.episodes.find((e) => e.id === episodeId)?.title) || "";
	const sameSource = useProjectStore((s) => !!s.mediaSettings?.imgVideoSameSource);
	const inferring = useShotInferring(shotId);
	const sbRunning = useShotJobs(shotId, "storyboard").some((p) => p.status === "running");
	const vidRunning = useShotJobs(shotId, "video").some((p) => p.status === "running");
	// 出图预设方案（与 Frame161195 同源：服务端预设库 + 本地自定义，随 catalog 热更）
	const presetCatalogVer = useCatalogStore((s) => s.catalog?.version);
	const customPresets = useSettingsStore((s) => s.customPresets);
	const presetSchemes = useMemo(() => listPresetSchemes(), [presetCatalogVer, customPresets]);
	// 非同源模式的提示词小页签（本地态，换选中随 key 重置）
	const [promptTab, setPromptTab] = useState<ShotPromptFieldKey>("storyboardPrompt");

	if (!shot) {
		return (
			<div style={{ padding: 24, fontSize: 12, color: "rgba(255,255,255,0.5)", lineHeight: 1.8 }}>
				该占位符关联的分镜已被删除。可在时间轴上删除此占位符，或回到视频界面重建分镜。
			</div>
		);
	}
	const update = (patch: Partial<StoryboardShot>) => useProjectStore.getState().updateShot(episodeId, shotId, patch);
	// 提示词栏位：同源=单栏 unifiedPrompt；双结果=故事板/视频小页签（一次只显示一栏，编辑区给大）
	const activeField: ShotPromptFieldKey = sameSource ? "unifiedPrompt" : promptTab;
	const activeLabel = sameSource
		? "同源提示词（图片与视频共用）"
		: promptTab === "storyboardPrompt" ? "故事板提示词" : "视频提示词";

	return (
		<div style={{ flex: 1, minHeight: 0, display: "flex", gap: 12, padding: 12, overflow: "hidden" }}>
			{/* ── 左列：故事板预览（上）+ 原文对照（下，锁定右键编辑） ── */}
			<div style={{ flex: "0 0 300px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
				<StoryboardPreview episodeId={episodeId} shotId={shotId} shot={shot} />
				<ScriptCompare episodeId={episodeId} shotId={shotId} shot={shot} />
			</div>

			{/* ── 右列：提示词工作区（灯箱式大编辑区）── */}
			<div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", gap: 10, overflowY: "auto", paddingRight: 2 }}>
				{/* 头部：分镜身份 + 推理 */}
				<div style={{ display: "flex", alignItems: "baseline", gap: 8, flexShrink: 0 }}>
					<span style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>{shot.title || "分镜"}</span>
					<span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{epTitle}{shot.durationSec ? ` · ${shot.durationSec}s` : ""} · 占位符</span>
					<span style={{ flex: 1 }} />
					<button style={{ ...btnSt("plain", inferring), flex: "none", padding: "3px 10px", fontSize: 11 }} disabled={inferring}
						title="对本分镜单卡推理：按原文产出提示词（覆盖当前提示词）"
						onClick={() => void inferShotPrompts(episodeId, shotId)}>
						{inferring ? "推理中…" : "推理提示词"}
					</button>
				</div>

				{/* 垫图素材区（标题行带「匹配资产」——与资产模式「提取资产」同一逻辑） */}
				<div style={{ ...secBox, flexShrink: 0 }}>
					<div style={secTitle}>
						<span>垫图素材（{shot.materials.length}）</span>
						<button style={{ ...btnSt("plain"), flex: "none", padding: "3px 10px", fontSize: 11 }}
							title="匹配资产：扫 原文分段+提示词，命中项目资产（角色/群像/场景/生物/物品）自动加入垫图并写素材图例；角色带音色的同时加入声音参考。用图优先资产助手/分体选择的当前选中造型。"
							onClick={() => {
								if (!matchShotAssets(episodeId, shotId)) alert("未在该分镜原文/提示词中匹配到资产，且素材区为空——无可提取的素材。");
							}}>
							匹配资产
						</button>
					</div>
					<RtcMaterialStrip episodeId={episodeId} shotId={shotId} />
				</div>

				{/* 提示词页签行：同源=单标签；双结果=故事板/视频切换 */}
				<div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
					{sameSource ? (
						<span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 6, border: "1px solid rgba(139,92,246,0.5)", background: "rgba(139,92,246,0.15)", color: "#c4b5fd" }}>同源提示词</span>
					) : (
						(["storyboardPrompt", "videoPrompt"] as const).map((k) => {
							const active = promptTab === k;
							return (
								<button key={k} onClick={() => setPromptTab(k)}
									style={{ fontSize: 11, padding: "3px 12px", borderRadius: 6, cursor: "pointer", border: active ? "1px solid rgba(139,92,246,0.6)" : "1px solid rgba(255,255,255,0.12)", background: active ? "rgba(139,92,246,0.2)" : "rgba(255,255,255,0.04)", color: active ? "#d6c8ff" : "rgba(255,255,255,0.55)" }}>
									{k === "storyboardPrompt" ? "故事板提示词" : "视频提示词"}
								</button>
							);
						})
					)}
					<span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)" }}>
						{sameSource ? "图片与视频共用一段（右栏属性页可关闭同源）" : "生图用故事板提示词，生视频用视频提示词"}
					</span>
				</div>

				{/* 提示词大编辑区（ShotPromptField：@/#/预设/放大弹窗全套，与右栏旧版同一组件只搬家） */}
				<ShotPromptField
					key={activeField}
					episodeId={episodeId} shotId={shotId}
					fieldKey={activeField} label={activeLabel}
					shot={shot} presetSchemes={presetSchemes} inferring={inferring}
					editorMinHeight="36vh"
				/>

				{/* 动作行 + 在途 chips */}
				<div style={{ ...secBox, flexShrink: 0 }}>
					<div style={{ display: "flex", gap: 6 }}>
						<button style={btnSt("plain", sbRunning)} disabled={sbRunning}
							title={shot.storyboardUri ? "重新生成故事板图（新结果加入历史）" : "按提示词生成故事板图"}
							onClick={() => void genShotStoryboard(episodeId, shotId)}>
							{sbRunning ? "生成中…" : shot.storyboardUri ? "重新生成故事板" : "生成故事板"}
						</button>
						<button style={btnSt("primary", vidRunning)} disabled={vidRunning}
							title={shot.videoUri ? "重新生成视频（新结果加入历史；成功后替换本占位符）" : "生成视频（成功后本占位符自动替换为视频片段）"}
							onClick={() => void genShotVideo(episodeId, shotId, { swapSegId: segId })}>
							{vidRunning ? "生成中…" : shot.videoUri ? "重新生成视频" : "生成视频"}
						</button>
					</div>
					<JobChips shotId={shotId} field="storyboard" />
					<JobChips shotId={shotId} field="video" />
				</div>

				{/* 视频历史 */}
				{shot.videoUris?.length ? (
					<div style={{ ...secBox, flexShrink: 0 }}>
						<div style={{ ...secTitle, fontSize: 10 }}><span>视频历史（{shot.videoUris.length}）</span></div>
						<HistoryGrid kind="video" uris={shot.videoUris} currentUri={shot.videoUri} name={`${shot.title || "分镜"}·视频`}
							onSetCurrent={(u) => update({ videoUri: u, videoActiveKey: `u:${u}` })} />
					</div>
				) : null}
			</div>
		</div>
	);
}

/** 中栏「AI 工作台」页：绑定时间轴当前选中的分镜占位符；无则引导 */
export function RtcShotAiWorkbench() {
	const sel = useRtcSelected();
	const isShotPh = !!(sel && sel.seg.kind === "placeholder" && sel.seg.shotRef);
	if (!isShotPh) return <WorkbenchHint />;
	const ref = sel!.seg.shotRef!;
	return <WorkbenchBody key={sel!.seg.id} episodeId={ref.episodeId} shotId={ref.shotId} segId={sel!.seg.id} />;
}
