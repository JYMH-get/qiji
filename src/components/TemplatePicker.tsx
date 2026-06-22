/**
 * TemplatePicker —— 提示词模板下拉（按 purpose 列出 catalog 模板）。
 *
 * 与 ModelPicker 不同：模板选择是各界面的本地态（不持久化到项目），故为受控组件，
 * value/onChange 由父组件维护。purpose 决定可选模板集（管理端 catalog 下发，热更新）。
 * 空值 = 跟随默认（不指定模板，由调用方走本地拼装提示词）。
 */
import { useMemo } from "react";
import type { Purpose } from "@/contract";
import { useCatalogStore } from "@/store/catalogStore";

interface TemplatePickerProps {
	purpose: Purpose;
	value: string;
	onChange: (id: string) => void;
	label?: string;
	style?: React.CSSProperties;
}

export default function TemplatePicker({ purpose, value, onChange, label = "提示词模板", style }: TemplatePickerProps) {
	const all = useCatalogStore((s) => s.catalog?.templates);
	const opts = useMemo(() => (all ?? []).filter((t) => t.purpose === purpose), [all, purpose]);

	return (
		<label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "rgba(255,255,255,0.55)", ...style }}>
			{label}
			<select
				value={value}
				onChange={(e) => onChange(e.target.value)}
				style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, color: "#fff", padding: "6px 8px", fontSize: 12, outline: "none", cursor: "pointer" }}
			>
				<option value="" style={{ background: "#1f1f2e" }}>跟随默认</option>
				{opts.map((t) => (
					<option key={t.id} value={t.id} style={{ background: "#1f1f2e" }}>{t.name}</option>
				))}
			</select>
		</label>
	);
}
