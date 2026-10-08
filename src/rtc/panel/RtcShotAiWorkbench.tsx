import { useDualModeFeature } from '@/store/connectionStore';
import { RtcShotGenerationCost } from "./RtcGenerationCost";
import { supportsOfficialMaterials } from "@/services/materialPolicy";
/**
 * RtcShotAiWorkbench —— 中栏「AI 工作台」页正文（中栏双页签改版：工作台/预览，见 rtcCenterTabCore）。
 * 绑定 useWorkbenchTarget（选中优先，无选中回退播放头下主轨片段——补充3；⚠ 第251轮需求⑦：
 * **只要有 shotRef 就能进**，占位变成片后不再丢失工作台），四栏样式按表格模式
 * 分镜行样板（用户定稿；第240轮补充2：**提示词列居左紧邻素材面板、参照列居右**——CSS order 互换）：
 *   - 右上：故事板预览（当前图点击放大 + 历史缩略条「设为当前」）；
 *   - 右下：原文对照（**逐行气泡渲染**：▲/（ 开头=动作行浅灰、「人名：台词」人名着色加粗——
 *     纯逻辑在 lib/scriptBubbles；**锁定只读，右键进入编辑**，保存走 updateShot）；
 *   - 参照列 故事板/原文 分界可上下拖动（本地态 30%–70%，不持久化）；
 *   - 左列：提示词页签与补镜头；画布式胶囊栏选择本分镜模型、线路、方法和视频参数，
 *     预设方案仍由提示词编辑器插入。时长仅写 RTC 当前片段，其余选择写 shot.overrides；
 *     下方 垫图素材区 + 提示词大编辑区 + 动作行；视频结果与任务状态在时间轴查看。
 *
 * 红线（勿回退）：
 *  - 生成/推理只走 shotGenActions（inferShotPrompts/genShotStoryboard）与
 *    timeline/segActions.regenerateShotResult 唯一路径；**落点规则**：占位=原地重跑（swapSegId=自己）、
 *    成片=上方轨道新建占位接新结果（原结果原位保留，与右键「重新生成」完全同一实现）；
 *  - 提示词/原文/素材/覆盖 都是 projectStore.updateShot / shotMaterialOps 语义（不碰 rtcDoc）；
 *  - 目录选项来自 modelOptions，显式时长/比例/分辨率/方法保持原值
 *    （与提交层同一套；本地渠道 ComfyUI/LibTV/即梦 的档位也能取到）；
 *  - 提示词编辑件=shotWorkbenchParts.ShotPromptField（@/#/预设/放大弹窗同一组件，两行头经 renderHeader 接管）。
 * 项目级默认参数在工具栏「视频生成设置」（RtcShotWorkbench）；本页第二行是**本分镜覆盖**，
 * 与表格模式「视频设置（项目级）+ 分镜行（单镜覆盖）」双层语义一致。
 */
import { useEffect, useMemo, useState } from "react";
import { useProjectStore } from "@/store/projectStore";
import { useRtcStore } from "@/store/rtcStore";
import type { RtcSegment } from "@/types/rtc";
import { useCatalogStore } from "@/store/catalogStore";
import { useSettingsStore } from "@/store/settingsStore";
import { openLightbox } from "@/store/lightboxStore";
import { listPresetSchemes } from "@/lib/presetSchemes";
import { splitScriptBubbles, speakerColor } from "@/lib/scriptBubbles";
import { toggleRtcSupplement } from "./rtcSupplementActions";
import { useShotPreparing } from "./rtcShotSubmission";
import { RtcGenerationPicker } from "./RtcGenerationPicker";
import { resolveRtcGenerationDuration } from "./rtcGenerationDuration";
import { patchSegmentDoc } from "./rtcSegUtils";
import { modelMethodsForKey, videoReqOptionsForKey } from "@/lib/modelOptions";
import { useEffectiveModelKey } from "@/components/ModelPicker";
import type { StoryboardShot } from "@/services/projectFile";
import { useWorkbenchTarget } from "./useRtcSelected";
import { RtcMaterialStrip } from "./RtcMaterialStrip";
import { RtcAdjacentFrameButtons } from "./RtcAdjacentFrameButtons";
import { setRtcShotFrameMaterial } from "./rtcFrameMaterialOps";
import { genShotStoryboard } from "./shotGenActions";
import { RtcShotInferenceControls } from "./RtcShotInferenceControls";
import { regenerateShotResult } from "../timeline/segActions";
import { matchShotAssets, type ShotPromptFieldKey } from "./shotMatchActions";
import { JobChips, HistoryGrid, ShotPromptField, WorkbenchRefColumn, useShotJobs, useShotInferring, secTitle, secBox, btnSt } from "./shotWorkbenchParts";

