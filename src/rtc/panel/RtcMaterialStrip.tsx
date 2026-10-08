import { AccelerationMaterialStatus } from '@/components/AccelerationMaterialStatus';
import { supportsOfficialMaterials } from "@/services/materialPolicy";
/**
 * RtcMaterialStrip —— 实时剪辑右栏「垫图区」素材条（ShotMaterialStrip 的轻量增强版）。
 * 与资产模式同一套数据与操作（shotMaterialOps：增删/排序/图例同步），另加：
 *   - 缩略图间拖拽重排（reorderShotMaterial：图例整体重建 + 正文 @ 引用重映射）；
 *   - 容器接收 `application/x-qiji-asset` drop（资产助手拖入垫图，payload 同 Frame161195 素材区）；
 *   - 外部文件 drop / ＋ 上传（走 OSS + 本地副本，addLocalShotMaterials）。
 */
import { useLayoutEffect, useRef, type ReactNode, type SyntheticEvent } from "react";
import { useProjectStore } from "@/store/projectStore";
import { usePromptModalStore, type PromptModalApi } from "@/store/promptModalStore";
import { openShotMaterialLightbox } from "@/lib/shotMaterialLightbox";
import { materialTags, mediaOf, TAG_BADGE, BADGE_BG } from "@/lib/shotMaterials";
import { addLocalShotMaterials, removeShotMaterial, reorderShotMaterial, isIdentityShotMaterial, setShotMaterialIdentity } from "@/lib/shotMaterialOps";
import { usePendingUploads, uploadKeys } from "@/store/uploadStore";
import { IdentityAssetToggle } from "@/components/IdentityAssetToggle";
import { useEffectiveModelKey } from "@/components/ModelPicker";
import { useCatalogStore } from "@/store/catalogStore";
import { shotPromptMediaDrop } from "./rtcPromptDrop";

