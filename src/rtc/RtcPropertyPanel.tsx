/**
 * 实时剪辑 · 右栏单一窗口（顶部三页签：属性 / 剧本 / 分镜）。
 * 原中栏「AI 生成」子栏（四步工作台）整体并入本窗口——中栏只留单一预览视口。
 *
 * 页签信息架构：
 *   - 属性：既有分派视图原样——rtcStore.selection（时间轴片段）非空 → 片段视图优先：
 *       placeholder + shotRef → RtcShotWorkbench（中栏双页签改版后收敛为「AI 生成属性」：
 *         生图/生视频要求+同源开关；提示词/垫图/生成动作在中栏「AI 工作台」页 RtcShotAiWorkbench）；
 *       media → RtcMediaProps（名称/轨道/时间码只读 + speed/volume/muted 编辑 + 素材源）；
 *       无 shotRef 的自由结果占位 → RtcFreeGenProps（第240轮收敛为 AI 设置：时间码/模型/生成·进度·重试；
 *         提示词/垫素材在中栏「AI 工作台」页 RtcFreeGenWorkbench 编辑）；
 *     其次 rtcAssetSelStore（左栏选中的项目资产）→ RtcAssetProps（出图不切回资产模式）；
 *     两边都空 → 引导提示（含原「开始剪辑」四步说明）。
 *   - 剧本：四步工作台 ①剧本编辑 + ②剧集拆分 + ③资产拆分（RtcFlowScriptPage）。
 *   - 分镜：④逐集 智能推理/智能拆分 + 生成占位入轨（RtcFlowShotsPage）。
 *
 * 页签=会话级 UI 态（rtcPropsTabStore，默认「属性」，不持久化）；**新的选中动作**
 * （时间轴选片段 / 左栏选项目资产）自动切回「属性」——同一选中不重复切、取消选中不切，
 * 正在「剧本/分镜」页操作不被打断（shouldAutoSwitchToProps 纯函数，配单测）。
 *
 * 断连恢复：资产拆分在途任务重连（resumeAnalysisTask）挂在本窗口顶层——右栏在 RTC 模式下
 * 常驻挂载，不随「剧本」页签的显隐丢失重连时机。
 * 生成链路红线：出图/出视频只走 startShotGeneration、推理只走 startInfer（见 panel/shotGenActions）；
 * 资产出图只走 startGeneration（见 panel/assetGenActions）；自由结果占位走 runPurpose
 * （见 panel/freeGenActions 头注释的选路理由）。三条链的**落笔**统一收口在 panel/rtcGenSink。
 */
import { useEffect, useRef } from "react";
import { useRtcSelected, type RtcSelected } from "./panel/useRtcSelected";
import { RtcCompoundProps } from "./panel/RtcCompoundProps";
import { RtcShotWorkbench } from "./panel/RtcShotWorkbench";
import { RtcMediaProps } from "./panel/RtcMediaProps";
import { RtcTextProps } from "./panel/RtcTextProps"; // 第三批：字幕片段属性视图
import { RtcTransformProps } from "./panel/RtcTransformProps";
import { RtcFreeGenProps } from "./panel/RtcFreeGenProps";
import { RtcAssetProps } from "./asset/RtcAssetProps";
import { useRtcAssetSelStore, type RtcAssetSel } from "./rtcAssetSelStore";
import {
	PROPS_TABS,
	type PropsSelSnapshot,
	assetSelKey,
	shouldAutoSwitchToProps,
} from "./panel/rtcPropsTabCore";
import { useRtcPropsTabStore } from "./panel/rtcPropsTabStore";
import { RtcFlowScriptPage, RtcFlowShotsPage } from "./flow/RtcAiFlow";
import { resumeAnalysisTask } from "./flow/flowActions";
import { initRtcGenWatch } from "./panel/placeholderSwap";

const em = (text: string) => <span style={{ color: "rgba(255,255,255,0.75)" }}>{text}</span>;

/** 无选中引导：属性分派说明 + 原「AI 生成」子栏的「开始剪辑」四步说明并入 */
function EmptyHint() {
	return (
		<div style={{ padding: "24px 16px", fontSize: 12, color: "rgba(255,255,255,0.5)", lineHeight: 2 }}>
			<div style={{ fontSize: 13, color: "rgba(255,255,255,0.8)", marginBottom: 6 }}>未选中片段</div>
			在下方时间轴点击一个片段查看属性：
			<br />· 选中{em("分镜占位符")} → 在这里选生图/生视频要求，提示词与垫图在中栏「AI 工作台」编辑（成片自动替换占位符）；
			<br />· 选中{em("素材片段")} → 调整变速 / 音量 / 静音，查看素材源；
			<br />· 点击左栏{em("项目资产卡")} → 编辑出图提示词、生成基础形象（无需切回资产模式）。
			<div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
				<div style={{ fontSize: 13, color: "rgba(255,255,255,0.8)", marginBottom: 2 }}>开始剪辑</div>
				从{em("素材面板")}拖素材到时间轴直接剪；或从剧本一路生成——
				<br />在{em("「剧本」页签")}：①编辑剧本 → ②剧集拆分 → ③资产拆分；
				<br />再到{em("「分镜」页签")}：④逐集智能推理/智能拆分，「生成占位入轨」；
				<br />最后在时间轴选中占位符，到中栏「AI 工作台」{em("推理提示词 → 生成故事板 → 生成视频")}（成片自动替换占位）。
			</div>
		</div>
	);
}

