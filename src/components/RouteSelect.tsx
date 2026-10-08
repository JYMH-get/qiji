import type { CSSProperties } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
import { useRouteSuccessRates } from "./RouteSuccessRate";
import "./RouteSelect.css";

export interface RouteSelectOption { value: string; label: string; modelKey: string }

/** A separate trigger keeps compact text independent from the expanded option labels. */
export function RouteSelect({ value, options, onChange, title = "线路", placeholder = "选择线路", className, style }: {
	value: string;
	options: readonly RouteSelectOption[];
	onChange: (value: string) => void;
	title?: string;
	placeholder?: string;
	className?: string;
	style?: CSSProperties;
}) {
	const rateForModel = useRouteSuccessRates();
	const selected = options.find(option => option.value === value);
	const selectedRate = rateForModel(selected?.modelKey);
	return <DropdownMenu.Root modal={false}>
		<DropdownMenu.Trigger asChild>
			<button type="button" title={title} aria-label={`${title}：${selected?.label ?? placeholder}${selected ? ` ${selectedRate.compact}` : ""}`}
				className={`qiji-route-select ${className ?? ""}`} style={style} data-route-select>
				<span className="qiji-route-select__name" title={selected?.label ?? placeholder}>{selected?.label ?? placeholder}</span>
				{selected && <span className="qiji-route-select__rate" title={selectedRate.expanded}>{selectedRate.compact}</span>}
				<ChevronDown size={12} aria-hidden="true" />
			</button>
		</DropdownMenu.Trigger>
		<DropdownMenu.Portal>
			<DropdownMenu.Content className="qiji-route-select-menu" align="start" sideOffset={5} collisionPadding={8} aria-label={title}>
				<DropdownMenu.RadioGroup value={value} onValueChange={onChange}>
					{options.map(option => <DropdownMenu.RadioItem key={option.value} value={option.value} className="qiji-route-select-option">
						<span>{option.label}（{rateForModel(option.modelKey).expanded}）</span>
						<DropdownMenu.ItemIndicator><Check size={12} aria-hidden="true" /></DropdownMenu.ItemIndicator>
					</DropdownMenu.RadioItem>)}
				</DropdownMenu.RadioGroup>
			</DropdownMenu.Content>
		</DropdownMenu.Portal>
	</DropdownMenu.Root>;
}