const em = (text: string) => <span style={{ color: "rgba(255,255,255,0.75)" }}>{text}</span>;

/** 无占位符选中时的引导（观感对齐 RtcPropertyPanel.EmptyHint） */
function WorkbenchHint() {
	return (
		<div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
			<div style={{ maxWidth: 460, fontSize: 12, color: "rgba(255,255,255,0.5)", lineHeight: 2 }}>
				<div style={{ fontSize: 13, color: "rgba(255,255,255,0.8)", marginBottom: 6 }}>AI 工作台 · 未选中分镜片段</div>
				在下方时间轴{em("选中一个分镜占位符或分镜成片")}（或把{em("播放头移到它上面")}），这里就是它的生成工作台：
				<br />左侧{em("提示词编辑与垫图")}（紧邻素材面板），右侧{em("故事板预览 + 原文对照")}（原文右键进入编辑），
				一站式 推理提示词 → 生成故事板 → 生成视频。
				<br />{em("已出片的片段也能进")}——提示词/垫图/历史都还在，重跑的新结果会落在**上方新占位**，原成片不动。
				<div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
					处理整集？点击右栏{em("「分镜」页签中的分集名称")}，进入本集原文与分镜表格。
					<br />填入原文、选择推理方案后开始智能推理，分镜会陆续显示，并自动加入时间轴占位。
					<br />生图/生视频的{em("渠道、模型、比例、画质")}等默认要求在下方「视频生成设置」中选择（本页第二行可按分镜覆盖）。
				</div>
			</div>
		</div>
	);
}

