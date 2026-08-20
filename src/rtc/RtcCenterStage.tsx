/**
 * 实时剪辑 · 中央区（双页签「AI 工作台 / 预览」；第240轮：页签行收进中栏标题栏——
 * 切换控件是 [RtcCenterTabSwitch](./panel/RtcCenterTabSwitch.tsx)，经 FrameEditor 的 headerExtra
 * 与分集切换器并排挂载，本文件只按 rtcCenterTabStore 渲染对应页正文，不再自渲染页签行）：
 *   - 「预览」页 = 原单一预览视口：底层时间指针预览（RtcSequencePlayer）+ 左栏素材选中时的
 *     素材预览叠层（AssetPreviewLayer，五类资产带右缘「生成历史」缩略条）；
 *   - 「AI 工作台」页 = 不透明叠层覆盖视口：绑定 useWorkbenchTarget（**选中占位符优先、
 *     无选中回退播放头下主轨占位符**——补充3 用户定稿「默认显示当前时间的 ai 界面…不要黑屏」）：
 *     分镜占位（shotRef）→ RtcShotAiWorkbench；自由结果占位（无 shotRef）→ RtcFreeGenWorkbench
 *     （提示词/垫素材编辑，右栏只留 AI 设置）；两处都无目标才显示引导；
 *   - 页签自动切换（rtcCenterTabCore 纯函数，配单测）：新选中任何占位符→工作台；新选中左栏
 *     素材/资产预览→预览；占位符被成片替换（同 segId placeholder→media）→预览；**播放头进入
 *     新片段（或所在占位被成片替换）→ 占位=工作台/有结果=预览（补充3 播放头跟随）**；初始页签=
 *     播放头处片段定，空白按 doc 有无可播片段兜底；手动点页签永远生效。
 *
 * ⚠ 播放不中断（勿回退）：RtcSequencePlayer 常驻挂载在视口列里，「AI 工作台」与素材预览的显隐
 * 都是**叠层覆盖/条件渲染叠层**（绝不条件卸载播放器）——切页签/切素材选中不打断播放。
 */
import { useEffect, useRef, useState } from "react";
import { Music } from "lucide-react";
import { useProjectStore } from "@/store/projectStore";
import { activeRtcDoc, useRtcStore } from "@/store/rtcStore";
import { useAssetFormStore } from "@/store/assetFormStore";
import { openLightbox } from "@/store/lightboxStore";
import { RtcSequencePlayer } from "./RtcSequencePlayer";
import { docHasAnySegment } from "./rtcPlayback";
import { useRtcAssetSelStore } from "./rtcAssetSelStore";
import { collectProjectImageItems } from "./asset/rtcAssetData";
import { useRtcSelected, useWorkbenchTarget } from "./panel/useRtcSelected";
import { RtcShotAiWorkbench } from "./panel/RtcShotAiWorkbench";
import { RtcFreeGenWorkbench } from "./panel/RtcFreeGenWorkbench";
import {
	type CenterSelSnapshot,
	centerTabAutoSwitch,
	initialCenterTab,
	mainTrackSegAt,
} from "./panel/rtcCenterTabCore";
import { useRtcCenterTabStore } from "./panel/rtcCenterTabStore";
import { ensureShotForPlaceholder } from "./panel/segShotBinding";

/** 顺序预览播放器挂载点：doc 有任何片段才显示；布尔选择器——选中/播放头变化不重渲本壳。 */
function SequencePreviewSlot() {
	const show = useRtcStore((s) => !!s.doc && docHasAnySegment(s.doc));
	return show ? <RtcSequencePlayer /> : null;
}

/* ════════════════ 预览页（单一预览视口） ════════════════ */

