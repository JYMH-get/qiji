/**
 * freeGenParts —— 自由结果占位（无 shotRef）的共享编辑件（第240轮从 RtcFreeGenProps 抽出）：
 *   - DraftArea：草稿式多行编辑（失焦才回写，不逐击落盘）；
 *   - RefStrip：垫素材条（资产面板拖拽 application/x-qiji-asset + 本地文件懒上传）；
 *   - KIND_LABEL / secTitle / secBox：两处共用的小常量与区块样式。
 * 消费方：右栏 [RtcFreeGenProps](./RtcFreeGenProps.tsx)（AI 设置）与
 * 中栏 [RtcFreeGenWorkbench](./RtcFreeGenWorkbench.tsx)（提示词/垫素材编辑）——勿复制两份。
 * ⚠ 红线：素材写入唯一路径=useRtcFreeGenStore.patch(segId,{refs})；本地文件走懒上传
 * （第194轮 uploadMediaToCanvasAsset，提交时 ensurePublicUrl 补传 OSS）。
 */
import { useEffect, useRef, useState } from "react";
import { Music, Video, X } from "lucide-react";
import { openLightbox } from "@/store/lightboxStore";
import { useRtcFreeGenStore, type FreeGenRef } from "./rtcFreeGenStore";

export const KIND_LABEL: Record<"video" | "image" | "audio", string> = { video: "视频", image: "图片", audio: "音频" };

export const secTitle: React.CSSProperties = {
	fontSize: 11,
	color: "rgba(255,255,255,0.55)",
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	gap: 6,
};
export const secBox: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };

/** 草稿式多行编辑（与 RtcShotWorkbench/RtcAssetProps 的 DraftArea 同款：失焦才回写，不逐击落盘） */
export function DraftArea({
	value,
	placeholder,
	rows = 5,
	minHeight,
	fill = false,
	onCommit,
}: {
	value: string;
	placeholder?: string;
	rows?: number;
	/** 中栏工作台的灯箱式大编辑区用（如 "32vh"）；缺省=按 rows 自然高 */
	minHeight?: number | string;
	/** 填充模式（补充5）：吃满父列剩余高且有界（超长内容框内滚动收起）；true 时忽略 minHeight */
	fill?: boolean;
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
				resize: fill ? "none" : "vertical",
				background: "rgba(255,255,255,0.05)",
				border: "1px solid rgba(255,255,255,0.12)",
				borderRadius: 6,
				color: "#fff",
				padding: "6px 8px",
				fontSize: 12,
				lineHeight: 1.5,
				outline: "none",
				...(fill ? { flex: 1, minHeight: 0, overflowY: "auto" as const } : minHeight != null ? { minHeight } : null),
			}}
		/>
	);
}

/** 垫素材条：接收资产面板拖拽（application/x-qiji-asset）与本地文件拖入；点 ✕ 移除 */
export function RefStrip({ segId, refs }: { segId: string; refs: FreeGenRef[] }) {
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
