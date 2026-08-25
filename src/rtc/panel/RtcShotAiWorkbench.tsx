/**
 * RtcShotAiWorkbench —— 中栏「AI 工作台」页正文（中栏双页签改版：工作台/预览，见 rtcCenterTabCore）。
 * 绑定 useWorkbenchTarget（选中优先，无选中回退播放头下主轨片段——补充3；⚠ 第251轮需求⑦：
 * **只要有 shotRef 就能进**，占位变成片后不再丢失工作台），四栏样式按表格模式
 * 分镜行样板（用户定稿；第240轮补充2：**提示词列居左紧邻素材面板、参照列居右**——CSS order 互换）：
 *   - 右上：故事板预览（当前图点击放大 + 历史缩略条「设为当前」）；
 *   - 右下：原文对照（**逐行气泡渲染**：▲/（ 开头=动作行浅灰、「人名：台词」人名着色加粗——
 *     纯逻辑在 lib/scriptBubbles；**锁定只读，右键进入编辑**，保存走 updateShot）；
 *   - 参照列 故事板/原文 分界可上下拖动（本地态 30%–70%，不持久化）；
 *   - 左列：提示词工作区——**两行头照抄表格模式**（Frame161195 分镜行 1768-1850 行同构）：
 *     第一行 = 提示词页签（同源胶囊/故事板|视频切换）+ ▦预设方案 + 补镜头（重排编号走 lib/shotReindex，
 *     与表格模式/inferRun 共用同一纯函数）；
 *     第二行 = **仅本分镜**的视频参数 mini selects（方法→时长/比例/分辨率→真人图→行尾放大按钮）
 *     ——写 shot.overrides/durationSec，与提交层 shotGenActions.genShotVideo 读的字段一一对应
 *     （method/aspect/resolution/officialAssetIndexes + durationSec）；
 *     ⚠ **第251轮：模型选择只在右栏属性页**（本行原有的 家族/线路/模型 三下拉与右栏重复且冲突，
 *       已删除；`overrides.videoModelKey` 的**读取链保留**，存量项目里设过的单镜模型照旧生效）；
 *     下方 垫图素材区 + 提示词大编辑区 + 动作行 + 视频历史。
 *
 * 红线（勿回退）：
 *  - 生成/推理只走 shotGenActions（inferShotPrompts/genShotStoryboard）与
 *    timeline/segActions.regenerateShotResult 唯一路径；**落点规则**：占位=原地重跑（swapSegId=自己）、
 *    成片=上方轨道新建占位接新结果（原结果原位保留，与右键「重新生成」完全同一实现）；
 *  - 提示词/原文/素材/覆盖 都是 projectStore.updateShot / shotMaterialOps 语义（不碰 rtcDoc）；
 *  - 档位收敛一把尺：modelOptions.videoReqOptionsForKey/modelMethodsForKey + clampToOptions/clampDurationTo/clampMethod
 *    （与提交层同一套；本地渠道 ComfyUI/LibTV/即梦 的档位也能取到）；
 *  - 提示词编辑件=shotWorkbenchParts.ShotPromptField（@/#/预设/放大弹窗同一组件，两行头经 renderHeader 接管）。
 * 项目级默认参数仍在右栏「属性」页（RtcShotWorkbench「AI 生成属性」）；本页第二行是**本分镜覆盖**，
 * 与表格模式「视频设置（项目级）+ 分镜行 mini selects（单镜覆盖）」双层语义一致。
 */
import { useMemo, useState } from "react";
import { useProjectStore } from "@/store/projectStore";
import { useCatalogStore } from "@/store/catalogStore";
import { useSettingsStore } from "@/store/settingsStore";
import { openLightbox } from "@/store/lightboxStore";
import { listPresetSchemes } from "@/lib/presetSchemes";
import { splitScriptBubbles, speakerColor } from "@/lib/scriptBubbles";
import { reindexShots } from "@/lib/shotReindex";
import { clampDuration } from "@/lib/genParams";
import { METHOD_LABELS, clampMethod, clampToOptions, clampDurationTo } from "@/lib/videoMethods";
import { modelMethodsForKey, videoReqOptionsForKey } from "@/lib/modelOptions";
import { mediaOf } from "@/lib/shotMaterials";
import { useEffectiveModelKey } from "@/components/ModelPicker";
import type { StoryboardShot } from "@/services/projectFile";
import { useWorkbenchTarget } from "./useRtcSelected";
import { RtcMaterialStrip } from "./RtcMaterialStrip";
import { inferShotPrompts, genShotStoryboard } from "./shotGenActions";
import { regenerateShotResult } from "../timeline/segActions";
import { matchShotAssets, type ShotPromptFieldKey } from "./shotMatchActions";
import { JobChips, HistoryGrid, ShotPromptField, WorkbenchRefColumn, useShotJobs, useShotInferring, secTitle, secBox, btnSt } from "./shotWorkbenchParts";