/** 底层空态提示：仅时间轴无片段时占满视口（有片段=播放器自身撑满整列，不再渲染本块） */
function ViewportIdleHint() {
	const hasSeg = useRtcStore((s) => !!s.doc && docHasAnySegment(s.doc));
	if (hasSeg) return null;
	return (
		<div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
			<div style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", lineHeight: 2, textAlign: "center" }}>
				时间轴还没有片段——从素材面板拖入素材，或在右侧「剧本」「分镜」页签按步骤生成分镜并占位入轨
			</div>
		</div>
	);
}

/**
 * 素材预览叠层：左栏选中素材时覆盖整个视口（不透明背景遮住底层播放器画面）。
 * ⚠ 只做**叠层显隐**，绝不条件卸载底层播放器——切换素材选中/取消不打断播放。
 * 五类资产预览时右缘带竖排「生成历史」缩略条（本叠层的一部分，随叠层显隐）。
 */
function AssetPreviewLayer() {
	const assetSel = useRtcAssetSelStore((s) => s.selected);
	const mediaSel = useRtcAssetSelStore((s) => s.mediaSel);
	const selForm = useAssetFormStore((s) => s.selForm);
	// 订阅选中类别的资产数组（主图/造型变化即刷新预览）
	const catAssets = useProjectStore((s) => (assetSel ? s[assetSel.cat] : undefined));
	// 历史缩略条点选的预览图（不改主图；key=cat:id——换选资产即失效回默认显示）
	const [histSel, setHistSel] = useState<{ key: string; uri: string } | null>(null);
	if (!assetSel && !mediaSel) return null;

	let body: React.ReactNode;
	let caption = "";
	let stripEl: React.ReactNode = null;
	if (mediaSel) {
		// 素材预览（视频/音频/图片——素材页各栏点击都进这里）：无历史条
		caption = mediaSel.name;
		body = mediaSel.media === "video" ? (
			// autoPlay：点卡即播（用户定稿「素材点击在预览直接播放」；点击本身是用户手势，
			// 打包版另有 --autoplay-policy=no-user-gesture-required 兜底）
			<video key={mediaSel.uri} src={mediaSel.uri} controls autoPlay style={{ maxWidth: "100%", maxHeight: "100%", minHeight: 0, borderRadius: 10, background: "#000" }} />
		) : mediaSel.media === "audio" ? (
			<div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
				<Music size={40} color="rgba(255,255,255,0.4)" />
				<audio key={mediaSel.uri} src={mediaSel.uri} controls autoPlay style={{ width: "min(420px, 80%)" }} />
			</div>
		) : (
			<img key={mediaSel.uri} src={mediaSel.uri} alt={mediaSel.name} style={{ maxWidth: "100%", maxHeight: "100%", minHeight: 0, objectFit: "contain", borderRadius: 10 }} />
		);
	} else {
		// 五类资产：与面板卡片同一条显示链路（collectProjectImageItems——选中造型优先，本地 uri 惯例）
		const cat = assetSel!.cat;
		const id = assetSel!.id;
		const a = (catAssets as any[] | undefined)?.find((x) => x.id === id);
		if (!a) return null; // 资产已删除 → 不覆盖（面板选中态由其自身逻辑清理）
		const item = collectProjectImageItems([a], cat, selForm)[0];
		// 历史条数据源与 RtcAssetProps 历史网格同源：asset.image（主图）+ asset.images（历史）
		const images: string[] = Array.isArray(a.images) ? a.images : [];
		const mainUri: string = a.image || "";
		const stripUris = mainUri && !images.includes(mainUri) ? [mainUri, ...images] : images;
		const selKey = `${cat}:${id}`;
		const overrideUri = histSel && histSel.key === selKey ? histSel.uri : null;
		const displayUri = overrideUri ?? item?.uri ?? null;
		const displayName = item?.name || a.name || "";
		caption = displayName;
		body = displayUri ? (
			<img
				key={displayUri}
				src={displayUri}
				onClick={() => openLightbox({ uri: displayUri, media: "image", name: displayName })}
				style={{ maxWidth: "100%", maxHeight: "100%", minHeight: 0, objectFit: "contain", borderRadius: 10, cursor: "zoom-in" }}
			/>
		) : (
			<div style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", lineHeight: 2, textAlign: "center" }}>
				<div style={{ fontSize: 13, color: "rgba(255,255,255,0.75)" }}>{a.name || "资产"} · 尚未出图</div>
				在右侧属性面板生成基础形象后，这里显示主图大图
			</div>
		);
		// 生成历史缩略条（仅资产预览且有图；观感对齐 AssetWorkbench/RtcAssetProps 主图历史，只读+设主图）
		if (stripUris.length > 0) {
			stripEl = (
				<div
					style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: 84, zIndex: 6, overflowY: "auto", padding: "8px 8px 12px", display: "flex", flexDirection: "column", gap: 6, borderLeft: "1px solid rgba(255,255,255,0.08)", background: "rgba(0,0,0,0.28)" }}
				>
					<div style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", textAlign: "center", flexShrink: 0 }}>生成历史（{stripUris.length}）</div>
					{stripUris.map((u, i) => {
						const isMain = u === mainUri;
						const isCurrent = u === displayUri;
						return (
							<div
								key={`${u}-${i}`}
								className="group"
								title={`${displayName || "资产"} 记录 ${i + 1}（点击在左侧预览，不改主图）`}
								onClick={() => setHistSel({ key: selKey, uri: u })}
								style={{ position: "relative", width: "100%", aspectRatio: "1", borderRadius: 6, overflow: "hidden", flexShrink: 0, cursor: "pointer", border: isCurrent ? "2px solid #a78bfa" : isMain ? "1px solid rgba(139,92,246,0.9)" : "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.05)" }}
							>
								<img src={u} style={{ width: "100%", height: "100%", objectFit: "cover" }} draggable={false} />
								{isMain ? (
									<span style={{ position: "absolute", top: 0, left: 0, fontSize: 9, lineHeight: "13px", padding: "0 4px", background: "rgba(139,92,246,0.9)", color: "#fff", borderBottomRightRadius: 4 }}>主图</span>
								) : (
									<button
										onClick={(e) => { e.stopPropagation(); useProjectStore.getState().setAssetMainImage(cat, id, null, u); }}
										title="设为主图（左栏资产卡缩略图随之更新）"
										className="hidden group-hover:flex"
										style={{ position: "absolute", inset: "auto 0 0 0", height: 16, alignItems: "center", justifyContent: "center", fontSize: 9, color: "#fff", background: "rgba(0,0,0,0.65)", border: "none", cursor: "pointer" }}
									>设为主图</button>
								)}
							</div>
						);
					})}
				</div>
			);
		}
	}
	return (
		<div style={{ position: "absolute", inset: 0, zIndex: 5, background: "#101018", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: stripEl ? "16px 104px 16px 24px" : "16px 24px", minHeight: 0 }}>
			{body}
			<span style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>
				{caption}（素材预览——再点左侧素材卡取消，回到时间指针预览）
			</span>
			{stripEl}
		</div>
	);
}

