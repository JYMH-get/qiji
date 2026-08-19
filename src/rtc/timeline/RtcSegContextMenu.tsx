/**
 * RtcSegContextMenu —— 时间轴片段右键菜单。
 *
 * 菜单内容按片段类型动态：
 *   - 视频/图片：超分 / 去字幕 / 音频分离 / 复制·剪切·副本 / 分割 / 删除·波纹删除
 *   - 音频：音频分离（如有源视频）/ 复制·剪切·副本 / 删除·波纹删除
 *   - 占位符：重新生成 / 复制·剪切·副本 / 删除·波纹删除
 * 基础剪辑项（复制/剪切/副本/波纹删除）与快捷键走同一套 rtcEditActions，右键即选中该片段后再执行。
 */
import { useEffect, useRef } from "react";
import {
	Copy,
	CopyPlus,
	Replace,
	Split,
	Trash2,
	Sparkles,
	Scissors,
	Music,
	RefreshCw,
	ScissorsLineDashed,
	Clock3,
	Rewind,
	Crop as CropIcon,
	Layers,
} from "lucide-react";
import type { RtcSegment, RtcTrack } from "@/types/rtc";

export interface RtcSegMenuProps {
	x: number;
	y: number;
	seg: RtcSegment;
	track: RtcTrack;
	onClose: () => void;
	onSplit: () => void;
	onDelete: () => void;
	/** 波纹删除：删除后同轨右侧片段左移补位（Shift+Delete） */
	onRippleDelete: () => void;
	onCopy: () => void;
	onCut: () => void;
	onDuplicate: () => void;
	onUpscale?: () => void;
	onDesub?: () => void;
	onSeparateAudio?: () => void;
	onRegenerate?: () => void;
	/** 用素材面板选中的素材原位替换本片段（segActions.buildReplaceMenuProps 组装） */
	onReplaceWithAsset?: () => void;
	/** 替换不可用的原因（无选中素材/类型不符/锁轨）——有值=显示置灰项并带提示 */
	replaceDisabled?: string;
	/* ── 集成轮：定格 / 倒放 / 裁剪 / 复合片段 ── */
	onFreeze?: () => void;
	onReverse?: () => void;
	/** 倒放项文案（已是倒放片段=「取消倒放」） */
	reverseLabel?: string;
	onCrop?: () => void;
	onCompound?: () => void;
	onUncompound?: () => void;
	onEnterCompound?: () => void;
}

const MENU_W = 200;

