/**
 * RtcMaterialStrip —— 实时剪辑右栏「垫图区」素材条（ShotMaterialStrip 的轻量增强版）。
 * 与资产模式同一套数据与操作（shotMaterialOps：增删/排序/图例同步），另加：
 *   - 缩略图间拖拽重排（reorderShotMaterial：图例整体重建 + 正文 @ 引用重映射）；
 *   - 容器接收 `application/x-qiji-asset` drop（资产助手拖入垫图，payload 同 Frame161195 素材区）；
 *   - 外部文件 drop / ＋ 上传（走 OSS + 本地副本，addLocalShotMaterials）。
 */
import { useRef } from "react";
import { useProjectStore } from "@/store/projectStore";
import { openLightbox } from "@/store/lightboxStore";
import { materialTags, mediaOf, TAG_BADGE, BADGE_BG, type MediaKind } from "@/lib/shotMaterials";
import { addLocalShotMaterials, removeShotMaterial, reorderShotMaterial, addShotMaterialFromAsset, isIdentityShotMaterial, setShotMaterialIdentity, materialKindFromAssetCat } from "@/lib/shotMaterialOps";
import { usePendingUploads, uploadKeys } from "@/store/uploadStore";
import { IdentityAssetToggle } from "@/components/IdentityAssetToggle";
import { useEffectiveModelKey } from "@/components/ModelPicker";
import { useCatalogStore } from "@/store/catalogStore";

export function RtcMaterialStrip({ episodeId, shotId, identityEnabled }: { episodeId: string; shotId: string; identityEnabled?: boolean }) {
	const shot = useProjectStore((s) => s.episodes.find((e) => e.id === episodeId)?.shots.find((x) => x.id === shotId));
	const materials = shot?.materials ?? [];
	const projectVideoModel = useEffectiveModelKey("video");
	const activeVideoModel = shot?.overrides?.videoModelKey || projectVideoModel;
	const supportsIdentity = useCatalogStore((s) => !!s.catalog?.models.find((m) => m.id === activeVideoModel)?.officialAssets);
	const showIdentity = identityEnabled ?? supportsIdentity;
	const fileRef = useRef<HTMLInputElement>(null);
	const dragMat = useRef<string | null>(null); // 内部重排来源素材 id
	const tags = materialTags(materials);
	const uploading = usePendingUploads(uploadKeys.shot(episodeId, shotId));

	// 容器 drop：资产助手 payload / 外部文件（内部重排落空白处=忽略，重排只在缩略图之间发生）
	const onDrop = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		if (dragMat.current) { dragMat.current = null; return; }
		const raw = e.dataTransfer.getData("application/x-qiji-asset") || e.dataTransfer.getData("text/plain");
		if (raw) {
			try {
				const d = JSON.parse(raw);
				const u = d?.localUri || d?.uri || d?.url; // 展示优先本地 uri（CSP）；公网 url 提交时由 ensurePublicUrl 取回
				if (u) {
					const md: MediaKind = d?.media === "video" || d?.media === "audio" ? d.media : "image";
					addShotMaterialFromAsset(episodeId, shotId, { assetId: d?.assetId || d?.id || undefined, uri: u, name: d?.name || "素材", media: md, kind: materialKindFromAssetCat(d?.cat) });
					return;
				}
			} catch { /* 落到文件分支 */ }
		}
		const files = Array.from(e.dataTransfer.files || []).filter((f) => /^(image|video|audio)\//.test(f.type));
		if (files.length) void addLocalShotMaterials(episodeId, shotId, files);
	};

	return (
		<div
			data-rtc-material-strip={`${episodeId}:${shotId}`}
			onDragOver={(e) => { e.preventDefault(); }}
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
						draggable
						onDragStart={(e) => { dragMat.current = m.id; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/x-qiji-rtc-mat", m.id); }}
						onDragEnd={() => { dragMat.current = null; }}
						onDragOver={(e) => { if (dragMat.current && dragMat.current !== m.id) { e.preventDefault(); e.stopPropagation(); } }}
						onDrop={(e) => {
							// 缩略图上落下=重排（走 shotMaterialOps：图例重建 + 正文 @ 引用重映射）
							if (dragMat.current && dragMat.current !== m.id) {
								e.preventDefault(); e.stopPropagation();
								reorderShotMaterial(episodeId, shotId, dragMat.current, m.id);
							}
							dragMat.current = null;
						}}
						title={`${tags[m.id]}${m.name ? `·${m.name}` : ""}（双击放大 / 右键删除 / 拖动排序）`}
						onDoubleClick={() => m.uri && openLightbox({ uri: m.uri, media: md, name: m.name || "" })}
						onContextMenu={(e) => { e.preventDefault(); removeShotMaterial(episodeId, shotId, m.id); }}
						style={{ position: "relative", width: 44, height: 44, borderRadius: 8, overflow: "hidden", border: "1px solid rgba(255,255,255,0.12)", flexShrink: 0, background: "rgba(255,255,255,0.05)", cursor: "grab" }}
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
						<button
							onClick={(e) => { e.stopPropagation(); removeShotMaterial(episodeId, shotId, m.id); }}
							title="删除"
							className="hidden group-hover:flex"
							style={{ position: "absolute", top: 0, right: 0, width: 15, height: 15, alignItems: "center", justifyContent: "center", fontSize: 10, color: "#fff", background: "rgba(0,0,0,0.6)", borderBottomLeftRadius: 4, border: "none", cursor: "pointer", lineHeight: 1 }}
						>✕</button>
						{showIdentity && md === "image" && (
							<IdentityAssetToggle active={identity} onToggle={() => setShotMaterialIdentity(episodeId, shotId, m.id, !identity)} />
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
				onClick={() => fileRef.current?.click()}
				title="添加本地素材（图/视频/音频）"
				style={{ width: 44, height: 44, borderRadius: 8, border: "1px dashed rgba(255,255,255,0.25)", background: "transparent", color: "rgba(255,255,255,0.6)", fontSize: 18, lineHeight: 1, cursor: "pointer", flexShrink: 0 }}
			>+</button>
			<input
				ref={fileRef}
				type="file"
				accept="image/*,video/*,audio/*"
				multiple
				style={{ display: "none" }}
				onChange={(e) => { const fs = Array.from(e.target.files || []); if (fs.length) void addLocalShotMaterials(episodeId, shotId, fs); e.target.value = ""; }}
			/>
		</div>
	);
}
