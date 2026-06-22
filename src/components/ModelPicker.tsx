/**
 * ModelPicker —— 各生成界面的「模型选择」下拉（剧本/角色/群像/场景/生物/物品/视频共用）。
 *
 * 数据源：catalogStore（管理端下发的模型，按 capability 过滤；尊重设置里的「启用模型」子集）。
 * 选择持久化到项目级 projectModelConfig[cap]（随项目落盘、切页/重启不丢）；
 * 未做项目级选择时回退到设置面板的该能力默认模型。
 *
 * 生成时用 effectiveModelKey(cap) 解析出生效模型，显式传给 runPurpose({modelKey})，
 * 不再只依赖 resolveAssetModelKey 的全局设置默认。
 */
import type { Capability } from "@/contract";
import { useCatalogStore } from "@/store/catalogStore";
import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore } from "@/store/settingsStore";

const capDefaults = (s: ReturnType<typeof useSettingsStore.getState>, cap: Capability) =>
	({ image: s.imageDefaults, video: s.videoDefaults, text: s.textDefaults, audio: s.audioDefaults } as const)[cap];

/** 非 hook：解析某能力当前生效模型 key（项目级选择 → 设置默认 → ""）。供生成代码调用。 */
export function effectiveModelKey(cap: Capability): string {
	const override = useProjectStore.getState().projectModelConfig?.[cap];
	if (override) return override;
	return capDefaults(useSettingsStore.getState(), cap)?.defaultModelId ?? "";
}

interface ModelPickerProps {
	cap: Capability;
	label?: string;
	style?: React.CSSProperties;
}

export default function ModelPicker({ cap, label = "模型", style }: ModelPickerProps) {
	const models = useCatalogStore((s) => s.catalog?.models);
	const override = useProjectStore((s) => s.projectModelConfig?.[cap]);
	const setProjectModelConfig = useProjectStore((s) => s.setProjectModelConfig);
	const settingsDefault = useSettingsStore((s) => capDefaults(s, cap)?.defaultModelId ?? "");
	const selected = useSettingsStore((s) => s.selectedModels?.[cap]) ?? [];

	// 该能力可选模型：尊重设置里的「启用模型」子集（为空=全部）
	const opts = (models ?? [])
		.filter((m) => m.capability === cap)
		.filter((m) => selected.length === 0 || selected.includes(m.id));

	const want = override || settingsDefault || "";
	const value = opts.some((o) => o.id === want) ? want : "";

	return (
		<label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "rgba(255,255,255,0.55)", ...style }}>
			{label}
			<select
				value={value}
				onChange={(e) => setProjectModelConfig({ [cap]: e.target.value })}
				style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, color: "#fff", padding: "6px 8px", fontSize: 12, outline: "none", cursor: "pointer" }}
			>
				<option value="" style={{ background: "#1f1f2e" }}>
					{opts.length ? "请选择模型…" : "未配置模型（先在设置中加载）"}
				</option>
				{opts.map((m) => (
					<option key={m.id} value={m.id} style={{ background: "#1f1f2e" }}>
						{m.label}
					</option>
				))}
			</select>
		</label>
	);
}
