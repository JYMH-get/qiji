/**
 * RtcSettingsModal —— 实时剪辑「设置」二级界面（对标剪映：快捷键弹窗 + 全局设置），
 * 替代旧的播放器 BarMenu「本模式设置」上拉面板与工具条静态快捷键速查表。
 *
 * 三页签：
 *   - 快捷键：按「时间线 / 播放器 / 基础」三分组列出全部动作（数据源=rtcKeymap 生效表，
 *     键位与说明单一来源）；点击键位胶囊进入**录制态**（监听下一次按键组合写入覆盖层；
 *     Esc 取消）；组合已绑在别的动作上=自动改绑并红字提示；每行可恢复默认；底部「恢复默认值」；
 *   - 剪辑：大幅移动步长（帧）/ 数值大幅调节 / 图片默认时长（rtcEditorSettingsStore）；
 *   - 预览：收编 rtcPreviewStore 五项（画质/循环/解码上限/播放时隐藏选中框/等比缩放）。
 *
 * ⚠ 弹窗打开期间**全部时间轴快捷键失效**（setRtcShortcutsSuspended——防录制键位时误触发
 *   分割/删除等动作）；关闭（含卸载兜底）恢复。
 * 挂载点：RtcToolbar 常驻渲染（工具条与播放器两处入口共用 rtcSettingsModalStore 开关）。
 */
import { useEffect, useState } from "react";
import { Keyboard, RotateCcw, Scissors, Settings2, X } from "lucide-react";
import { useRtcStore } from "@/store/rtcStore";
import {
	RTC_ACTION_DEFS,
	RTC_KEY_GROUPS,
	comboFromEvent,
	effectiveKeys,
	formatCombo,
	rtcActionDef,
	setRtcShortcutsSuspended,
	type RtcShortcut,
} from "../timeline/rtcKeymap";
import { useRtcKeymapStore } from "./rtcKeymapStore";
import { DEFAULT_EDITOR_SETTINGS, useRtcEditorSettingsStore, type RtcEditorSettings } from "./rtcEditorSettingsStore";
import {
	RTC_DECODE_LIMITS,
	RTC_QUALITY_SPECS,
	useRtcPreviewStore,
} from "../rtcPreviewStore";
import { useRtcSettingsModal, type RtcSettingsTab } from "./rtcSettingsModalStore";

/* ── 样式件（对齐 RTC 弹层观感：#181a22 底 + 白色低透明描边） ── */

const chipBase: React.CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 4,
	height: 22,
	padding: "0 8px",
	borderRadius: 5,
	fontSize: 11,
	fontVariantNumeric: "tabular-nums",
	cursor: "pointer",
	whiteSpace: "nowrap",
};

const smallBtn: React.CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 4,
	height: 24,
	padding: "0 9px",
	borderRadius: 5,
	border: "1px solid rgba(255,255,255,0.14)",
	background: "transparent",
	color: "rgba(255,255,255,0.7)",
	fontSize: 11,
	cursor: "pointer",
	whiteSpace: "nowrap",
};

/* ════════════════ 快捷键页 ════════════════ */

interface RecordingTarget {
	id: RtcShortcut;
	/** 替换的绑定下标；null=追加新绑定 */
	slot: number | null;
}

