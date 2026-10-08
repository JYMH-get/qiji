import { useState, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown } from "lucide-react";
import { useCapModelOptions, useFamilyOrder } from "@/components/ModelPicker";
import {
	familyFirstSelection, familyOf, modelFamilies, modelForFamily, modelForLine,
} from "@/services/adapters/localChannels";
import { ASPECT_LABELS, METHOD_LABELS, type VideoMethod } from "@/lib/videoMethods";
import { withCurrentOption } from "./rtcShotSubmission";
import type { RtcGenerationDuration } from "./rtcGenerationDuration";
import "./RtcGenerationPicker.css";
import { useRouteSuccessRates } from "@/components/RouteSuccessRate";

export interface RtcGenerationParams {
	duration: RtcGenerationDuration;
	aspect: string;
	resolution: string;
}

export interface RtcGenerationPickerProps extends RtcGenerationParams {
	autoDuration?: number;
	modelKey?: string;
	onModelChange: (id: string) => void;
	method?: string;
	methods?: readonly string[];
	onMethodChange?: (method: string) => void;
	requirements: {
		durations: readonly number[];
		aspects: readonly string[];
		resolutions: readonly string[];
	};
	onParamsChange: (patch: Partial<RtcGenerationParams>) => void;
	children?: ReactNode;
}

type MenuKey = "family" | "line" | "variant" | "method" | "params";
const methodLabel = (value: string) => METHOD_LABELS[value as VideoMethod] ?? value;

interface PickerMenuProps {
	menu: MenuKey;
	activeMenu: MenuKey | null;
	setActiveMenu: (menu: MenuKey | null) => void;
	label: string;
	value: string;
	suffix?: string;
	detail?: string;
	children: ReactNode;
	unavailable?: boolean;
}

