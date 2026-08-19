/**
 * PromptExpandButton —— 提示词「放大查看/编辑」按钮。
 * 放在任意提示词编辑区旁；点击打开全局大编辑弹窗（promptModalStore）。
 * getValue 在点击时取最新值；onSave 回写（省略=只读查看）。
 */
import type { ReactNode } from "react";
import { Maximize2 } from "lucide-react";
import { usePromptModalStore, type PromptModalApi, type MentionCandidate, type ImportAssetFn, type MatchAssetsFn } from "@/store/promptModalStore";
import type { PresetOption } from "@/lib/presetSchemes";

export function PromptExpandButton({
	title,
	getValue,
	onSave,
	readOnly,
	placeholder,
	className,
	style,
	size = 13,
	getExtra,
	getMentions,
	onImport,
	onMatchAssets,
	getPresets,
}: {
	title?: string;
	getValue: () => string;
	onSave?: (value: string) => void;
	readOnly?: boolean;
	placeholder?: string;
	className?: string;
	style?: React.CSSProperties;
	size?: number;
	/** 弹窗素材栏渲染（收 api：可上传/引用到光标/删除）：画布=NodeMaterialBay，资产模式=分镜素材条 */
	getExtra?: (api: PromptModalApi) => ReactNode;
	/** 输入 @ 的可选素材（每次读最新）：画布=节点素材，资产模式=分镜素材 */
	getMentions?: () => MentionCandidate[];
	/** 输入 # 导入项目资产到宿主素材区（画布=节点，资产模式=分镜） */
	onImport?: ImportAssetFn;
	/** 「匹配资产」：委托宿主现成匹配逻辑（画布/资产模式各自的匹配函数） */
	onMatchAssets?: MatchAssetsFn;
	/** 出图预设方案（每次读最新）：有则弹窗显示「预设方案」插入按钮（图片节点用） */
	getPresets?: () => PresetOption[];
}) {
	return (
		<button
			type="button"
			title="放大查看/编辑"
			className={`nodrag ${className ?? ""}`}
			onMouseDown={(e) => e.stopPropagation()}
			onClick={(e) => {
				e.stopPropagation();
				usePromptModalStore.getState().openPrompt({
					title,
					value: getValue(),
					onSave: readOnly ? undefined : onSave,
					readOnly: readOnly ?? !onSave,
					placeholder,
					extra: getExtra,
					mentions: getMentions,
					onImport,
					onMatchAssets,
					presets: getPresets,
				});
			}}
			style={{
				display: "inline-flex", alignItems: "center", justifyContent: "center",
				background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.12)",
				borderRadius: 6, color: "rgba(255,255,255,0.7)", cursor: "pointer", padding: 3,
				...style,
			}}
		>
			<Maximize2 size={size} />
		</button>
	);
}