/* ════════════════ 双页签：自动切换 + 初始页签 ════════════════ */

/**
 * 页签自动切换（规则见 rtcCenterTabCore 头注释）：快照 ref 比对「新的选中动作/占位符被替换」，
 * 命中即 setTab（与 RtcPropertyPanel 的 shouldAutoSwitchToProps 同范式）。
 */
function useCenterTabAutoSwitch() {
	const sel = useRtcSelected();
	const assetSel = useRtcAssetSelStore((s) => s.selected);
	const mediaSel = useRtcAssetSelStore((s) => s.mediaSel);
	// 规则 6（补充3 播放头跟随）：播放头下主轨片段的 id/kind——标量选择器，
	// 帧级 playheadUs 变化下结果不变=不重渲染；进入新片段/占位被成片替换才触发。
	const phSegId = useRtcStore((s) => mainTrackSegAt(activeRtcDoc(s), s.playheadUs)?.seg.id ?? null);
	const phSegKind = useRtcStore((s) => mainTrackSegAt(activeRtcDoc(s), s.playheadUs)?.seg.kind ?? null);
	const segId = sel?.seg.id ?? null;
	const segKind = sel?.seg.kind ?? null;
	const assetKey = assetSel ? `${assetSel.cat}:${assetSel.id}` : null;
	const mediaKey = mediaSel?.key ?? null;
	const snapRef = useRef<CenterSelSnapshot>({ segId, segKind, assetKey, mediaKey, phSegId, phSegKind });
	useEffect(() => {
		const prev = snapRef.current;
		const next: CenterSelSnapshot = { segId, segKind, assetKey, mediaKey, phSegId, phSegKind };
		snapRef.current = next;
		const to = centerTabAutoSwitch(prev, next);
		if (to) useRtcCenterTabStore.getState().setTab(to);
	}, [segId, segKind, assetKey, mediaKey, phSegId, phSegKind]);
}