/** 原文对照：逐行气泡渲染（动作行浅灰 / 台词行人名着色加粗），右键进入编辑态（textarea + 保存/取消） */
function ScriptCompare({ episodeId, shotId, shot }: { episodeId: string; shotId: string; shot: StoryboardShot }) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const update = (patch: Partial<StoryboardShot>) => useProjectStore.getState().updateShot(episodeId, shotId, patch);
	const bubbles = useMemo(() => splitScriptBubbles(shot.scriptSegment), [shot.scriptSegment]);
	return (
		<div style={{ ...secBox, flex: 1, minHeight: 0, minWidth: 0 }}>
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
					style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, padding: "6px 8px", cursor: "context-menu" }}
				>
					{bubbles.length === 0 ? (
						<span style={{ fontSize: 12, lineHeight: 1.7, color: "rgba(255,255,255,0.35)", userSelect: "text" }}>
							（本分镜暂无原文——右键此处编辑填写）
						</span>
					) : bubbles.map((b, i) => (
						<div key={i}
							style={{
								borderRadius: 8, padding: "5px 8px", fontSize: 12, lineHeight: 1.6, whiteSpace: "pre-wrap", userSelect: "text", flexShrink: 0,
								background: b.kind === "action" ? "rgba(255,255,255,0.035)" : "rgba(255,255,255,0.07)",
								border: "1px solid rgba(255,255,255,0.07)",
								color: b.kind === "action" ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.85)",
							}}>
							{b.kind === "dialogue" ? (
								<><span style={{ color: speakerColor(b.speaker!), fontWeight: 700 }}>{b.speaker}：</span>{b.body}</>
							) : b.body}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

/** 故事板预览：当前图（点击放大）+ 历史缩略条与图片生成进度 */
function StoryboardPreview({ episodeId, shotId, shot }: { episodeId: string; shotId: string; shot: StoryboardShot }) {
	const update = (patch: Partial<StoryboardShot>) => useProjectStore.getState().updateShot(episodeId, shotId, patch);
	const name = `${shot.title || "分镜"}·故事板`;
	const hasImageJobs = useShotJobs(shotId, "storyboard").length > 0;
	return (
		<div style={{ ...secBox, flex: 1, minHeight: 0, minWidth: 0 }}>
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
			{shot.storyboardImages?.length || hasImageJobs ? (
				<div role="group" aria-label="故事板历史与生成进度" style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
					{shot.storyboardImages?.length ? (
						<div style={{ minWidth: 0, maxWidth: "100%", maxHeight: 100, overflowY: "auto" }}>
							<HistoryGrid kind="image" uris={shot.storyboardImages} currentUri={shot.storyboardUri} name={name}
								onSetCurrent={(u) => update({ storyboardUri: u })} />
						</div>
					) : null}
					<JobChips shotId={shotId} field="storyboard" />
				</div>
			) : null}
		</div>
	);
}

/** 参照列（居右）：故事板预览（上）+ 原文气泡（下）——外壳（宽度/order/可拖分界）在共享件
 *  WorkbenchRefColumn（补充5：三栏是工作台基本布局，分镜/自由占位两工作台共用同一壳） */
function RefColumn({ episodeId, shotId, shot }: { episodeId: string; shotId: string; shot: StoryboardShot }) {
	return (
		<WorkbenchRefColumn
			top={<StoryboardPreview episodeId={episodeId} shotId={shotId} shot={shot} />}
			bottom={<ScriptCompare episodeId={episodeId} shotId={shotId} shot={shot} />}
		/>
	);
}

/** 有占位符选中时的工作台正文（key=segId 由外层挂，换选中即重置本地页签态）。
 *  imageSlot=图片占位（genKind image，补充6 普通占位挂分镜后的产物类型）——生成故事板带 swapSegId
 *  （成功即原位替换为图片片段，与视频 swap 同一条 placeholderSwap 机制）。 */
function WorkbenchBody({ episodeId, shotId, segment, imageSlot, isMedia }: { episodeId: string; shotId: string; segment: RtcSegment; imageSlot?: boolean; isMedia?: boolean }) {
	const segId = segment.id;
	const owner = useProjectStore(s => s.projectInstanceId);
	const shot = useProjectStore((s) => s.episodes.find((e) => e.id === episodeId)?.shots.find((x) => x.id === shotId));
	const epTitle = useProjectStore((s) => s.episodes.find((e) => e.id === episodeId)?.title) || "";
	const ms = useProjectStore((s) => s.mediaSettings);
	const dualModeEnabled = useDualModeFeature();
	const sameSource = !dualModeEnabled || (!!ms?.imgVideoSameSource);
	const inferPreparing = useShotPreparing(episodeId, shotId, "infer");
	const inferring = useShotInferring(shotId) || inferPreparing;
	const sbPreparing = useShotPreparing(episodeId, shotId, "storyboard");
	const vidPreparing = useShotPreparing(episodeId, shotId, "video");
	const sbRunning = useShotJobs(shotId, "storyboard").some((p) => p.status === "running");
	const vidRunning = useShotJobs(shotId, "video").some((p) => p.status === "running");
	// 出图预设方案（与 Frame161195 同源：服务端预设库 + 本地自定义，随 catalog 热更）
	const presetCatalogVer = useCatalogStore((s) => s.catalog?.version);
	const customPresets = useSettingsStore((s) => s.customPresets);
	// 非同源模式的提示词小页签（本地态，换选中随 key 重置）
	const [promptTab, setPromptTab] = useState<ShotPromptFieldKey>("storyboardPrompt");
	const [supplementError, setSupplementError] = useState("");
	useEffect(() => {
		if (!supplementError) return;
		const timer = setTimeout(() => setSupplementError(""), 4000);
		return () => clearTimeout(timer);
	}, [supplementError]);
	const presetSchemes = useMemo(() => listPresetSchemes(!sameSource && promptTab === "videoPrompt" ? "video" : "image"), [presetCatalogVer, customPresets, sameSource, promptTab]);
	// 本分镜覆盖 > 项目默认，模型与档位和提交层共用同一来源。
	const effVideoKey = useEffectiveModelKey("video");
	// catalog 版本订阅：档位经 modelOptions 现查（非 hook），catalog 热更后要重算一遍
	const catalogVer = useCatalogStore((s) => s.catalog?.version);
	const curVideoModel = shot?.overrides?.videoModelKey || effVideoKey || "";
	const curMethods = useMemo(() => modelMethodsForKey(curVideoModel), [curVideoModel, catalogVer]);
	const curReq = useMemo(() => videoReqOptionsForKey(curVideoModel), [curVideoModel, catalogVer]);

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

	// ── 「仅本分镜」视频参数（与 Frame161195 分镜行逐项同源；写的字段=提交层 genShotVideo 读的字段）──
	// ⚠ 档位一把尺：modelOptions（catalog 优先、ComfyUI/LibTV/即梦 等本地渠道回退适配器 paramsSchema）
	const ov = shot.overrides || {};
	const curCatModel = useCatalogStore.getState().catalog?.models.find((m) => m.id === curVideoModel);
	const curMethod = ov.method ?? ms.videoMethod ?? curMethods[0];
	const duration = segment.generationDuration ?? ov.duration ?? shot.durationSec ?? ms.maxDuration ?? curReq.durations[0] ?? 15;
	const autoDuration = resolveRtcGenerationDuration("auto", segment.targetDurationUs, curReq.durations, 1);
	const aspect = ov.aspect ?? ms.aspect ?? curReq.aspects[0] ?? "16:9";
	const resolution = ov.resolution ?? ms.resolution ?? curReq.resolutions[0] ?? "720p";
	// 单镜覆盖 setter（与 Frame161195.setShotOverride 同尺）
	const setShotOverride = (patch: Partial<NonNullable<StoryboardShot["overrides"]>>) => {
		const live = useProjectStore.getState().episodes.find(e => e.id === episodeId)?.shots.find(s => s.id === shotId);
		if (!live) return;
		update({ overrides: { ...live.overrides, ...patch } });
	};
	// 补镜头按当前段的时间位置绑定主轨，绑定/编号与保存由同一动作负责。
	const toggleSupplement = () => {
		const result = toggleRtcSupplement({ owner, episodeId, shotId, segId });
		setSupplementError(result.ok ? "" : result.reason);
	};

	return (
		<div style={{ flex: 1, minHeight: 0, display: "flex", gap: 12, padding: 12, overflow: "hidden", position: "relative" }}>
			{/* ── 参照列（居右，order:2 在组件内）：故事板预览（上）+ 原文气泡（下），分界可拖 ── */}
			<RefColumn episodeId={episodeId} shotId={shotId} shot={shot} />

			{/* ── 提示词工作区（order:1 居左，紧邻素材面板——补充2 用户定稿；两行头照表格模式）。
			     第240轮补充：不整列滑动——提示词栏位 fill 吃满剩余高、超长提示词在编辑框内滚动（收起）；
			     overflowY:auto 仅作极小视口的兜底（正常视口各区块恰好填满不出滚条） ── */}
			<div style={{ flex: 1, order: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", gap: 10, overflowY: "auto", paddingRight: 2 }}>
				{/* 头部：分镜身份 */}
				<div style={{ display: "flex", alignItems: "baseline", gap: 8, flexShrink: 0 }}>
					<span style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>{shot.title || "分镜"}</span>
					<span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{epTitle}{shot.durationSec ? ` · ${shot.durationSec}s` : ""} · {isMedia ? "成片（可重跑）" : "占位符"}</span>
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
					<RtcMaterialStrip episodeId={episodeId} shotId={shotId} identityEnabled={supportsOfficialMaterials(curCatModel)}
						rightActions={<RtcAdjacentFrameButtons segId={segId}
							disabled={sbPreparing || vidPreparing}
							onInsert={(frame, edge) => { setRtcShotFrameMaterial(episodeId, shotId, edge, frame, owner); }} />} />
				</div>

				{/* 提示词编辑器保留 @/#/预设/放大；头部使用画布式生成选择栏。 */}
				<ShotPromptField
					key={activeField}
					episodeId={episodeId} shotId={shotId}
					fieldKey={activeField} label={activeLabel}
					shot={shot} presetSchemes={presetSchemes} inferring={inferring}
					fill
					presetLabel="▦ 预设方案"
					presetVariant="pill"
					renderHeader={({ presetBtn, expandBtn }) => (
						<div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
							{/* 提示词模式与分镜标记 */}
							<div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
								{sameSource ? (
									<span title="图视同源：图片与视频共用同一段提示词（视频生成设置中可关闭同源）"
										style={{ fontSize: 11, padding: "3px 10px", borderRadius: 6, border: "1px solid rgba(139,92,246,0.5)", background: "rgba(139,92,246,0.15)", color: "#c4b5fd" }}>同源提示词</span>
								) : (
									<div style={{ display: "inline-flex", borderRadius: 6, overflow: "hidden", border: "1px solid rgba(255,255,255,0.12)", width: "fit-content" }}>
										{(["storyboardPrompt", "videoPrompt"] as const).map((k) => (
											<button key={k} onClick={() => setPromptTab(k)}
												style={{ padding: "4px 10px", fontSize: 11, cursor: "pointer", border: "none", background: promptTab === k ? "rgba(139,92,246,0.35)" : "transparent", color: "#fff" }}>
												{k === "storyboardPrompt" ? "故事板提示词" : "视频提示词"}
											</button>
										))}
									</div>
								)}
								<button title="补镜头：绑定当前时间位置的主轨分镜；再次点击恢复独立分镜"
									onClick={toggleSupplement}
									style={{ padding: "3px 8px", fontSize: 11, cursor: "pointer", borderRadius: 6, border: shot.isSupplement ? "1px solid rgba(245,196,81,0.7)" : "1px solid rgba(255,255,255,0.18)", background: shot.isSupplement ? "rgba(245,196,81,0.18)" : "transparent", color: shot.isSupplement ? "#f5c451" : "rgba(255,255,255,0.7)" }}>补镜头</button>
								<RtcShotInferenceControls key={`${owner}:${episodeId}:${shotId}`} episodeId={episodeId} shotId={shotId} busy={inferring} />
							</div>
							<RtcGenerationPicker
								modelKey={curVideoModel} onModelChange={videoModelKey => setShotOverride({ videoModelKey })}
								method={curMethod} methods={curMethods} onMethodChange={method => setShotOverride({ method })}
								duration={duration} autoDuration={autoDuration} aspect={aspect} resolution={resolution} requirements={curReq}
								onParamsChange={({ duration: nextDuration, ...patch }) => {
									if (nextDuration !== undefined) useRtcStore.getState().commitActive(doc => patchSegmentDoc(doc, segId, { generationDuration: nextDuration }));
									if (Object.keys(patch).length) setShotOverride(patch);
								}}
							>
								{presetBtn}
								<span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center" }}>{expandBtn}</span>
							</RtcGenerationPicker>
						</div>
					)}
				/>

				{/* 生成动作；图片进度在右侧故事板历史区，视频状态与结果在时间轴。 */}
				<div style={{ ...secBox, flexShrink: 0 }}>
					<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
						<button style={btnSt("plain", sbRunning || sbPreparing)} disabled={sbRunning || sbPreparing}
							title={(shot.storyboardUri ? "重新生成故事板图（新结果加入历史）" : "按提示词生成故事板图") + (imageSlot ? (isMedia ? "；成功后落在**上方新占位**，原结果原位保留" : "；成功后本图片占位自动替换为图片片段") : "")}
							onClick={() => void (imageSlot ? regenerateShotResult(segId, "storyboard") : genShotStoryboard(episodeId, shotId))}>
							{sbPreparing ? "准备中…" : sbRunning ? "生成中…" : shot.storyboardUri ? "重新生成故事板" : "生成故事板"}
							{!sbPreparing && !sbRunning && <RtcShotGenerationCost shot={shot} field="storyboard" segment={segment} />}
						</button>
						<button style={btnSt("primary", vidRunning || vidPreparing)} disabled={vidRunning || vidPreparing}
							title={isMedia
								? "重新生成视频：新结果落在**上方新占位**，本成片原位保留（上下层即版本堆叠）"
								: shot.videoUri ? "重新生成视频（新结果加入历史；成功后替换本占位符）" : "生成视频（成功后本占位符自动替换为视频片段）"}
							onClick={() => void regenerateShotResult(segId, "video")}>
							{vidPreparing ? "准备中…" : vidRunning ? "生成中…" : isMedia || shot.videoUri ? "重新生成视频" : "生成视频"}
							{!vidPreparing && !vidRunning && <RtcShotGenerationCost shot={shot} field="video" segment={segment} />}
						</button>
					</div>
				</div>
			</div>
			{supplementError && <div role="status" style={{ position: "absolute", bottom: 18, left: "50%", transform: "translateX(-50%)", maxWidth: "90%", padding: "8px 12px", borderRadius: 7, background: "#382b23", border: "1px solid #72503a", color: "#ffd6b6", fontSize: 11, zIndex: 10, pointerEvents: "none" }}>{supplementError}</div>}
		</div>
	);
}

/**
 * 中栏「AI 工作台」页：绑定 useWorkbenchTarget（选中优先，无选中回退播放头下主轨片段）。
 * ⚠ 第251轮需求⑦：绑定条件是「**有 shotRef**」而不是「是占位符」——占位变成片后
 *   shotRef 原样保留，工作台数据（原文/提示词/垫图/历史）一直都在，只是以前没给入口，
 *   用户就「出错了连修改的方案都没有」。成片上重跑走 regenerateShotResult（新结果落上方新占位）。
 * 无目标（时间轴空 / 播放头在纯素材片段或空白上且无选中）才显示引导。
 */
export function RtcShotAiWorkbench() {
	const target = useWorkbenchTarget();
	const ref = target?.seg.shotRef;
	if (!target || !ref) return <WorkbenchHint />;
	const imageSlot = (target.seg.genKind ?? target.seg.media) === "image";
	const isMedia = target.seg.kind === "media";
	return (
		<WorkbenchBody
			key={target.seg.id}
			episodeId={ref.episodeId}
			shotId={ref.shotId}
			segment={target.seg}
			imageSlot={imageSlot}
			isMedia={isMedia}
		/>
	);
}
