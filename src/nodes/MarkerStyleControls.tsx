const COLORS = ["#ffffff", "#ff5252", "#facc15", "#4ade80", "#60a5fa", "#c084fc"];

/** 创建与编辑共用：大小由边框控制，荧光仅为开关。 */
export function MarkerStyleControls({ color, highlight, onChange }: {
	color: string;
	highlight: boolean;
	onChange: (patch: { color?: string; highlight?: boolean }) => void;
}) {
	return <div className="flex items-center gap-1.5 whitespace-nowrap">
		{COLORS.map((value) => <button key={value} type="button" aria-label={`颜色 ${value}`} aria-pressed={color === value}
			onClick={() => onChange({ color: value })} className="h-4 w-4 shrink-0 rounded-full border border-white/25"
			style={{ background: value, outline: color === value ? "2px solid #fff" : undefined, outlineOffset: 2 }} />)}
		<input type="color" value={color} onChange={(e) => onChange({ color: e.target.value })} className="ml-1 h-5 w-6 cursor-pointer border-0 bg-transparent p-0" title="自定义颜色" />
		<label className="flex cursor-pointer items-center gap-1 px-1 text-[11px] text-white/85">
			<input type="checkbox" checked={highlight} onChange={(e) => onChange({ highlight: e.target.checked })} className="accent-yellow-300" />荧光
		</label>
	</div>;
}