export function RtcSegContextMenu({
	x,
	y,
	seg,
	track,
	onClose,
	onSplit,
	onDelete,
	onRippleDelete,
	onCopy,
	onCut,
	onDuplicate,
	onUpscale,
	onFreeze,
	onReverse,
	reverseLabel,
	onCrop,
	onCompound,
	onUncompound,
	onEnterCompound,
	onDesub,
	onSeparateAudio,
	onRegenerate,
	onReplaceWithAsset,
	replaceDisabled,
}: RtcSegMenuProps) {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		const onPointer = (e: PointerEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) onClose();
		};
		window.addEventListener("keydown", onKey);
		window.addEventListener("pointerdown", onPointer);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("pointerdown", onPointer);
		};
	}, [onClose]);

	// 边界钳制
	const clampX = Math.min(x, window.innerWidth - MENU_W - 8);
	const clampY = Math.min(y, window.innerHeight - 320);

	const isVideo = track.type === "video" && seg.kind === "media" && seg.media === "video";
	const isImage = track.type === "video" && seg.kind === "media" && seg.media === "image";

	const btn = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-white/10 cursor-pointer transition-colors text-[12px] text-secondary-foreground";
	/** 行尾快捷键提示（右对齐、弱化） */
	const kbd = "ml-auto text-[10px] text-white/25 tabular-nums";

	return (
		<>
			<div
				className="fixed inset-0 z-[10400]"
				onClick={onClose}
				onContextMenu={(e) => { e.preventDefault(); onClose(); }}
			/>
			<div
				ref={ref}
				className="fixed z-[10401] rounded-lg border border-white/10 bg-[#181a22] shadow-2xl p-1"
				style={{ left: clampX, top: clampY, width: MENU_W }}
			>
				{/* 视频/图片片段：超分 / 去字幕 / 音频分离 */}
				{(isVideo || isImage) && onUpscale && (
					<button type="button" className={btn} onClick={() => { onUpscale(); onClose(); }}>
						<Sparkles size={13} className="text-amber-400" />
						超分（画质增强）
					</button>
				)}
				{(isVideo || isImage) && onDesub && (
					<button type="button" className={btn} onClick={() => { onDesub(); onClose(); }}>
						<Scissors size={13} className="text-cyan-400" />
						去字幕
					</button>
				)}
				{isVideo && onSeparateAudio && (
					<button type="button" className={btn} onClick={() => { onSeparateAudio(); onClose(); }}>
						<Music size={13} className="text-emerald-400" />
						音频分离
					</button>
				)}
				{/* ── 集成轮：定格 / 倒放 / 裁剪（可用性由 segActions 组装决定，undefined=不显示） ── */}
				{onFreeze && (
					<button type="button" className={btn} onClick={() => { onFreeze(); onClose(); }}>
						<Clock3 size={13} className="text-orange-300" />
						定格
						<span className={kbd}>G</span>
					</button>
				)}
				{onReverse && (
					<button type="button" className={btn} onClick={() => { onReverse(); onClose(); }}>
						<Rewind size={13} className="text-violet-300" />
						{reverseLabel || "倒放"}
						<span className={kbd}>D</span>
					</button>
				)}
				{onCrop && (
					<button type="button" className={btn} onClick={() => { onCrop(); onClose(); }}>
						<CropIcon size={13} className="text-lime-300" />
						裁剪画面…
						<span className={kbd}>C</span>
					</button>
				)}
				{onCompound && (
					<button type="button" className={btn} onClick={() => { onCompound(); onClose(); }}>
						<Layers size={13} className="text-fuchsia-300" />
						新建复合片段
						<span className={kbd}>Alt+G</span>
					</button>
				)}
				{onEnterCompound && (
					<button type="button" className={btn} onClick={() => { onEnterCompound(); onClose(); }}>
						<Layers size={13} className="text-fuchsia-300" />
						进入复合片段编辑
					</button>
				)}
				{onUncompound && (
					<button type="button" className={btn} onClick={() => { onUncompound(); onClose(); }}>
						<Layers size={13} className="text-fuchsia-300" />
						解除复合片段
						<span className={kbd}>Alt+Shift+G</span>
					</button>
				)}
				{/* 用素材面板选中的素材替换（原位替换：位置/时长不变）；无选中素材=置灰带原因 */}
				{(onReplaceWithAsset || replaceDisabled) && (
					<button
						type="button"
						className={`${btn} ${onReplaceWithAsset ? "" : "opacity-40 cursor-not-allowed hover:bg-transparent"}`}
						title={replaceDisabled || "用左侧素材面板当前选中的素材原位替换（位置与时长不变）"}
						onClick={() => {
							if (!onReplaceWithAsset) return; // 置灰：不关菜单，悬浮提示已说明原因
							onReplaceWithAsset();
							onClose();
						}}
					>
						<Replace size={13} className="text-sky-400" />
						用面板选中素材替换
					</button>
				)}
				{/* 基础剪辑（所有片段通用）：复制 / 剪切 / 副本 → 分割 → 删除 / 波纹删除 */}
				<div className="my-1 h-px bg-white/8" />
				<button type="button" className={btn} onClick={() => { onCopy(); onClose(); }}>
					<Copy size={13} className="text-white/60" />
					复制
					<span className={kbd}>Ctrl+C</span>
				</button>
				<button type="button" className={btn} onClick={() => { onCut(); onClose(); }}>
					<Scissors size={13} className="text-white/60" />
					剪切
					<span className={kbd}>Ctrl+X</span>
				</button>
				<button type="button" className={btn} onClick={() => { onDuplicate(); onClose(); }}>
					<CopyPlus size={13} className="text-white/60" />
					创建副本
					<span className={kbd}>Ctrl+D</span>
				</button>
				<button type="button" className={btn} onClick={() => { onSplit(); onClose(); }}>
					<Split size={13} className="text-blue-400" />
					分割
					<span className={kbd}>B</span>
				</button>
				<button type="button" className={btn} onClick={() => { onDelete(); onClose(); }}>
					<Trash2 size={13} className="text-red-400" />
					删除
					<span className={kbd}>Del</span>
				</button>
				<button
					type="button"
					className={btn}
					title="删除后，同一轨道上右侧的片段整体左移补上空缺（其它轨道不动）"
					onClick={() => { onRippleDelete(); onClose(); }}
				>
					<ScissorsLineDashed size={13} className="text-red-400" />
					波纹删除
					<span className={kbd}>⇧Del</span>
				</button>
				{/* 重新生成：占位符=原地重跑；已有成片的分镜片段=上方轨道新增结果占位（原结果保留）。
				    ⚠ 是否显示由 segActions.build() 决定（不适用即不传 onRegenerate），此处不再按 kind 过滤 */}
				{onRegenerate && (
					<button type="button" className={btn} onClick={() => { onRegenerate(); onClose(); }}>
						<RefreshCw size={13} className="text-purple-400" />
						重新生成
					</button>
				)}
			</div>
		</>
	);
}