/** 「属性」页正文：既有分派逻辑原样（片段视图 > 资产视图 > 引导） */
function PropsPage({ sel, assetSel }: { sel: RtcSelected | null; assetSel: RtcAssetSel | null }) {
	if (!sel) {
		// 无片段选中：左栏选中的项目资产 → 资产属性视图；两边都空 → 引导
		return assetSel ? <RtcAssetProps key={`${assetSel.cat}:${assetSel.id}`} cat={assetSel.cat} id={assetSel.id} /> : <EmptyHint />;
	}
	if (sel.seg.kind === "placeholder" && sel.seg.shotRef) {
		return <RtcShotWorkbench episodeId={sel.seg.shotRef.episodeId} shotId={sel.seg.shotRef.shotId} />;
	}
	// 第三批：字幕片段（text 轨）→ 字幕编辑视图（在 media 分支之前——字幕片段 kind 也是 media）
	if (sel.track.type === "text" && sel.seg.kind === "media") {
		return <RtcTextProps key={sel.seg.id} seg={sel.seg} track={sel.track} />;
	}
	// 第四批：复合片段 → 专属属性视图（进入编辑 / 解除复合 / 子时间轴概览）
	if (sel.seg.kind === "compound") {
		return <RtcCompoundProps key={sel.seg.id} seg={sel.seg} track={sel.track} />;
	}
	if (sel.seg.kind === "media") {
		// 画面数值区（缩放/位置/旋转/不透明度/镜像/对齐）自带守卫：非画面片段（音频）内部返回 null
		return (
			<>
				<RtcMediaProps seg={sel.seg} track={sel.track} segIndex={sel.segIndex} />
				<RtcTransformProps segId={sel.seg.id} />
			</>
		);
	}
	// 无 shotRef 的「自由结果占位」（时间轴空白右键新建 / 超分·去字幕的结果坑位）：
	// AI 设置视图（时间码/模型/生成·进度·重试，生成走 runPurpose 唯一路径见 freeGenActions）；
	// 提示词/垫素材在中栏「AI 工作台」页 RtcFreeGenWorkbench 编辑（第240轮）
	return <RtcFreeGenProps key={sel.seg.id} seg={sel.seg} track={sel.track} segIndex={sel.segIndex} />;
}

export function RtcPropertyPanel() {
	// 断连恢复：资产拆分在途任务（analysisTask 已落盘）挂载时重连取结果（与 Frame1693 同款；
	// 原挂在 RtcAiFlow，三页签重构后剧本页非常驻，改挂本窗口顶层）
	useEffect(() => resumeAnalysisTask(), []);
	// 结果占位 ↔ 在途台账的全局对账（幂等）：重开客户端后凭片段自己的 status/taskRef 把
	// 生成中的占位接回来（台账那条链重挂终态监听、自由占位那条链重挂集中轮询），
	// 进度继续回填——状态源是已落盘的片段与台账，不是任何回调闭包。
	useEffect(() => initRtcGenWatch(), []);

	const sel = useRtcSelected();
	const assetSel = useRtcAssetSelStore((s) => s.selected);
	const tab = useRtcPropsTabStore((s) => s.tab);

	// 新的选中动作 → 自动切回「属性」（同一选中不重复切；取消选中不切；媒体卡预览选中不参与）
	const segId = sel?.seg.id ?? null;
	const assetKey = assetSelKey(assetSel);
	const snapRef = useRef<PropsSelSnapshot>({ segId, assetKey });
	useEffect(() => {
		const prev = snapRef.current;
		const next: PropsSelSnapshot = { segId, assetKey };
		snapRef.current = next;
		if (shouldAutoSwitchToProps(prev, next)) useRtcPropsTabStore.getState().setTab("props");
	}, [segId, assetKey]);

	return (
		<aside className="w-[360px] shrink-0 min-h-0 flex flex-col bg-secondary/20 border-l border-white/5">
			{/* 顶部三页签（属性 / 剧本 / 分镜） */}
			<nav className="h-8 shrink-0 flex items-stretch border-b border-white/8 select-none">
				{PROPS_TABS.map((t) => {
					const active = t.id === tab;
					return (
						<button
							key={t.id}
							type="button"
							onClick={() => useRtcPropsTabStore.getState().setTab(t.id)}
							className={`flex-1 text-[12px] transition-colors border-b-2 ${
								active
									? "border-[#a78bfa] text-white bg-white/5"
									: "border-transparent text-white/50 hover:text-white/85 hover:bg-white/5"
							}`}
						>
							{t.label}
						</button>
					);
				})}
			</nav>
			<div className="flex-1 min-h-0 overflow-y-auto">
				{tab === "script" ? <RtcFlowScriptPage /> : tab === "shots" ? <RtcFlowShotsPage /> : <PropsPage sel={sel} assetSel={assetSel} />}
			</div>
		</aside>
	);
}