function PickerMenu({ menu, activeMenu, setActiveMenu, label, value, suffix, detail, children, unavailable }: PickerMenuProps) {
	return (
		<DropdownMenu.Root
			modal={false}
			open={activeMenu === menu}
			onOpenChange={(open) => {
				if (open) setActiveMenu(menu);
				else if (activeMenu === menu) setActiveMenu(null);
			}}
		>
			<DropdownMenu.Trigger asChild>
				<button
					type="button"
					className="rtc-generation-picker__pill"
					aria-label={`${label}：${value}${suffix ? ` ${suffix}` : ""}${unavailable ? "（当前不可用）" : ""}`}
					title={`仅本分镜 · ${label}：${value}${detail ? ` · ${detail}` : ""}${unavailable ? "（当前不可用）" : ""}`}
				>
					<span className="rtc-generation-picker__value">{value}</span>
					{suffix && <span className="rtc-generation-picker__rate">{suffix}</span>}
					<ChevronDown size={12} aria-hidden="true" />
				</button>
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					className={`rtc-generation-picker__menu${menu === "params" ? " rtc-generation-picker__menu--params" : ""}`}
					aria-label={label}
					align="start"
					sideOffset={6}
					collisionPadding={8}
				>
					{children}
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}

function Choice({ value, children, keepOpen = false }: { value: string; children: ReactNode; keepOpen?: boolean }) {
	return (
		<DropdownMenu.RadioItem
			className="rtc-generation-picker__choice"
			value={value}
			onSelect={keepOpen ? (event) => event.preventDefault() : undefined}
		>
			{children}
		</DropdownMenu.RadioItem>
	);
}

/** Controlled RTC controls: catalog changes never rewrite the selected model or parameters. */
export function RtcGenerationPicker({
	modelKey, onModelChange, method, methods = [], onMethodChange,
	duration, autoDuration, aspect, resolution, requirements, onParamsChange, children,
}: RtcGenerationPickerProps) {
	const rateForModel = useRouteSuccessRates();
	const [activeMenu, setActiveMenu] = useState<MenuKey | null>(null);
	const options = useCapModelOptions("video");
	const families = modelFamilies(options, useFamilyOrder());
	const selection = familyFirstSelection(families, modelKey);
	const family = familyOf(modelKey, families);
	const channel = selection.current;
	const variant = channel?.choices.find((choice) => choice.id === modelKey);
	const familyLabel = family?.familyName || modelKey || (families.length ? "选择模型" : "无可用模型");
	const methodOptions = method ? withCurrentOption(methods, method) : [...methods];
	const menuProps = { activeMenu, setActiveMenu };
	const selectModel = (next: string) => {
		if (next && next !== modelKey) onModelChange(next);
	};

	return (
		<div className="rtc-generation-picker" role="group" aria-label="本分镜视频生成设置">
			<PickerMenu {...menuProps} menu="family" label="模型家族" value={familyLabel} unavailable={!!modelKey && !family}>
				{!!modelKey && !family && (
					<div className="rtc-generation-picker__notice">当前模型不可用：{modelKey}</div>
				)}
				{families.length ? (
					<DropdownMenu.RadioGroup value={family ? `family:${family.familyId}` : undefined} onValueChange={(value) => selectModel(modelForFamily(value.slice(7), modelKey, families))}>
						{families.map((item) => <Choice key={item.familyId} value={`family:${item.familyId}`}>{item.familyName}</Choice>)}
					</DropdownMenu.RadioGroup>
				) : <div className="rtc-generation-picker__notice">无可用视频模型</div>}
			</PickerMenu>

			{!!selection.channels.length && (
				<PickerMenu {...menuProps} menu="line" label="线路" value={channel?.channel || "选择线路"} suffix={channel ? rateForModel(modelKey).compact : undefined} detail={rateForModel(modelKey).expanded}>
					<DropdownMenu.RadioGroup value={channel?.channel} onValueChange={(value) => selectModel(modelForLine(`src:${value}`, modelKey, families))}>
						{selection.channels.map((item) => <Choice key={item.channel} value={item.channel}>{item.channel}（{rateForModel(modelForLine(`src:${item.channel}`, modelKey, families)).expanded}）</Choice>)}
					</DropdownMenu.RadioGroup>
				</PickerMenu>
			)}

			{channel && !channel.modelAsLine && !modelKey?.startsWith("route:") && channel.choices.length > 1 && (
				<PickerMenu {...menuProps} menu="variant" label="模型款式" value={variant?.variantLabel || modelKey || "选择款式"}>
					<DropdownMenu.RadioGroup value={modelKey} onValueChange={selectModel}>
						{channel.choices.map((item) => <Choice key={item.id} value={item.id}>{item.variantLabel}</Choice>)}
					</DropdownMenu.RadioGroup>
				</PickerMenu>
			)}

			{onMethodChange && methodOptions.length > 1 && (
				<PickerMenu {...menuProps} menu="method" label="生成方法" value={method ? methodLabel(method) : "选择方法"}>
					<DropdownMenu.RadioGroup value={method} onValueChange={onMethodChange}>
						{methodOptions.map((item) => <Choice key={item} value={item}>{methodLabel(item)}</Choice>)}
					</DropdownMenu.RadioGroup>
				</PickerMenu>
			)}

			<PickerMenu {...menuProps} menu="params" label="生成参数" value={`${duration === "auto" ? `Auto${autoDuration ? ` (${autoDuration} s)` : ""}` : `${duration} s`} · ${resolution} · ${ASPECT_LABELS[aspect] === "自适应" ? "自适应" : aspect}`}>
				<DropdownMenu.Label className="rtc-generation-picker__label">时长</DropdownMenu.Label>
				<DropdownMenu.RadioGroup className="rtc-generation-picker__params" aria-label="时长" value={String(duration)} onValueChange={(value) => onParamsChange({ duration: value === "auto" ? "auto" : Number(value) })}>
					<Choice value="auto" keepOpen>Auto</Choice>
					{(typeof duration === "number" ? withCurrentOption(requirements.durations, duration) : requirements.durations).map((value) => <Choice key={value} value={String(value)} keepOpen>{value} s</Choice>)}
				</DropdownMenu.RadioGroup>
				<DropdownMenu.Label className="rtc-generation-picker__label">分辨率</DropdownMenu.Label>
				<DropdownMenu.RadioGroup className="rtc-generation-picker__params" aria-label="分辨率" value={resolution} onValueChange={(value) => onParamsChange({ resolution: value })}>
					{withCurrentOption(requirements.resolutions, resolution).map((value) => <Choice key={value} value={value} keepOpen>{value}</Choice>)}
				</DropdownMenu.RadioGroup>
				<DropdownMenu.Label className="rtc-generation-picker__label">比例</DropdownMenu.Label>
				<DropdownMenu.RadioGroup className="rtc-generation-picker__params" aria-label="比例" value={aspect} onValueChange={(value) => onParamsChange({ aspect: value })}>
					{withCurrentOption(requirements.aspects, aspect).map((value) => <Choice key={value} value={value} keepOpen>{ASPECT_LABELS[value] ?? value}</Choice>)}
				</DropdownMenu.RadioGroup>
			</PickerMenu>
			{children}
		</div>
	);
}

/** The remaining free placeholders expose the same RTC-only duration choice. */
export function RtcGenerationDurationPicker({ duration, autoDuration, durations, onChange }: {
	duration: RtcGenerationDuration;
	autoDuration: number;
	durations: readonly number[];
	onChange: (value: RtcGenerationDuration) => void;
}) {
	return (
		<label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
			生成时长
			<select aria-label="本片段生成时长" value={String(duration)} onChange={event => onChange(event.target.value === "auto" ? "auto" : Number(event.target.value))}
				style={{ minWidth: 0, maxWidth: "100%", height: 30, color: "#eee", background: "#292929", border: "1px solid #444", borderRadius: 6, padding: "0 8px" }}>
				<option value="auto">Auto ({autoDuration} s)</option>
				{(typeof duration === "number" ? withCurrentOption(durations, duration) : durations).map(value => <option key={value} value={value}>{value} s</option>)}
			</select>
		</label>
	);
}
