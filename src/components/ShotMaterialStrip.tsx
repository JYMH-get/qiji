/**
 * ShotMaterialStrip —— 资产模式分镜「素材缩略条」，供提示词放大弹窗使用。
 * 支持：＋上传本地素材 · 双击放大查看 · 右键/✕ 删除。
 * 实时读 store（episodeId+shotId），上传/删除即时反映。@tag 编号与上游数组一致。
 * （引用素材改由提示词框输入 @ 完成，不再点缩略图插入。）
 */
import { useRef } from "react";
import { useProjectStore } from "@/store/projectStore";
import { openLightbox } from "@/store/lightboxStore";
import { materialTags, mediaOf, TAG_BADGE, BADGE_BG } from "@/lib/shotMaterials";
import { addLocalShotMaterials, removeShotMaterial } from "@/lib/shotMaterialOps";
import { usePendingUploads, uploadKeys } from "@/store/uploadStore";

export function ShotMaterialStrip({
	episodeId,
	shotId,
}: {
	episodeId: string;
	shotId: string;
}) {
	const materials = useProjectStore(
		(s) => s.episodes.find((e) => e.id === episodeId)?.shots.find((x) => x.id === shotId)?.materials ?? [],
	);
	const fileRef = useRef<HTMLInputElement>(null);
	const tags = materialTags(materials);
	const uploading = usePendingUploads(uploadKeys.shot(episodeId, shotId)); // 在途上传数 → 占位转圈

	return (
		<div data-shot-material-strip={`${episodeId}:${shotId}`} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
			{materials.map((m) => {
				const md = mediaOf(m);
				const num = tags[m.id]?.match(/\d+/)?.[0] ?? "";
				return (
					<div
						key={m.id}
						className="group"
						title={`${tags[m.id]}${m.name ? `·${m.name}` : ""}（双击放大 / 右键删除）`}
						onDoubleClick={() => m.uri && openLightbox({ uri: m.uri, media: md, name: m.name || "" })}
						onContextMenu={(e) => { e.preventDefault(); removeShotMaterial(episodeId, shotId, m.id); }}
						style={{ position: "relative", width: 44, height: 44, borderRadius: 8, overflow: "hidden", border: "1px solid rgba(255,255,255,0.12)", flexShrink: 0, background: "rgba(255,255,255,0.05)", cursor: "zoom-in" }}
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
						{/* 悬停删除 */}
						<button
							onClick={(e) => { e.stopPropagation(); removeShotMaterial(episodeId, shotId, m.id); }}
							title="删除"
							className="hidden group-hover:flex"
							style={{ position: "absolute", top: 0, right: 0, width: 15, height: 15, alignItems: "center", justifyContent: "center", fontSize: 10, color: "#fff", background: "rgba(0,0,0,0.6)", borderBottomLeftRadius: 4, border: "none", cursor: "pointer", lineHeight: 1 }}
						>✕</button>
					</div>
				);
			})}
			{/* 在途上传占位：转圈，表示正在传 OSS */}
			{Array.from({ length: uploading }).map((_, i) => (
				<div key={`up-${i}`} title="上传中…" style={{ width: 44, height: 44, borderRadius: 8, border: "1px dashed rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.05)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
					<span className="sb-spin" style={{ color: "#fff", fontSize: 15 }}>↻</span>
				</div>
			))}
			{/* ＋ 上传本地素材 */}
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