const em = (text: string) => <span style={{ color: "rgba(255,255,255,0.75)" }}>{text}</span>;

/* mini select 观感照抄表格模式 Frame161195（紧凑窄下拉；第二行「仅本分镜」参数用） */
const miniSel: React.CSSProperties = { background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 5, color: "#fff", fontSize: 10, padding: "2px 4px", outline: "none", cursor: "pointer", maxWidth: 110, appearance: "none", WebkitAppearance: "none", MozAppearance: "none" as React.CSSProperties["MozAppearance"], textAlignLast: "center" };
const miniOpt: React.CSSProperties = { background: "#1f1f2e" };

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
					还没有占位符？在右栏{em("「剧本」页签")}：①编辑剧本 → ②剧集拆分 → ③资产拆分；
					<br />再到{em("「分镜」页签")}：④逐集智能推理/智能拆分，点「生成占位入轨」把分镜铺上时间轴。
					<br />生图/生视频的{em("渠道、模型、比例、画质")}等默认要求在右栏「属性」页选择（本页第二行可按分镜覆盖）。
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

/** 故事板预览：当前图（点击放大）+ 历史缩略条（设为当前） */
function StoryboardPreview({ episodeId, shotId, shot }: { episodeId: string; shotId: string; shot: StoryboardShot }) {
	const update = (patch: Partial<StoryboardShot>) => useProjectStore.getState().updateShot(episodeId, shotId, patch);
	const name = `${shot.title || "分镜"}·故事板`;
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
			{shot.storyboardImages?.length ? (
				<div style={{ flexShrink: 0, maxHeight: 100, overflowY: "auto" }}>
					<HistoryGrid kind="image" uris={shot.storyboardImages} currentUri={shot.storyboardUri} name={name}
						onSetCurrent={(u) => update({ storyboardUri: u })} />
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
function WorkbenchBody({ episodeId, shotId, segId, imageSlot, isMedia }: { episodeId: string; shotId: string; segId: string; imageSlot?: boolean; isMedia?: boolean }) {
	const shot = useProjectStore((s) => s.episodes.find((e) => e.id === episodeId)?.shots.find((x) => x.id === shotId));
	const epTitle = useProjectStore((s) => s.episodes.find((e) => e.id === episodeId)?.title) || "";
	const ms = useProjectStore((s) => s.mediaSettings);
	const sameSource = !!ms?.imgVideoSameSource;
	const inferring = useShotInferring(shotId);
	const sbRunning = useShotJobs(shotId, "storyboard").some((p) => p.status === "running");
	const vidRunning = useShotJobs(shotId, "video").some((p) => p.status === "running");
	// 出图预设方案（与 Frame161195 同源：服务端预设库 + 本地自定义，随 catalog 热更）
	const presetCatalogVer = useCatalogStore((s) => s.catalog?.version);
	const customPresets = useSettingsStore((s) => s.customPresets);
	const presetSchemes = useMemo(() => listPresetSchemes(), [presetCatalogVer, customPresets]);
	// 非同源模式的提示词小页签（本地态，换选中随 key 重置）
	const [promptTab, setPromptTab] = useState<ShotPromptFieldKey>("storyboardPrompt");
	// 第二行「仅本分镜」视频参数的数据面（第251轮：模型三级下拉已移除，只留档位；
	// 生效模型仍按「本分镜覆盖 > 右栏项目级」解析——档位随它走）
	const effVideoKey = useEffectiveModelKey("video");
	// catalog 版本订阅：档位经 modelOptions 现查（非 hook），catalog 热更后要重算一遍
	const catalogVer = useCatalogStore((s) => s.catalog?.version);

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
	const curVideoModel = ov.videoModelKey || effVideoKey || "";
	const curCatModel = useCatalogStore.getState().catalog?.models.find((m) => m.id === curVideoModel);
	const curMethods = useMemo(() => modelMethodsForKey(curVideoModel), [curVideoModel, catalogVer]);
	const curMethod = clampMethod(ov.method || ms.videoMethod, curMethods);
	const curReq = useMemo(() => videoReqOptionsForKey(curVideoModel), [curVideoModel, catalogVer]);
	const maxDuration = ms.maxDuration ?? 15;
	const aspect = ms.aspect ?? "16:9";
	const resolution = ms.resolution ?? "720p";
	const shotImgCount = Math.min(9, shot.materials.filter((m) => { const md = mediaOf(m); return md !== "video" && md !== "audio"; }).length);
	const officialSel = new Set((ov.officialAssetIndexes ?? []).filter((i) => i >= 0 && i < shotImgCount));
	// 单镜覆盖 setter（与 Frame161195.setShotOverride 同尺）
	const setShotOverride = (patch: Partial<NonNullable<StoryboardShot["overrides"]>>) =>
		update({ overrides: { ...(shot.overrides || {}), ...patch } });
	// 补镜头开关：切标记 + 全集重排编号（reindexShots 与表格模式/inferRun 共用同一纯函数）+ 落盘
	const toggleSupplement = () => {
		const st = useProjectStore.getState();
		const ep = st.episodes.find((e) => e.id === episodeId);
		if (!ep) return;
		st.setEpisodeShots(episodeId, reindexShots(ep.shots.map((s) => (s.id === shotId ? { ...s, isSupplement: !s.isSupplement } : s))));
		void st.save(true);
	};

	return (
		<div style={{ flex: 1, minHeight: 0, display: "flex", gap: 12, padding: 12, overflow: "hidden" }}>
			{/* ── 参照列（居右，order:2 在组件内）：故事板预览（上）+ 原文气泡（下），分界可拖 ── */}
			<RefColumn episodeId={episodeId} shotId={shotId} shot={shot} />

			{/* ── 提示词工作区（order:1 居左，紧邻素材面板——补充2 用户定稿；两行头照表格模式）。
			     第240轮补充：不整列滑动——提示词栏位 fill 吃满剩余高、超长提示词在编辑框内滚动（收起）；
			     overflowY:auto 仅作极小视口的兜底（正常视口各区块恰好填满不出滚条） ── */}
			<div style={{ flex: 1, order: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", gap: 10, overflowY: "auto", paddingRight: 2 }}>
				{/* 头部：分镜身份 + 推理 */}
				<div style={{ display: "flex", alignItems: "baseline", gap: 8, flexShrink: 0 }}>
					<span style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>{shot.title || "分镜"}</span>
					<span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{epTitle}{shot.durationSec ? ` · ${shot.durationSec}s` : ""} · {isMedia ? "成片（可重跑）" : "占位符"}</span>
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

				{/* 提示词大编辑区（ShotPromptField：@/#/预设/放大弹窗全套；两行头经 renderHeader 照表格模式排布） */}
				<ShotPromptField
					key={activeField}
					episodeId={episodeId} shotId={shotId}
					fieldKey={activeField} label={activeLabel}
					shot={shot} presetSchemes={presetSchemes} inferring={inferring}
					fill
					presetLabel="▦ 预设方案"
					renderHeader={({ presetBtn, expandBtn }) => (
						<div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
							{/* 第一行：提示词页签 + ▦预设方案 + 补镜头（照 Frame161195 分镜行第一行） */}
							<div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
								{sameSource ? (
									<span title="图视同源：图片与视频共用同一段提示词（右栏属性页可关闭同源）"
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
								{presetBtn}
								<button title="补镜头：本镜编号派生自上一主镜（如「分镜3」→「分镜3-1」），切换即全集重排编号，影响命名/导出"
									onClick={toggleSupplement}
									style={{ padding: "3px 8px", fontSize: 11, cursor: "pointer", borderRadius: 6, border: shot.isSupplement ? "1px solid rgba(245,196,81,0.7)" : "1px solid rgba(255,255,255,0.18)", background: shot.isSupplement ? "rgba(245,196,81,0.18)" : "transparent", color: shot.isSupplement ? "#f5c451" : "rgba(255,255,255,0.7)" }}>补镜头</button>
							</div>
							{/* 第二行：仅本分镜的视频参数（方法→时长/比例/分辨率→真人图→放大），
							    写 shot.overrides/durationSec = 提交层 genShotVideo 读的字段。
							    ⚠ 第251轮用户定稿：**模型选择只在右栏属性栏**——本行原来的 家族/线路/模型
							    三个下拉与右栏重复且冲突，已删除（overrides.videoModelKey 的**读取链保留**，存量数据仍生效）。 */}
							<div title="以下参数仅对本分镜生效（模型与项目级默认在右栏「属性」页）" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
								{curMethods.length > 1 && (
									<select title="方法（仅本分镜）：首尾帧=首帧（故事板图或素材第1张图）+ 尾帧（素材下一张图）" value={curMethod} onChange={(e) => setShotOverride({ method: e.target.value })} style={miniSel}>
										{curMethods.map((k) => <option key={k} value={k} style={miniOpt}>{METHOD_LABELS[k]}</option>)}
									</select>
								)}
								<select title="视频时长(秒，仅本分镜)" value={clampDurationTo(clampDuration(shot.durationSec ?? maxDuration), curReq.durations)} onChange={(e) => update({ durationSec: Number(e.target.value) })} style={miniSel}>
									{curReq.durations.map((d) => <option key={d} value={d} style={miniOpt}>{d}秒</option>)}
								</select>
								<select title="视频比例（仅本分镜）" value={clampToOptions(shot.overrides?.aspect || aspect, curReq.aspects)} onChange={(e) => setShotOverride({ aspect: e.target.value })} style={miniSel}>
									{curReq.aspects.map((a) => <option key={a} value={a} style={miniOpt}>{a}</option>)}
								</select>
								<select title="视频分辨率（仅本分镜）" value={clampToOptions(shot.overrides?.resolution || resolution, curReq.resolutions)} onChange={(e) => setShotOverride({ resolution: e.target.value })} style={miniSel}>
									{curReq.resolutions.map((r) => <option key={r} value={r} style={miniOpt}>{r}</option>)}
								</select>
								{curCatModel?.officialAssets && curMethod === "omni" && shotImgCount > 0 && (
									<span title="真人图标记：点选素材区第 N 张图片为真人图像（官方真人库注册用；默认不选，仅本分镜）" style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, color: "rgba(255,255,255,0.55)" }}>
										真人图
										{Array.from({ length: shotImgCount }, (_, i) => (
											<button key={i}
												onClick={() => {
													const next = new Set(officialSel);
													if (next.has(i)) next.delete(i); else next.add(i);
													setShotOverride({ officialAssetIndexes: [...next].sort((a, b) => a - b) });
												}}
												style={{ padding: "1px 6px", fontSize: 10, cursor: "pointer", borderRadius: 5, border: officialSel.has(i) ? "1px solid rgba(139,124,247,0.8)" : "1px solid rgba(255,255,255,0.18)", background: officialSel.has(i) ? "rgba(139,124,247,0.25)" : "transparent", color: officialSel.has(i) ? "#c9befd" : "rgba(255,255,255,0.6)" }}>
												{i + 1}
											</button>
										))}
									</span>
								)}
								{/* 放大编辑当前栏提示词，行尾（照表格模式 marginLeft:auto 位） */}
								<span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center" }}>{expandBtn}</span>
							</div>
						</div>
					)}
				/>

				{/* 动作行 + 在途 chips */}
				<div style={{ ...secBox, flexShrink: 0 }}>
					<div style={{ display: "flex", gap: 6 }}>
						<button style={btnSt("plain", sbRunning)} disabled={sbRunning}
							title={(shot.storyboardUri ? "重新生成故事板图（新结果加入历史）" : "按提示词生成故事板图") + (imageSlot ? (isMedia ? "；成功后落在**上方新占位**，原结果原位保留" : "；成功后本图片占位自动替换为图片片段") : "")}
							onClick={() => void (imageSlot ? regenerateShotResult(segId, "storyboard") : genShotStoryboard(episodeId, shotId))}>
							{sbRunning ? "生成中…" : shot.storyboardUri ? "重新生成故事板" : "生成故事板"}
						</button>
						<button style={btnSt("primary", vidRunning)} disabled={vidRunning}
							title={isMedia
								? "重新生成视频：新结果落在**上方新占位**，本成片原位保留（上下层即版本堆叠）"
								: shot.videoUri ? "重新生成视频（新结果加入历史；成功后替换本占位符）" : "生成视频（成功后本占位符自动替换为视频片段）"}
							onClick={() => void regenerateShotResult(segId, "video")}>
							{vidRunning ? "生成中…" : isMedia || shot.videoUri ? "重新生成视频" : "生成视频"}
						</button>
					</div>
					<JobChips shotId={shotId} field="storyboard" />
					<JobChips shotId={shotId} field="video" />
				</div>

				{/* 视频历史（条内滚动，条目多也不把列撑出滚动） */}
				{shot.videoUris?.length ? (
					<div style={{ ...secBox, flexShrink: 0 }}>
						<div style={{ ...secTitle, fontSize: 10 }}><span>视频历史（{shot.videoUris.length}）</span></div>
						<div style={{ maxHeight: 100, overflowY: "auto" }}>
							<HistoryGrid kind="video" uris={shot.videoUris} currentUri={shot.videoUri} name={`${shot.title || "分镜"}·视频`}
								onSetCurrent={(u) => update({ videoUri: u, videoActiveKey: `u:${u}` })} />
						</div>
					</div>
				) : null}
			</div>
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
			segId={target.seg.id}
			imageSlot={imageSlot}
			isMedia={isMedia}
		/>
	);
}
