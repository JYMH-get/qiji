/**
 * RtcFreeGenProps —— 右栏「自由结果占位」属性视图（时间轴空白右键新建的占位，**无 shotRef**）。
 *
 * 区块：占位身份（名/产物类型/时间码）→ 提示词 → 垫素材条（视频/图片）→ 模型 → 生成/进度/失败重试。
 *
 * ⚠ 语义（第237轮定稿）：轨道是结果的存放位置——这个占位就是「这一版结果的坑位」，
 *   生成成功后它**就地**变成结果片段（target 位置/时长分毫不动，时长不符留给用户裁剪）；
 *   要新版本请对成片右键「重新生成」（在上方轨道另起一个占位，原结果原位保留）。
 *
 * ⚠ 红线：生成只走 [freeGenActions.startFreeGen](./freeGenActions.ts)（内部 runPurpose 唯一路径，
 *   选路理由见该文件头注释）；本文件不拼提示词模板正文、不改写生成参数。
 * 任务态由**片段自身的 status/progress**驱动（随 rtcDoc 落项目文件）——关掉客户端重开后，
 * [placeholderSwap.initRtcGenWatch] 会凭 taskRef 重挂轮询继续回填，不依赖任何回调闭包。
 */
import { useEffect, useRef, useState } from "react";
import { Image as ImageIcon, Music, Video, X } from "lucide-react";
import ModelPicker from "@/components/ModelPicker";
import { PromptExpandButton } from "@/components/PromptExpandButton";
import { openLightbox } from "@/store/lightboxStore";
import type { RtcSegment, RtcTrack } from "@/types/rtc";
import { AUDIO_GEN_UNSUPPORTED, genCapabilityFor, segSeconds } from "./rtcGenCore";
import { fmtUs, usToSecLabel } from "./rtcSegUtils";
import { RtcTimeFields } from "./RtcTimeFields";
import { useRtcFreeGenStore, type FreeGenRef } from "./rtcFreeGenStore";
import { retryFreeGen, segGenKind, startFreeGen } from "./freeGenActions";

const KIND_LABEL: Record<"video" | "image" | "audio", string> = { video: "视频", image: "图片", audio: "音频" };

const secTitle: React.CSSProperties = {
	fontSize: 11,
	color: "rgba(255,255,255,0.55)",
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	gap: 6,
};
const secBox: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };

/** 草稿式多行编辑（与 RtcShotWorkbench/RtcAssetProps 的 DraftArea 同款：失焦才回写，不逐击落盘） */
function DraftArea({
	value,
	placeholder,
	rows = 5,
	onCommit,
}: {
	value: string;
	placeholder?: string;
	rows?: number;
	onCommit: (v: string) => void;
}) {
	const [draft, setDraft] = useState(value);
	const [editing, setEditing] = useState(false);
	// 非编辑期跟随 store（外部改动实时可见）
	useEffect(() => {
		if (!editing) setDraft(value);
	}, [value, editing]);
	return (
		<textarea
			value={draft}
			rows={rows}
			placeholder={placeholder}
			onChange={(e) => setDraft(e.target.value)}
			onFocus={() => setEditing(true)}
			onBlur={() => {
				setEditing(false);
				if (draft !== value) onCommit(draft);
			}}
			style={{
				width: "100%",
				resize: "vertical",
				background: "rgba(255,255,255,0.05)",
				border: "1px solid rgba(255,255,255,0.12)",
				borderRadius: 6,
				color: "#fff",
				padding: "6px 8px",
				fontSize: 12,
				lineHeight: 1.5,
				outline: "none",
			}}
		/>
	);
}

