import type { AssetRef } from "@/contract";
import { useOfficialMaterialPreparation } from "@/hooks/useOfficialMaterialPreparation";
import { supportsOfficialMaterials } from "@/services/materialPolicy";
import { useCatalogStore } from "@/store/catalogStore";

/** 官方线路自动准备图像、视频和音频；素材库 ID 仅在会话和生成请求中使用。 */
export function IdentityAssetToggle({ active, onToggle, modelId, material, kind = 'image' }: { active: boolean; onToggle: () => void; modelId?: string; material?: AssetRef; kind?: 'image' | 'video' | 'audio' }) {
	const automatic = useCatalogStore(s => supportsOfficialMaterials(s.catalog?.models.find(m => m.id === modelId)));
	const enabled = automatic || active;
	const typedMaterial = material && kind !== 'image' ? { ...material, officialAssetType: kind === 'video' ? 'Video' as const : 'Audio' as const } : material;
	const { state, retry } = useOfficialMaterialPreparation(modelId, typedMaterial, enabled);
	const mediaLabel = { image: '图片', video: '视频', audio: '音频' }[kind];
	const status = enabled ? state.status : "Ignored";
	const failed = status === "Failed";
	const checking = status === "Processing" && state.phase !== "uploading";
	const label = status === "Active" ? "官方审核通过，生成直接复用" : failed ? `处理失败：${state.error || "请重试"}` : status === "Processing" ? (state.checkedAt ? "正在预处理，无法使用" : "正在检查素材记录与有效性") : "不处理";
	const background = status === "Active" ? "#16864b" : failed ? "#c93442" : status === "Processing" ? (checking ? "#626976" : "#6d28d9") : "#626976";
	const icon = automatic ? "素" : "人";
	return (
		<button
			type="button"
			aria-pressed={automatic ? undefined : active}
			aria-label={automatic ? (failed ? `重试官方${mediaLabel}素材` : `官方${mediaLabel}素材：${label}`) : failed ? "重试人像素材" : active ? "改为普通参考" : "改为人像素材"}
			data-material-status={status} data-material-phase={checking ? "checking" : state.phase}
			title={automatic ? `${label}${failed ? "；点击重试" : ""}` : `${label}；${failed ? "点击重试，右键改为普通参考" : active ? "点击改为普通参考" : "点击改为人像素材"}`}
			onPointerDown={(e) => e.stopPropagation()}
			onDoubleClick={(e) => e.stopPropagation()}
			onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); if (!automatic && active) onToggle(); }}
			onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (failed) retry(); else if (!automatic) onToggle(); }}
			style={{
				position: "absolute", right: 1, bottom: 1, zIndex: 6,
				height: 15, minWidth: 15, padding: "0 2px", borderRadius: 4,
				border: enabled ? "1px solid rgba(196,181,253,0.95)" : "1px solid rgba(255,255,255,0.35)",
				background,
				color: "#fff", fontSize: 8, fontWeight: 700, lineHeight: "13px", cursor: automatic && !failed ? "default" : "pointer",
				boxShadow: "0 1px 3px rgba(0,0,0,0.45)",
			}}
		>
			{status === "Active" ? `${icon}✓` : failed ? `${icon}!` : icon}
		</button>
	);
}