function KeysTab() {
	const overrides = useRtcKeymapStore((s) => s.overrides);
	const [recording, setRecording] = useState<RecordingTarget | null>(null);
	const [conflictMsg, setConflictMsg] = useState<string | null>(null);
	const effective = effectiveKeys(overrides);

	/* 录制态：capture 级监听下一次按键组合（纯修饰键继续等；Esc 取消）。
	 * 时间轴快捷键已被弹窗整体停用（setRtcShortcutsSuspended），这里独占按键。 */
	useEffect(() => {
		if (!recording) return;
		const onKey = (e: KeyboardEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (e.key === "Escape") {
				setRecording(null);
				return;
			}
			const combo = comboFromEvent(e);
			if (!combo) return; // 纯修饰键：继续等主键
			const r = useRtcKeymapStore.getState().recordKey(recording.id, combo, recording.slot);
			setConflictMsg(
				r.takenFrom
					? `「${formatCombo(combo)}」原绑定在「${rtcActionDef(r.takenFrom)?.label ?? r.takenFrom}」上，已自动改绑到「${rtcActionDef(recording.id)?.label ?? recording.id}」`
					: null,
			);
			setRecording(null);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [recording]);

	const isRec = (id: RtcShortcut, slot: number | null) =>
		recording?.id === id && recording.slot === slot;

	const keyChip = (id: RtcShortcut, combo: string, slot: number) => {
		const rec = isRec(id, slot);
		return (
			<span
				key={`${combo}-${slot}`}
				role="button"
				tabIndex={0}
				title={rec ? "按下新的按键组合（Esc 取消）" : "点击改键（录制下一次按键组合）"}
				onClick={() => {
					setConflictMsg(null);
					setRecording(rec ? null : { id, slot });
				}}
				style={{
					...chipBase,
					border: rec ? "1px solid rgba(248,113,113,0.8)" : "1px solid rgba(255,255,255,0.16)",
					background: rec ? "rgba(248,113,113,0.14)" : "rgba(255,255,255,0.05)",
					color: rec ? "#fca5a5" : "rgba(255,255,255,0.85)",
				}}
			>
				{rec ? "按下按键…" : formatCombo(combo)}
				{!rec && (
					<X
						size={10}
						style={{ opacity: 0.5, cursor: "pointer" }}
						onClick={(e) => {
							e.stopPropagation();
							setConflictMsg(null);
							useRtcKeymapStore.getState().removeKey(id, combo);
						}}
					/>
				)}
			</span>
		);
	};

	return (
		<div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
			<div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 2px 8px" }}>
				{RTC_KEY_GROUPS.map((group) => (
					<div key={group} style={{ marginBottom: 10 }}>
						<div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", padding: "6px 4px 4px", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
							{group}
						</div>
						{RTC_ACTION_DEFS.filter((d) => d.group === group).map((def) => {
							const keys = effective.get(def.id) ?? [];
							const overridden = overrides[def.id] != null;
							return (
								<div
									key={def.id}
									style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 4px", borderBottom: "1px solid rgba(255,255,255,0.04)" }}
								>
									<span style={{ width: 190, flexShrink: 0, fontSize: 12, color: "rgba(255,255,255,0.82)" }}>{def.label}</span>
									<span style={{ display: "flex", flexWrap: "wrap", gap: 4, flex: 1, minWidth: 0 }}>
										{keys.map((k, i) => keyChip(def.id, k, i))}
										{/* 追加新绑定（一动作可多绑） */}
										<span
											role="button"
											tabIndex={0}
											title="追加一个绑定"
											onClick={() => {
												setConflictMsg(null);
												setRecording(isRec(def.id, null) ? null : { id: def.id, slot: null });
											}}
											style={{
												...chipBase,
												border: isRec(def.id, null) ? "1px solid rgba(248,113,113,0.8)" : "1px dashed rgba(255,255,255,0.2)",
												background: isRec(def.id, null) ? "rgba(248,113,113,0.14)" : "transparent",
												color: isRec(def.id, null) ? "#fca5a5" : "rgba(255,255,255,0.4)",
											}}
										>
											{isRec(def.id, null) ? "按下按键…" : "＋"}
										</span>
									</span>
									{overridden && (
										<button
											type="button"
											title="该动作恢复默认键位"
											style={{ ...smallBtn, height: 22, padding: "0 6px", border: "none", color: "rgba(255,255,255,0.45)" }}
											onClick={() => {
												setConflictMsg(null);
												useRtcKeymapStore.getState().resetAction(def.id);
											}}
										>
											<RotateCcw size={11} />
										</button>
									)}
								</div>
							);
						})}
					</div>
				))}
			</div>
			<div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
				{/* 冲突改绑红字提示（录一次显示一次；再次操作即清） */}
				<span style={{ flex: 1, minWidth: 0, fontSize: 11, color: "#f87171", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={conflictMsg ?? undefined}>
					{conflictMsg ?? ""}
				</span>
				<span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", flexShrink: 0 }}>点击键位胶囊改键 · 焦点在输入框内时快捷键不生效</span>
				<button
					type="button"
					style={smallBtn}
					onClick={() => {
						setConflictMsg(null);
						setRecording(null);
						useRtcKeymapStore.getState().resetAll();
					}}
				>
					<RotateCcw size={12} /> 恢复默认值
				</button>
			</div>
		</div>
	);
}

/* ════════════════ 剪辑页 ════════════════ */

/** 草稿式数字输入（失焦/回车提交；非法回退当前值） */
function NumField({ label, hint, value, onCommit, min, max, step }: {
	label: string;
	hint: string;
	value: number;
	onCommit: (v: number) => void;
	min: number;
	max: number;
	step?: number;
}) {
	const [draft, setDraft] = useState(String(value));
	useEffect(() => setDraft(String(value)), [value]);
	const commit = () => {
		const n = Number(draft);
		if (Number.isFinite(n)) onCommit(n);
		else setDraft(String(value));
	};
	return (
		<div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 4px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
			<span style={{ flex: 1, minWidth: 0 }}>
				<span style={{ display: "block", fontSize: 12, color: "rgba(255,255,255,0.85)" }}>{label}</span>
				<span style={{ display: "block", marginTop: 2, fontSize: 10, lineHeight: 1.6, color: "rgba(255,255,255,0.42)" }}>{hint}</span>
			</span>
			<input
				type="number"
				value={draft}
				min={min}
				max={max}
				step={step ?? 1}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === "Enter") (e.target as HTMLInputElement).blur();
				}}
				style={{ width: 90, flexShrink: 0, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, color: "#fff", padding: "5px 8px", fontSize: 12, outline: "none" }}
			/>
		</div>
	);
}

function EditTab() {
	const bigStepFrames = useRtcEditorSettingsStore((s) => s.bigStepFrames);
	const bigValueStep = useRtcEditorSettingsStore((s) => s.bigValueStep);
	const imageDefaultSec = useRtcEditorSettingsStore((s) => s.imageDefaultSec);
	const patch = (part: Partial<RtcEditorSettings>) => useRtcEditorSettingsStore.getState().patch(part);
	return (
		<div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
			<div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 2px" }}>
				<NumField
					label="时间线大幅移动（帧）"
					hint={`「+ / −」快捷键每按一次播放头移动的帧数（默认 ${DEFAULT_EDITOR_SETTINGS.bigStepFrames}）`}
					value={bigStepFrames}
					min={1}
					max={600}
					onCommit={(v) => patch({ bigStepFrames: v })}
				/>
				<NumField
					label="数值大幅调节"
					hint={`属性数值做大幅增减时的步长（默认 ${DEFAULT_EDITOR_SETTINGS.bigValueStep}）`}
					value={bigValueStep}
					min={1}
					max={100}
					onCommit={(v) => patch({ bigValueStep: v })}
				/>
				<NumField
					label="图片默认时长（秒）"
					hint={`图片素材拖入轨道 / 右键「添加图片占位」的默认时长（默认 ${DEFAULT_EDITOR_SETTINGS.imageDefaultSec.toFixed(1)} 秒）`}
					value={imageDefaultSec}
					min={0.2}
					max={120}
					step={0.1}
					onCommit={(v) => patch({ imageDefaultSec: v })}
				/>
			</div>
			<div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
				<button type="button" style={smallBtn} onClick={() => useRtcEditorSettingsStore.getState().reset()}>
					<RotateCcw size={12} /> 恢复默认值
				</button>
			</div>
		</div>
	);
}

/* ════════════════ 预览页（收编 rtcPreviewStore 五项） ════════════════ */

function ToggleRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
	return (
		<label style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "7px 4px", cursor: "pointer", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
			<input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 2, accentColor: "#8b5cf6", cursor: "pointer" }} />
			<span style={{ minWidth: 0 }}>
				<span style={{ display: "block", fontSize: 12, color: "rgba(255,255,255,0.85)" }}>{label}</span>
				{hint ? <span style={{ display: "block", marginTop: 2, fontSize: 10, lineHeight: 1.6, color: "rgba(255,255,255,0.42)" }}>{hint}</span> : null}
			</span>
		</label>
	);
}

