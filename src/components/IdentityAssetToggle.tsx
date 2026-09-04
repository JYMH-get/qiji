/** 素材卡右下角的人像验证快捷开关；右上角永久留给删除按钮。 */
export function IdentityAssetToggle({ active, onToggle }: { active: boolean; onToggle: () => void }) {
	return (
		<button
			type="button"
			aria-pressed={active}
			aria-label={active ? "改为普通参考" : "改为人像素材"}
			title={active ? "人像素材：点击改为普通参考" : "普通参考：点击改为人像素材并走官方素材验证"}
			onPointerDown={(e) => e.stopPropagation()}
			onDoubleClick={(e) => e.stopPropagation()}
			onContextMenu={(e) => e.stopPropagation()}
			onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(); }}
			style={{
				position: "absolute", right: 1, bottom: 1, zIndex: 6,
				height: 15, minWidth: 15, padding: "0 2px", borderRadius: 4,
				border: active ? "1px solid rgba(196,181,253,0.95)" : "1px solid rgba(255,255,255,0.35)",
				background: active ? "rgba(109,40,217,0.92)" : "rgba(0,0,0,0.68)",
				color: "#fff", fontSize: 8, fontWeight: 700, lineHeight: "13px", cursor: "pointer",
				boxShadow: "0 1px 3px rgba(0,0,0,0.45)",
			}}
		>
			{active ? "人✓" : "人"}
		</button>
	);
}
