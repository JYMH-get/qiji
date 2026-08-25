/**
 * 实时剪辑 · 中央区（双页签「AI 工作台 / 预览」；页签行在中栏标题栏，切换控件是
 * [RtcCenterTabSwitch](./panel/RtcCenterTabSwitch.tsx)，经 FrameEditor 的 headerExtra 与分集切换器并排挂载）。
 *
 * 【层级语义（第251轮需求⑨ 用户定稿，勿回退）】**AI 工作台是底，结果预览是面**：
 *   - 页签**只能手动切换**——第240轮那套自动切换（选中/播放头跟随/成片替换）已整体删除：
 *     用户实报「时间轴一动就会回到预览，很影响正在整理提示词的状态」；
 *   - 「AI 工作台」页：面层全部让开，工作台占满视口；
 *   - 「预览」页：播放头所在主轨片段**有成片**才盖住工作台（resultLayerVisible）；
 *     播到占位符 / 空白区间 → 面层让开，露出底下的工作台（**页签态不变**）；
 *     左栏选中素材/资产卡时同样让开，改显不透明的素材预览叠层（AssetPreviewLayer）；
 *   - 另有一层**剧本处理面**（需求⑪，右栏「整理剧本」打开）盖在最上，用户手动关闭。
 *
 * 工作台绑定 useWorkbenchTarget（选中优先、无选中回退播放头下主轨片段）：
 *   带 shotRef 的片段（占位符**与已出片的成片**，第251轮需求⑦）→ RtcShotAiWorkbench；
 *   无 shotRef 的自由结果占位 → RtcFreeGenWorkbench；都没有才显示引导。
 *
 * ⚠ 播放不中断（第236/239轮红线，勿回退）：RtcSequencePlayer **常驻挂载在视口列里**，
 *   工作台与素材预览都是**不透明叠层的显隐**（绝不条件卸载播放器）——
 *   切页签 / 播过占位区间 / 切素材选中 都不打断播放。
 */
import { useEffect, useState } from "react";
import { Music } from "lucide-react";
import { useProjectStore } from "@/store/projectStore";
import { activeRtcDoc, useRtcStore } from "@/store/rtcStore";
import { useAssetFormStore } from "@/store/assetFormStore";
import { openLightbox } from "@/store/lightboxStore";
import { RtcSequencePlayer } from "./RtcSequencePlayer";
import { docHasAnySegment } from "./rtcPlayback";
import { useRtcAssetSelStore } from "./rtcAssetSelStore";
import { collectProjectImageItems } from "./asset/rtcAssetData";
import { useWorkbenchTarget } from "./panel/useRtcSelected";
import { RtcShotAiWorkbench } from "./panel/RtcShotAiWorkbench";
import { RtcFreeGenWorkbench } from "./panel/RtcFreeGenWorkbench";
import { initialCenterTab, mainTrackSegAt, resultLayerVisible } from "./panel/rtcCenterTabCore";
import { useRtcCenterTabStore } from "./panel/rtcCenterTabStore";
import { RtcScriptEditorPane } from "./flow/RtcScriptEditorPane";
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

/* ════════════════ 「AI 工作台」页正文 ════════════════ */

/**
 * 「AI 工作台」页正文分派（绑 useWorkbenchTarget：选中优先、无选中回退播放头下主轨片段）。
 *
 * ⚠ 第251轮需求⑦：分派只看 **shotRef 有没有**，不看 kind——占位生成成功变成片后
 *   shotRef 原样保留，它仍该回分镜工作台二次编辑（提示词/垫图/历史都还在）。
 * 补充6（用户定稿「普通占位与分镜占位完全一致，不要两种实现」）：普通占位（视频/图片）创建时
 * 已挂真实分镜（segShotBinding）；**存量旧占位**在这里绑定那一刻补挂同一函数（幂等）。
 * 仍无 shotRef 的残余（音频占位/超分·去字幕坑位/生成中的存量自由占位）→ RtcFreeGenWorkbench。
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
	// 面层（结果预览）是否露出：预览页 + 播放头所在主轨片段有成片。
	// ⚠ 性能红线（第236轮）：只订阅**标量**（片段 kind），绝不订阅帧级 playheadUs——
	//   帧级订阅会让整个中栏每帧重渲；kind 不变时 zustand 按 Object.is 比对直接跳过重渲。
	const phSegKind = useRtcStore((s) => mainTrackSegAt(activeRtcDoc(s), s.playheadUs)?.seg.kind ?? null);
	const showResult = resultLayerVisible(tab, phSegKind);
	// 左栏选中素材/资产卡（布尔选择器）：预览页选了卡就该看到它，
	// 工作台叠层同样让位（否则播放头停在占位区时工作台会盖住素材预览）。
	const hasAssetSel = useRtcAssetSelStore((s) => !!s.selected || !!s.mediaSel);
	const showWorkbench = !showResult && !(tab === "preview" && hasAssetSel);
	// 剧本处理面（需求⑪）：右栏「整理剧本」打开的最上层叠层
	const scriptEditorOpen = useRtcCenterTabStore((s) => s.scriptEditorOpen);
	// 初始页签（会话首次挂载定一次）：优先按播放头下主轨片段——占位=工作台/有结果=预览，
	// 空白处按 doc 是否已有可播片段兜底。之后只有用户手动能换页签（需求⑨）。
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
			<div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden" style={{ position: "relative" }}>
				{/* ── 面：结果预览（顺序播放器常驻挂载，⚠ 绝不条件卸载）── */}
				<SequencePreviewSlot />
				<ViewportIdleHint />
				{/* ── 底：AI 工作台——不透明叠层盖住播放器（需求⑨的「底/面」在观感上等价：
				     面要露出时只需把本叠层去掉）。它常驻渲染，仅在成片预览时让位 */}
				{showWorkbench && (
					<div style={{ position: "absolute", inset: 0, zIndex: 7, background: "#101018", display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
						<WorkbenchBody />
					</div>
				)}
				{/* ── 最上：左栏选中素材/资产卡的预览叠层（仅「预览」页，自带不透明底）── */}
				{tab === "preview" && <AssetPreviewLayer />}
				{/* ── 剧本处理面（需求⑪）：右栏「整理剧本」打开，盖在最上层，用户手动关闭── */}
				{scriptEditorOpen && <RtcScriptEditorPane />}
			</div>
		</main>
	);
}
