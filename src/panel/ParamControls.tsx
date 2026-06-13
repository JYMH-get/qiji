import { Slider } from "@/components/ui/slider";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ParamField } from "@/services/modelAdapter";

/**
 * 单个参数控件：由 ParamField.type 决定渲染为 enum / number / boolean / text。
 * 换模型 = 换 schema，控件随之重渲。
 */
export function ParamControl({
	field,
	value,
	onChange,
}: {
	field: ParamField;
	value: unknown;
	onChange: (next: unknown) => void;
}) {
	if (field.type === "enum") {
		const current =
			typeof value === "string" ? value : String(field.default ?? "");
		return (
			<Select value={current} onValueChange={onChange}>
				<SelectTrigger>
					<SelectValue placeholder="选择" />
				</SelectTrigger>
				<SelectContent>
					{(field.options ?? []).map((opt) => (
						<SelectItem key={opt} value={opt}>
							{opt}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		);
	}

	if (field.type === "number") {
		const current =
			typeof value === "number" ? value : Number(field.default ?? 0);
		const min = field.min ?? 0;
		const max = field.max ?? 100;
		const step = field.step ?? 1;
		return (
			<div className="flex items-center gap-3">
				<Slider
					value={[current]}
					min={min}
					max={max}
					step={step}
					onValueChange={(v) => onChange(v[0])}
					className="flex-1"
				/>
				<span className="w-12 text-right font-mono text-xs text-foreground">
					{current}
					{field.unit ?? ""}
				</span>
			</div>
		);
	}

	if (field.type === "boolean") {
		const current = Boolean(value ?? field.default);
		return (
			<Button
				variant={current ? "default" : "outline"}
				size="sm"
				onClick={() => onChange(!current)}
			>
				{current ? "开" : "关"}
			</Button>
		);
	}

	// text
	const current =
		typeof value === "string" ? value : String(field.default ?? "");
	return (
		<input
			value={current}
			onChange={(e) => onChange(e.target.value)}
			className={cn(
				"h-8 w-full rounded-md border border-input bg-background/60 px-3 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring",
			)}
		/>
	);
}
