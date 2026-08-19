/**
 * 实时剪辑 · 中央区（三页签重构后定稿：**单一预览视口，无子栏**）：
 *   - 底层=时间指针预览（顺序预览播放器 RtcSequencePlayer，播放头画面+控制）；
 *   - 左栏素材面板选中素材（rtcAssetSelStore：五类资产=主图大图 / 视频·音频=AV 预览）时以**叠层覆盖**
 *     显示素材预览——时间轴选中片段不切换中栏内容（片段详情在右栏；播放头本身能看到片段画面）；
 *   - 五类资产预览时，叠层右缘竖排「生成历史」缩略条（主图+历史图，数据源与 RtcAssetProps 历史网格
 *     同源 asset.image/asset.images；观感对齐 AssetWorkbench 主图历史）：点缩略图=预览该张（不改主图）、
 *     当前预览项高亮、悬停「设为主图」（与 RtcAssetProps 同一 setAssetMainImage 调用）；
 *     时间指针预览态 / 视频·音频素材预览 / 资产无图 时不显示；
 *   - 原「AI 生成」引导子栏已**整体取消**：四步工作台移入右栏三页签窗口的「剧本/分镜」页
 *     （RtcAiFlow 的 RtcFlowScriptPage/RtcFlowShotsPage），占位符快捷生成在右栏「属性」页
 *     （RtcShotWorkbench 完整版）。
 *
 * ⚠ 播放不中断（勿回退）：RtcSequencePlayer 挂在主区列里，素材预览的显隐是**叠层覆盖**（绝不条件
 * 卸载播放器）——切换素材选中/取消不打断播放。
 */
import { useState } from "react";
import { Music } from "lucide-react";
import { useProjectStore } from "@/store/projectStore";
import { useRtcStore } from "@/store/rtcStore";
import { useAssetFormStore } from "@/store/assetFormStore";
import { openLightbox } from "@/store/lightboxStore";
import { RtcSequencePlayer } from "./RtcSequencePlayer";
import { docHasAnySegment } from "./rtcPlayback";
import { useRtcAssetSelStore } from "./rtcAssetSelStore";
import { collectProjectImageItems } from "./asset/rtcAssetData";

/** 顺序预览播放器挂载点：doc 有任何片段才显示；布尔选择器——选中/播放头变化不重渲本壳。 */
function SequencePreviewSlot() {
	const show = useRtcStore((s) => !!s.doc && docHasAnySegment(s.doc));
	return show ? <RtcSequencePlayer /> : null;
}

/* ════════════════ 主区（单一预览视口） ════════════════ */

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

/* ════════════════ 中央区壳 ════════════════ */

export function RtcCenterStage() {
	return (
		<main className="flex-1 min-w-0 min-h-0 flex overflow-hidden">
			{/* ── 单一预览视口：底层=顺序播放器（时间指针预览），素材选中时叠层覆盖（播放器不卸载） ── */}
			<div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden" style={{ position: "relative" }}>
				<SequencePreviewSlot />
				<ViewportIdleHint />
				<AssetPreviewLayer />
			</div>
		</main>
	);
}