/** 垫素材条：接收资产面板拖拽（application/x-qiji-asset）与本地文件拖入；点 ✕ 移除 */
function RefStrip({ segId, refs }: { segId: string; refs: FreeGenRef[] }) {
	const fileRef = useRef<HTMLInputElement>(null);
	const setRefs = (next: FreeGenRef[]) => useRtcFreeGenStore.getState().patch(segId, { refs: next });

	const addLocal = async (files: File[]) => {
		if (!files.length) return;
		// 懒上传（第194轮）：只落本地 + 注册三元映射，提交时再由 ensurePublicUrl 补传 OSS
		const { uploadMediaToCanvasAsset } = await import("@/canvas/nodeUpload");
		const added: FreeGenRef[] = [];
		for (const f of files) {
			try {
				const up = await uploadMediaToCanvasAsset(f);
				const media: FreeGenRef["media"] = f.type.startsWith("video/") ? "video" : f.type.startsWith("audio/") ? "audio" : "image";
				added.push({ uri: up.displayUri, assetId: up.assetId, name: f.name, media });
			} catch {
				/* 单个文件失败不影响其它（用户可重拖） */
			}
		}
		if (added.length) setRefs([...useRtcFreeGenStore.getState().draftOf(segId).refs, ...added]);
	};

	const onDrop = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		const raw = e.dataTransfer.getData("application/x-qiji-asset") || e.dataTransfer.getData("text/plain");
		if (raw) {
			try {
				const d = JSON.parse(raw) as Record<string, unknown>;
				const u = (d.localUri || d.uri || d.url) as string | undefined; // 展示优先本地 uri（CSP）
				if (u) {
					const media: FreeGenRef["media"] = d.media === "video" || d.media === "audio" ? d.media : "image";
					setRefs([
						...refs,
						{ uri: u, assetId: (d.assetId || d.id) as string | undefined, name: (d.name as string) || "素材", media },
					]);
					return;
				}
			} catch {
				/* 落到文件分支 */
			}
		}
		const files = Array.from(e.dataTransfer.files || []).filter((f) => /^(image|video|audio)\//.test(f.type));
		void addLocal(files);
	};

	return (
		<div
			onDragOver={(e) => e.preventDefault()}
			onDrop={onDrop}
			title="垫素材：从左栏素材面板拖入资产，或拖入本地文件；与提示词里的 @ 编号按位对应"
			style={{
				display: "flex",
				gap: 6,
				flexWrap: "wrap",
				alignItems: "center",
				minHeight: 52,
				padding: 4,
				borderRadius: 8,
				border: "1px dashed rgba(255,255,255,0.10)",
			}}
		>
			{refs.map((r, i) => (
				<div
					key={`${r.uri}-${i}`}
					className="group"
					title={`${r.name || "素材"}（${KIND_LABEL[r.media]}）——双击放大`}
					onDoubleClick={() => r.media === "image" && openLightbox({ uri: r.uri, name: r.name || "素材" })}
					style={{
						position: "relative",
						width: 44,
						height: 44,
						borderRadius: 6,
						overflow: "hidden",
						border: "1px solid rgba(255,255,255,0.12)",
						background: "rgba(255,255,255,0.05)",
					}}
				>
					{r.media === "image" ? (
						<img src={r.uri} style={{ width: "100%", height: "100%", objectFit: "cover" }} draggable={false} />
					) : (
						<div style={{ display: "flex", width: "100%", height: "100%", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.6)" }}>
							{r.media === "video" ? <Video size={14} /> : <Music size={14} />}
						</div>
					)}
					<span style={{ position: "absolute", left: 0, bottom: 0, fontSize: 8, lineHeight: "11px", padding: "0 3px", background: "rgba(0,0,0,0.65)", color: "#fff" }}>
						{i + 1}
					</span>
					<button
						title="移除该素材"
						onClick={() => setRefs(refs.filter((_, k) => k !== i))}
						className="hidden group-hover:flex"
						style={{
							position: "absolute",
							top: 1,
							right: 1,
							width: 14,
							height: 14,
							alignItems: "center",
							justifyContent: "center",
							borderRadius: 3,
							border: "none",
							padding: 0,
							cursor: "pointer",
							color: "#fff",
							background: "rgba(0,0,0,0.7)",
						}}
					>
						<X size={9} />
					</button>
				</div>
			))}
			<button
				onClick={() => fileRef.current?.click()}
				title="上传本地图片/视频/音频作垫素材"
				style={{
					width: 44,
					height: 44,
					borderRadius: 6,
					border: "1px dashed rgba(255,255,255,0.2)",
					background: "transparent",
					color: "rgba(255,255,255,0.45)",
					fontSize: 16,
					cursor: "pointer",
				}}
			>
				＋
			</button>
			<input
				ref={fileRef}
				type="file"
				multiple
				accept="image/*,video/*,audio/*"
				style={{ display: "none" }}
				onChange={(e) => {
					void addLocal(Array.from(e.target.files || []));
					e.target.value = "";
				}}
			/>
		</div>
	);
}

export function RtcFreeGenProps({ seg, track, segIndex }: { seg: RtcSegment; track: RtcTrack; segIndex: number }) {
	const kind = segGenKind(seg);
	const cap = genCapabilityFor(kind);
	const draft = useRtcFreeGenStore((s) => s.drafts[seg.id]);
	const prompt = draft?.prompt ?? "";
	const refs = draft?.refs ?? [];
	const running = seg.status === "running";
	const failed = seg.status === "failed";
	const [busy, setBusy] = useState(false);

	const submit = async (retry: boolean) => {
		setBusy(true);
		try {
			const r = retry ? await retryFreeGen(seg.id) : await startFreeGen(seg.id);
			if (!r.ok) alert(r.error); // 请求没发出：明确报错，绝不静默失败
		} finally {
			setBusy(false);
		}
	};

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "12px 12px 24px" }}>
			{/* 头部：占位身份 */}
			<div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
				<div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
					<span style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>{seg.name || `${KIND_LABEL[kind]}占位`}</span>
					<span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>结果占位 · {KIND_LABEL[kind]}</span>
				</div>
				<div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>
					{track.name || (track.type === "audio" ? "音频轨" : "视频轨")} · 第 {segIndex + 1} 段 · {fmtUs(seg.targetStartUs)} →{" "}
					{fmtUs(seg.targetStartUs + seg.targetDurationUs)}（{usToSecLabel(seg.targetDurationUs)}）
				</div>
				{/* 精确摆位：起点/时长可直接填（占位时长同时决定提交给模型的视频秒数，见下方参数说明） */}
				<div style={{ marginTop: 4 }}>
					<RtcTimeFields seg={seg} track={track} />
				</div>
				{seg.originSegId ? (
					<div style={{ fontSize: 10, color: "rgba(167,139,250,0.75)", lineHeight: 1.7 }}>
						新版本占位——结果落在这里，下方轨道的原结果原位保留。
						<br />
						<span style={{ color: "rgba(255,255,255,0.4)" }}>
							若它是「超分 / 去字幕」的坑位且失败了，请对下方的原结果重新右键处理；也可以在这里直接填提示词，生成一段新内容占住这个位置。
						</span>
					</div>
				) : null}
			</div>

			{cap === null ? (
				/* 音频：库内暂无接线的音频生成能力——直说，不给点了没反应的按钮 */
				<div
					style={{
						fontSize: 11.5,
						lineHeight: 1.8,
						color: "rgba(251,191,36,0.9)",
						background: "rgba(251,191,36,0.08)",
						border: "1px solid rgba(251,191,36,0.3)",
						borderRadius: 6,
						padding: "8px 10px",
					}}
				>
					{AUDIO_GEN_UNSUPPORTED}
					<br />
					<span style={{ color: "rgba(255,255,255,0.5)" }}>把素材拖到这个占位上即可替换成真实音频（占位的位置与时长保留）。</span>
				</div>
			) : (
				<>
					{/* 提示词 */}
					<div style={secBox}>
						<div style={secTitle}>
							<span>提示词</span>
							<PromptExpandButton
								title={`${seg.name || "结果占位"} · 提示词`}
								getValue={() => useRtcFreeGenStore.getState().draftOf(seg.id).prompt}
								onSave={(v) => useRtcFreeGenStore.getState().patch(seg.id, { prompt: v })}
								size={11}
							/>
						</div>
						<DraftArea
							value={prompt}
							rows={5}
							placeholder={kind === "video" ? "描述这一段视频要拍什么…" : "描述这张图要画什么…"}
							onCommit={(v) => useRtcFreeGenStore.getState().patch(seg.id, { prompt: v })}
						/>
					</div>

					{/* 垫素材 */}
					<div style={secBox}>
						<div style={secTitle}>
							<span>垫素材（{refs.length}）</span>
							<span style={{ fontSize: 9.5, color: "rgba(255,255,255,0.35)" }}>拖入资产/文件 · 按序对应 @1@2…</span>
						</div>
						<RefStrip segId={seg.id} refs={refs} />
					</div>

					{/* 模型 */}
					<div style={secBox}>
						<ModelPicker cap={cap} label={kind === "video" ? "视频模型" : "生图模型"} />
					</div>

					{/* 参数说明（视频时长默认取占位自身长度——占位多长就生成多长，再按模型开放档收敛） */}
					{kind === "video" ? (
						<div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)", lineHeight: 1.7 }}>
							时长按本占位长度（约 {segSeconds(seg.targetDurationUs)}s）提交，分辨率/比例取「视频设置」，
							三者都会按所选模型开放的档位收敛。
						</div>
					) : (
						<div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)", lineHeight: 1.7 }}>
							比例/分辨率/质量取「视频设置」里的故事板图像设置，按所选模型开放的档位收敛。
						</div>
					)}

					{/* 动作 + 状态 */}
					<div style={secBox}>
						<button
							disabled={running || busy}
							title={running ? "生成中——切页/关软件重开会自动接回" : "按上面的提示词与垫素材生成；成功后本占位就地变成结果"}
							onClick={() => void submit(failed)}
							style={{
								padding: "7px 8px",
								fontSize: 12,
								borderRadius: 6,
								cursor: running || busy ? "not-allowed" : "pointer",
								opacity: running || busy ? 0.5 : 1,
								border: "1px solid rgba(139,92,246,0.6)",
								background: "rgba(139,92,246,0.22)",
								color: "#d6c8ff",
								whiteSpace: "nowrap",
							}}
						>
							{running ? "生成中…" : failed ? "重新生成" : "开始生成"}
						</button>

						{running ? (
							<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
								<div style={{ height: 4, borderRadius: 2, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
									<div
										style={{
											width: `${Math.max(4, Math.min(100, seg.progress ?? 0))}%`,
											height: "100%",
											background: "rgba(139,92,246,0.85)",
											transition: "width 240ms linear",
										}}
									/>
								</div>
								<div style={{ fontSize: 10, color: "rgba(196,181,253,0.9)" }}>
									{seg.progress != null ? `生成中 ${Math.round(seg.progress)}%` : "生成中…"}
									<span style={{ color: "rgba(255,255,255,0.35)" }}>（切页/关软件重开会自动接回，不重复扣费）</span>
								</div>
							</div>
						) : null}

						{failed ? (
							<div
								style={{
									fontSize: 10.5,
									lineHeight: 1.7,
									color: "#f87171",
									background: "rgba(248,113,113,0.1)",
									border: "1px solid rgba(248,113,113,0.35)",
									borderRadius: 6,
									padding: "6px 8px",
								}}
							>
								{seg.error || "生成失败"}
								<br />
								<span style={{ color: "rgba(255,255,255,0.45)" }}>占位已保留在原位——改完提示词点「重新生成」即可（会重新扣费）。</span>
							</div>
						) : null}

						{!running && !failed ? (
							<div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)", lineHeight: 1.7, display: "flex", alignItems: "center", gap: 4 }}>
								{kind === "video" ? <Video size={11} /> : <ImageIcon size={11} />}
								生成成功后本占位就地变成结果（位置与时长不变）；要另一版就对结果右键「重新生成」。
							</div>
						) : null}
					</div>
				</>
			)}
		</div>
	);
}