function chipStyle(active: boolean): React.CSSProperties {
	return {
		flex: 1,
		height: 24,
		borderRadius: 5,
		fontSize: 11,
		cursor: "pointer",
		border: active ? "1px solid rgba(139,92,246,0.6)" : "1px solid rgba(255,255,255,0.12)",
		background: active ? "rgba(139,92,246,0.18)" : "transparent",
		color: active ? "#d6c8ff" : "rgba(255,255,255,0.7)",
	};
}

function PreviewTab() {
	const quality = useRtcPreviewStore((s) => s.quality);
	const loop = useRtcPreviewStore((s) => s.loop);
	const maxDecodeLayers = useRtcPreviewStore((s) => s.maxDecodeLayers);
	const hideBoxWhilePlaying = useRtcPreviewStore((s) => s.hideBoxWhilePlaying);
	const uniformScale = useRtcPreviewStore((s) => s.uniformScale);
	const snapOn = useRtcStore((s) => s.snapOn);
	return (
		<div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
			<div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 2px" }}>
				<div style={{ padding: "7px 4px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
					<div style={{ fontSize: 12, color: "rgba(255,255,255,0.85)" }}>预览画质</div>
					<div style={{ margin: "2px 0 7px", fontSize: 10, lineHeight: 1.6, color: "rgba(255,255,255,0.42)" }}>
						只影响预览合成的渲染像素（多层叠加时最明显），不改变素材解码分辨率，也不影响导出。
					</div>
					<div style={{ display: "flex", gap: 5 }}>
						{RTC_QUALITY_SPECS.map((s) => (
							<button key={s.id} type="button" title={s.hint} style={chipStyle(quality === s.id)} onClick={() => useRtcPreviewStore.getState().setQuality(s.id)}>
								{s.label} {Math.round(s.scale * 100)}%
							</button>
						))}
					</div>
				</div>
				<ToggleRow
					label="循环播放"
					hint="播到末尾自动回到片头继续播（关=停在末帧）"
					checked={loop}
					onChange={(v) => useRtcPreviewStore.getState().setLoop(v)}
				/>
				<ToggleRow
					label="播放时隐藏画面选中框"
					hint="播放中不显示控制点，看片更干净；暂停后自动回来"
					checked={hideBoxWhilePlaying}
					onChange={(v) => useRtcPreviewStore.getState().setHideBoxWhilePlaying(v)}
				/>
				<ToggleRow
					label="拖角等比缩放"
					hint="拖四角保持宽高比（按住 Shift 临时取反）；拖四边恒为单向缩放"
					checked={uniformScale}
					onChange={(v) => useRtcPreviewStore.getState().setUniformScale(v)}
				/>
				<ToggleRow
					label="时间轴磁吸"
					hint="拖动片段时吸附到相邻片段边界/整秒（与工具栏「吸附」是同一个开关，会话内有效）"
					checked={snapOn}
					onChange={() => useRtcStore.getState().toggleSnap()}
				/>
				<div style={{ padding: "7px 4px" }}>
					<div style={{ fontSize: 12, color: "rgba(255,255,255,0.85)" }}>同时解码视频层上限</div>
					<div style={{ margin: "2px 0 7px", fontSize: 10, lineHeight: 1.6, color: "rgba(255,255,255,0.42)" }}>
						多层视频同时解码很吃 GPU；超出上限的下层会暂停在静止帧且不发声（上层本就遮住它们）。
					</div>
					<div style={{ display: "flex", gap: 5, maxWidth: 260 }}>
						{RTC_DECODE_LIMITS.map((n) => (
							<button key={n} type="button" style={chipStyle(maxDecodeLayers === n)} onClick={() => useRtcPreviewStore.getState().setMaxDecodeLayers(n)}>
								{n}
							</button>
						))}
					</div>
				</div>
			</div>
			<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
				<span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>偏好存在本机，不随项目文件</span>
				<button type="button" style={smallBtn} onClick={() => useRtcPreviewStore.getState().resetPrefs()}>
					<RotateCcw size={12} /> 恢复默认
				</button>
			</div>
		</div>
	);
}

/* ════════════════ 弹窗本体 ════════════════ */

const TABS: Array<{ id: RtcSettingsTab; label: string; icon: React.ReactNode }> = [
	{ id: "keys", label: "快捷键", icon: <Keyboard size={13} /> },
	{ id: "edit", label: "剪辑", icon: <Scissors size={13} /> },
	{ id: "preview", label: "预览", icon: <Settings2 size={13} /> },
];

function ModalBody() {
	const tab = useRtcSettingsModal((s) => s.tab);
	const close = useRtcSettingsModal((s) => s.close);

	/* 打开期间时间轴快捷键整体失效（录制键位时按 B/Delete 绝不能真的去分割/删除）；卸载兜底恢复 */
	useEffect(() => {
		setRtcShortcutsSuspended(true);
		return () => setRtcShortcutsSuspended(false);
	}, []);

	// Esc 关弹窗（capture 之后：录制态的监听在 capture 级先吃掉 Esc 用于取消录制）
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") close();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [close]);

	return (
		<>
			<div className="fixed inset-0 z-[10500]" style={{ background: "rgba(0,0,0,0.55)" }} onClick={close} />
			<div
				className="fixed z-[10501]"
				role="dialog"
				aria-label="实时剪辑设置"
				style={{
					left: "50%",
					top: "50%",
					transform: "translate(-50%, -50%)",
					width: "min(720px, calc(100vw - 48px))",
					height: "min(560px, calc(100vh - 64px))",
					display: "flex",
					flexDirection: "column",
					borderRadius: 12,
					border: "1px solid rgba(255,255,255,0.12)",
					background: "#16181f",
					boxShadow: "0 18px 60px rgba(0,0,0,0.6)",
					padding: "14px 16px 12px",
				}}
			>
				<div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
					<span style={{ fontSize: 13, color: "rgba(255,255,255,0.92)", fontWeight: 600 }}>实时剪辑 · 设置</span>
					<div style={{ display: "flex", gap: 4 }}>
						{TABS.map((t) => (
							<button
								key={t.id}
								type="button"
								onClick={() => useRtcSettingsModal.getState().setTab(t.id)}
								style={{
									display: "flex",
									alignItems: "center",
									gap: 5,
									height: 26,
									padding: "0 10px",
									borderRadius: 6,
									border: "none",
									fontSize: 12,
									cursor: "pointer",
									background: tab === t.id ? "rgba(139,92,246,0.18)" : "transparent",
									color: tab === t.id ? "#d6c8ff" : "rgba(255,255,255,0.6)",
								}}
							>
								{t.icon}
								{t.label}
							</button>
						))}
					</div>
					<button
						type="button"
						title="关闭（Esc）"
						onClick={close}
						style={{ marginLeft: "auto", display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, borderRadius: 6, border: "none", background: "transparent", color: "rgba(255,255,255,0.55)", cursor: "pointer" }}
					>
						<X size={15} />
					</button>
				</div>
				{tab === "keys" && <KeysTab />}
				{tab === "edit" && <EditTab />}
				{tab === "preview" && <PreviewTab />}
			</div>
		</>
	);
}

/** 常驻挂载壳：open=false 时零渲染（快捷键停用等副作用全在 ModalBody 内，关了自然恢复） */
export function RtcSettingsModal() {
	const open = useRtcSettingsModal((s) => s.open);
	return open ? <ModalBody /> : null;
}