export function RtcMaterialStrip({ episodeId, shotId, identityEnabled, rightActions, disabled = false, promptApi }: { episodeId: string; shotId: string; identityEnabled?: boolean; rightActions?: ReactNode; disabled?: boolean; promptApi?: PromptModalApi }) {
	const owner = useProjectStore((s) => s.projectInstanceId);
	const promptSessionId = usePromptModalStore((s) => promptApi ? s.sessionId : undefined);
	const loading = useProjectStore((s) => s.isProjectLoading);
	const shot = useProjectStore((s) => s.episodes.find((e) => e.id === episodeId)?.shots.find((x) => x.id === shotId));
	const materials = shot?.materials ?? [];
	const projectVideoModel = useEffectiveModelKey("video");
	const activeVideoModel = shot?.overrides?.videoModelKey || projectVideoModel;
	const supportsIdentity = useCatalogStore((s) => supportsOfficialMaterials(s.catalog?.models.find((m) => m.id === activeVideoModel)));
	const showIdentity = identityEnabled ?? supportsIdentity;
	const fileRef = useRef<HTMLInputElement>(null);
	const dragMat = useRef<string | null>(null); // 内部重排来源素材 id
	const pickerScope = useRef<string | null>(null);
	const scope = JSON.stringify([owner, episodeId, shotId]);
	const liveScope = useRef(scope);
	const mounted = useRef(true);
	const readOnly = disabled || loading || !shot;
	const blocked = useRef(readOnly);
	blocked.current = readOnly;
	// 文件选择器可以跨越重新渲染；锁定过或换目标后，旧选择不得在解锁时迟到写回。
	if (liveScope.current !== scope || readOnly) {
		pickerScope.current = null;
		dragMat.current = null;
	}
	liveScope.current = scope;
	useLayoutEffect(() => {
		mounted.current = true;
		return () => { mounted.current = false; pickerScope.current = null; dragMat.current = null; };
	}, []);
	const canEdit = () => {
		const state = useProjectStore.getState();
		return mounted.current && !blocked.current && liveScope.current === scope
			&& state.projectInstanceId === owner && !state.isProjectLoading
			&& state.episodes.some(ep => ep.id === episodeId && ep.shots.some(s => s.id === shotId));
	};
	const blockWriteEvent = (event: SyntheticEvent) => {
		if (canEdit()) return;
		event.preventDefault();
		event.stopPropagation();
	};
	const tags = materialTags(materials);
	const uploading = usePendingUploads(uploadKeys.shot(episodeId, shotId));
	const addDroppedMedia = shotPromptMediaDrop(episodeId, shotId);

	// 容器 drop：资产助手 payload / 外部文件（内部重排落空白处=忽略，重排只在缩略图之间发生）
	const onDrop = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		if (!canEdit()) { dragMat.current = null; return; }
		if (dragMat.current) { dragMat.current = null; return; }
		addDroppedMedia(e.dataTransfer);
	};

	return (
		<div
			data-rtc-material-strip={`${episodeId}:${shotId}`}
			aria-disabled={readOnly || undefined}
			onClickCapture={blockWriteEvent}
			onContextMenuCapture={blockWriteEvent}
			onKeyDownCapture={(e) => { if (e.key === "Enter" || e.key === " ") blockWriteEvent(e); }}
			onDragOver={(e) => { e.preventDefault(); if (!canEdit()) e.dataTransfer.dropEffect = "none"; }}
			onDrop={onDrop}
			style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", minHeight: 52, padding: 4, borderRadius: 8, border: "1px dashed rgba(255,255,255,0.10)" }}
			title="垫图区：拖入资产助手素材 / 本地文件；拖动缩略图可排序"
		>
			{materials.map((m) => {
				const md = mediaOf(m);
				const num = tags[m.id]?.match(/\d+/)?.[0] ?? "";
				const imageIndex = md === "image" ? materials.filter((x) => mediaOf(x) === "image").findIndex((x) => x.id === m.id) : -1;
				const identity = imageIndex >= 0 && isIdentityShotMaterial(m, imageIndex, shot?.overrides?.officialAssetIndexes);
				return (
					<div
						key={m.id}
						className="group"
						draggable={!readOnly}
						onDragStart={(e) => {
							if (!canEdit()) { e.preventDefault(); return; }
							dragMat.current = m.id; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/x-qiji-rtc-mat", m.id);
						}}
						onDragEnd={() => { dragMat.current = null; }}
						onDragOver={(e) => { if (dragMat.current && dragMat.current !== m.id) { e.preventDefault(); e.stopPropagation(); } }}
						onDrop={(e) => {
							if (!canEdit()) { e.preventDefault(); e.stopPropagation(); dragMat.current = null; return; }
							// 缩略图上落下=重排（走 shotMaterialOps：图例重建 + 正文 @ 引用重映射）
							if (dragMat.current && dragMat.current !== m.id) {
								e.preventDefault(); e.stopPropagation();
								reorderShotMaterial(episodeId, shotId, dragMat.current, m.id);
							}
							dragMat.current = null;
						}}
						title={`${tags[m.id]}${m.name ? `·${m.name}` : ""}（${readOnly ? "双击放大" : "双击放大 / 右键删除 / 拖动排序"}）`}
						onDoubleClick={() => openShotMaterialLightbox(episodeId, shotId, m.id, { owner, canReorder: canEdit, promptApi, promptSessionId })}
						onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); if (canEdit()) removeShotMaterial(episodeId, shotId, m.id); }}
						style={{ position: "relative", width: 44, height: 44, borderRadius: 8, overflow: "hidden", border: "1px solid rgba(255,255,255,0.12)", flexShrink: 0, background: "rgba(255,255,255,0.05)", cursor: readOnly ? "zoom-in" : "grab" }}
					>
						{md === "video" ? (
							<video src={m.uri} style={{ width: "100%", height: "100%", objectFit: "cover" }} muted preload="metadata" />
						) : md === "audio" ? (
							<span style={{ display: "flex", width: "100%", height: "100%", alignItems: "center", justifyContent: "center", fontSize: 16 }}>🎵</span>
						) : (
							<img src={m.uri} style={{ width: "100%", height: "100%", objectFit: "cover" }} draggable={false} />
						)}
						<span style={{ position: "absolute", top: 0, left: 0, fontSize: 8, lineHeight: "12px", fontWeight: 700, color: "#fff", background: BADGE_BG[md], padding: "0 3px", borderBottomRightRadius: 4 }}>
							{TAG_BADGE[md]}{num}
						</span>
						{m.rtcFrameRole && <span style={{ position: "absolute", left: 0, bottom: 0, fontSize: 8, lineHeight: "12px", padding: "0 3px", color: "#fff", background: "rgba(0,0,0,0.75)" }}>
							{m.rtcFrameRole === "first" ? "首帧" : "尾帧"}
						</span>}
						<button
							type="button" disabled={readOnly}
							onClick={(e) => { e.stopPropagation(); if (canEdit()) removeShotMaterial(episodeId, shotId, m.id); }}
							title="删除"
							className="hidden group-hover:flex"
							style={{ position: "absolute", top: 0, right: 0, width: 15, height: 15, alignItems: "center", justifyContent: "center", fontSize: 10, color: "#fff", background: "rgba(0,0,0,0.6)", borderBottomLeftRadius: 4, border: "none", cursor: "pointer", lineHeight: 1 }}
						>✕</button>
						<AccelerationMaterialStatus modelId={activeVideoModel} kind={md} material={{ id: useProjectStore.getState().blobByUri(m.uri)?.id, url: m.uri, name: m.name }} />
						{showIdentity && (
							<IdentityAssetToggle kind={md} modelId={activeVideoModel} material={{ id: useProjectStore.getState().blobByUri(m.uri)?.id, url: m.uri, name: m.name }} active={identity} onToggle={() => { if (canEdit()) setShotMaterialIdentity(episodeId, shotId, m.id, !identity); }} />
						)}
					</div>
				);
			})}
			{Array.from({ length: uploading }).map((_, i) => (
				<div key={`up-${i}`} title="上传中…" style={{ width: 44, height: 44, borderRadius: 8, border: "1px dashed rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.05)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
					<span className="sb-spin" style={{ color: "#fff", fontSize: 15 }}>↻</span>
				</div>
			))}
			<button
				type="button" disabled={readOnly}
				onClick={() => {
					if (!canEdit()) return;
					pickerScope.current = scope;
					fileRef.current?.click();
				}}
				title="添加本地素材（图/视频/音频）"
				style={{ width: 44, height: 44, borderRadius: 8, border: "1px dashed rgba(255,255,255,0.25)", background: "transparent", color: "rgba(255,255,255,0.6)", fontSize: 18, lineHeight: 1, cursor: "pointer", flexShrink: 0 }}
			>+</button>
			{rightActions && <div style={{ marginLeft: "auto", flexShrink: 0 }}>{rightActions}</div>}
			<input
				ref={fileRef}
				type="file"
				disabled={readOnly}
				accept="image/*,video/*,audio/*"
				multiple
				style={{ display: "none" }}
				onChange={(e) => {
					const accepted = pickerScope.current === scope && canEdit();
					pickerScope.current = null;
					const fs = Array.from(e.target.files || []);
					e.target.value = "";
					if (accepted && fs.length) void addLocalShotMaterials(episodeId, shotId, fs);
				}}
			/>
		</div>
	);
}