/**
 * 「AI 工作台」页正文分派（第240轮；补充3 改绑 useWorkbenchTarget=选中占位符优先、
 * 无选中回退**播放头下主轨占位符**——播放头停在待生成片段上时工作台直接绑定它，不再黑屏引导）。
 * 补充6（用户定稿「普通占位与分镜占位完全一致，不要两种实现」）：普通占位（视频/图片）创建时
 * 已挂真实分镜（segShotBinding）；**存量旧占位**在这里绑定那一刻补挂同一函数（幂等）——升级后
 * 走 RtcShotAiWorkbench 同一条实现。仍无 shotRef 的残余（音频占位/超分·去字幕坑位/生成中的
 * 存量自由占位——ensureShotForPlaceholder 内部拒绝升级的三类）→ RtcFreeGenWorkbench。
 * key=segId：换目标即重置本地编辑态。
 */
function WorkbenchBody() {
	const target = useWorkbenchTarget();
	const seg = target?.seg ?? null;
	useEffect(() => {
		if (seg && seg.kind === "placeholder" && !seg.shotRef) ensureShotForPlaceholder(seg.id);
	}, [seg]);
	if (target && !target.seg.shotRef) {
		return <RtcFreeGenWorkbench key={target.seg.id} seg={target.seg} track={target.track} segIndex={target.segIndex} />;
	}
	return <RtcShotAiWorkbench />;
}

export function RtcCenterStage() {
	const tab = useRtcCenterTabStore((s) => s.tab);
	useCenterTabAutoSwitch();
	// 初始页签（规则 4，会话首次挂载定一次；补充3：优先按播放头下主轨片段——占位=工作台/有结果=预览，
	// 空白处按 doc 是否已有可播片段兜底）
	useEffect(() => {
		const st = useRtcStore.getState();
		const doc = st.doc;
		const hasPlayable = !!doc && doc.tracks.some((t) => t.segments.some((sg) => sg.kind !== "placeholder"));
		const ph = mainTrackSegAt(doc, st.playheadUs);
		useRtcCenterTabStore.getState().initTab(initialCenterTab(hasPlayable, ph?.seg.kind ?? null));
	}, []);

	return (
		<main className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
			{/* 页签行已收进中栏标题栏（RtcCenterTabSwitch 经 FrameEditor headerExtra 挂载，第240轮） */}
			{/* ── 视口：底层=顺序播放器（⚠ 常驻挂载勿条件卸载），预览页素材叠层 / 工作台页不透明叠层 ── */}
			<div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden" style={{ position: "relative" }}>
				<SequencePreviewSlot />
				<ViewportIdleHint />
				{tab === "preview" && <AssetPreviewLayer />}
				{tab === "workbench" && (
					<div style={{ position: "absolute", inset: 0, zIndex: 7, background: "#101018", display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
						<WorkbenchBody />
					</div>
				)}
			</div>
		</main>
	);
}
