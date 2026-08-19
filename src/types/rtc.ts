/**
 * rtc.ts — 实时剪辑（第三模式）数据模型
 *
 * 设计目标：**无损映射到剪映草稿 draft_content.json**（pyJianYingDraft 结构语义）：
 *   - 三层结构：轨道（track）→ 片段（segment）→ 素材（material）；
 *   - 时间基：**微秒**（剪映草稿同基，导出零换算）；
 *   - 片段带 target_timerange（时间轴位置）/ source_timerange（源素材裁剪窗口）/ speed。
 *
 * ⚠ 素材唯一性语义（勿回退）：
 *   - **segment = 素材的纯时间窗口引用**，assetId 是素材的唯一源头；
 *   - 分割/复制等一切剪辑操作**绝不产生新的素材实体**——split 只生成两个引用同一 assetId、
 *     source 窗口相邻互补的 segment（前段 source=[s, atUs)，后段 source=[atUs, e)）；
 *   - 导出剪映草稿时按 assetId 去重为**单条 material**，多个 segment 共同引用它。
 *
 * ⚠ 红线：模型里只存 assetId / uri 引用，**绝不存 base64/data:/blob:**（项目文件红线，
 *   stripHeavyRefs 会剥重字节；uri 只放本地 http://*.localhost 直链等轻量显示地址）。
 */
import { genId } from "@/lib/id";

export type RtcTrackType = "video" | "audio" | "text";

/**
 * 画幅（canvas）：项目的成片尺寸，映射剪映草稿 canvas_config.width/height。
 * 语义与剪映一致——画幅是**文档级**设置（一个剪辑文档一个画幅），所有图层在这个框内合成；
 * 预览区按此比例画 letterbox 框，导出草稿原样写入 canvas_config。
 */
export interface RtcCanvas {
	width: number;
	height: number;
}

/**
 * 片段在画幅内的变换（剪映「画面 · 基础」那一栏：缩放/位置/旋转/不透明度/镜像）。
 *
 * 基准：**缺省（无 transform）= 素材在画幅内 contain 居中铺满**，即 scale 1 / 位置 0 / 不旋转 / 不透明 1。
 * ⚠ 位置用**画幅宽高的比例**而非像素（剪映界面显示像素，我们内部存比例）——切换画幅或换分辨率档时
 * 素材不会失位，导出时再按当时的画幅像素换算。x 正向右、y 正向下，0 = 画幅中心。
 * 映射剪映草稿 segment.clip：scale{x,y} / transform{x,y}（归一化半宽半高）/ rotation / alpha / flip。
 */
export interface RtcTransform {
	/** 缩放倍率（1 = contain 铺满基准；剪映界面按百分比显示） */
	scaleX: number;
	scaleY: number;
	/** 位置偏移，单位=画幅宽/高的比例（0 = 居中） */
	x: number;
	y: number;
	/** 旋转角度（度，顺时针） */
	rotation: number;
	/** 不透明度 0..1 */
	opacity: number;
	/** 水平/垂直镜像 */
	flipH?: boolean;
	flipV?: boolean;
}

/** 变换缺省值：contain 居中铺满、不旋转、完全不透明 */
export const DEFAULT_RTC_TRANSFORM: RtcTransform = {
	scaleX: 1,
	scaleY: 1,
	x: 0,
	y: 0,
	rotation: 0,
	opacity: 1,
};

/** 读片段变换（缺省/非法值回退默认）——所有消费方走这里，别各自写回退 */
export function segTransform(seg: Pick<RtcSegment, "transform">): RtcTransform {
	const t = seg.transform;
	if (!t) return DEFAULT_RTC_TRANSFORM;
	const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
	return {
		scaleX: num(t.scaleX, 1),
		scaleY: num(t.scaleY, 1),
		x: num(t.x, 0),
		y: num(t.y, 0),
		rotation: num(t.rotation, 0),
		opacity: Math.min(1, Math.max(0, num(t.opacity, 1))),
		...(t.flipH ? { flipH: true } : {}),
		...(t.flipV ? { flipV: true } : {}),
	};
}

/** 剪辑文档：轨道容器 + 全局帧率（默认 30，映射草稿 fps）+ 画幅（默认 1920×1080） */
export interface RtcDoc {
	id: string;
	name: string;
	/** 帧率（默认 30） */
	fps: number;
	/** 成片画幅（缺省视为 1920×1080——存量文档无此字段，零迁移） */
	canvas?: RtcCanvas;
	tracks: RtcTrack[];
	/* ── 第二批：标记/关键帧 ── */
	/** 时间轴标记（doc 级小旗，按 timeUs 升序；读取一律先过 lib/rtcMarkers.sanitizeMarkers 防御清洗）。
	 *  缺省=无标记（存量文档零迁移，与全部可选字段同做法）。 */
	markers?: RtcMarker[];
	/* ── 第四批：复合片段 ──
	 * 子时间轴登记表（subDocId → 子文档）。复合片段（kind:"compound"）经 subDocId 引用这里；
	 * 随 rtcDoc 一体落盘/undo（commit 的不可变契约天然覆盖，无需单独持久化通道）。
	 * 缺省/空表 = 无复合片段（存量文档零迁移）。孤儿子文档（无片段引用）在载入清洗时剔除
	 * （见 lib/rtcCompound.sanitizeRtcCompound）。 */
	subDocs?: Record<string, RtcSubDoc>;
}

/* ── 第四批：复合片段 ──
 * 子时间轴（RtcSubDoc）= 精简的剪辑文档：只有 id/name/tracks——fps 与画幅**恒随主文档**
 * （剪映复合片段同语义：子时间轴没有独立帧率/画幅）。
 * ⚠ 嵌套深度 1（P0 定稿）：子文档的轨道上**不允许再出现 compound 片段**（载入清洗会把
 *   嵌套的 compound 降级为占位符），复合内不再嵌复合。 */
export interface RtcSubDoc {
	id: string;
	name: string;
	tracks: RtcTrack[];
}

/** 画幅缺省值（存量文档无 canvas 字段时的口径，与 jianyingDraft 导出缺省一致） */
export const DEFAULT_RTC_CANVAS: RtcCanvas = { width: 1920, height: 1080 };

/** 读文档画幅（缺省回退 1920×1080）——所有消费方走这里，别各自写回退 */
export function docCanvas(doc: Pick<RtcDoc, "canvas">): RtcCanvas {
	const c = doc.canvas;
	if (!c || !(c.width > 0) || !(c.height > 0)) return DEFAULT_RTC_CANVAS;
	return { width: Math.round(c.width), height: Math.round(c.height) };
}

/** 轨道：同类型片段的水平容器（映射草稿 tracks[]；segments 恒按 targetStartUs 升序、互不重叠） */
export interface RtcTrack {
	id: string;
	type: RtcTrackType;
	name?: string;
	muted?: boolean;
	locked?: boolean;
	/**
	 * 轨道角色（**遗留字段**，第238轮补充10 起原文不再落轨）。"script"=旧形态原文参考轨——
	 * 现原文由 rtcScriptLane 从主轨实时派生（非片段数据），存量 doc 里的该轨在加载时被
	 * rtcOps.pruneScriptTracks 整轨清除；散落的 role 判定（导出跳过/字幕动作绕开等）仅作
	 * 未清洗 doc 的防御保留。勿再写入新的 role:"script" 轨。
	 */
	role?: "script";
	/** 按 targetStartUs 升序、不重叠（rtcOps 全部操作维持此不变量） */
	segments: RtcSegment[];
}

/**
 * 片段：轨道上的一段时间窗口，**引用**素材而非持有素材。
 * media 片段：assetId 指向 AssetBlob/素材库素材（同一素材可被任意多个片段引用）；
 * placeholder 片段：分镜视频占位符（shotRef 关联分镜，无源素材约束）。
 */
export interface RtcSegment {
	id: string;
	/** media=真实素材片段；placeholder=分镜视频占位符；compound=复合片段（子时间轴引用，第四批） */
	kind: "media" | "placeholder" | "compound";
	media?: "image" | "video" | "audio";
	name?: string;
	/** AssetBlob/素材库 id 引用——素材唯一源头，绝不内嵌字节（导出时按此去重为单条 material） */
	assetId?: string;
	/* ── 第四批：复合片段 ──
	 * kind:"compound" 专用：引用 RtcDoc.subDocs 里的子时间轴（不带 assetId/uri）。
	 * ⚠ 与素材引用同构（勿回退）：source 窗口 = 子时间轴的时间窗；分割复合片段时两半
	 *   **共享同一 subDocId**、source 窗口相邻互补——绝不复制 subDoc。 */
	subDocId?: string;
	/** 显示用 uri（本地 http://*.localhost 直链等轻量地址；绝不放 base64/data:/blob:） */
	uri?: string;
	/** 时间轴位置（微秒）——映射草稿 target_timerange.start/duration */
	targetStartUs: number;
	targetDurationUs: number;
	/** 源素材裁剪窗口（微秒）——映射草稿 source_timerange；placeholder/图片可缺省 */
	sourceStartUs?: number;
	sourceDurationUs?: number;
	/** 变速倍率（默认 1；sourceDurationUs ≈ targetDurationUs × speed） */
	speed?: number;
	volume?: number;
	muted?: boolean;
	/** 占位符 ↔ 分镜关联（episodeId 沿用库内既有命名，同 PendingGen.shot） */
	shotRef?: { episodeId: string; shotId: string };
	/** 复合片段预留（P1） */
	groupId?: string;
	/**
	 * 画幅内的变换（缩放/位置/旋转/不透明度/镜像）。缺省 = contain 居中铺满，存量文档零迁移。
	 * ⚠ 读取一律走 segTransform()，别自己写 `seg.transform ?? {...}` 的回退。
	 */
	transform?: RtcTransform;

	/* ── 结果占位状态（"准备生成/正在生成"的占位片段用；media 落定后一律清空） ──
	 * 语义（用户定稿）：轨道是 AI 生成结果的存放位置，**不无缘无故增删**——待生成/生成中的内容
	 * 一律以占位片段表示；重新生成不覆盖原结果，而是在**上方轨道**新增一个结果占位（上下层=版本堆叠）。 */
	/** 生成状态：待生成 / 生成中 / 失败（成功=落成 media 片段并清空本组字段） */
	status?: "pending" | "running" | "failed";
	/** 生成进度 0–100（running 时有效） */
	progress?: number;
	/** 关联的生成任务标识（taskId 等，供断连找回/进度回填） */
	taskRef?: string;
	/** 版本堆叠：本占位是哪条片段的「重新生成」（指向被参照的原结果片段 id） */
	originSegId?: string;
	/** 占位要生成的产物类型（右键新建占位时选定：视频/图片/音频） */
	genKind?: "video" | "image" | "audio";
	/** 失败原因（status="failed" 时展示） */
	error?: string;

	/* ── 第二批：标记/关键帧 ── */
	/**
	 * 属性关键帧：key=可动画属性，value=帧列表（按 t 升序；载入/写入经 lib/rtcKeyframes 清洗）。
	 * ⚠ t = **相对片段 target 起点的微秒**——片段被移动时关键帧自动跟随；被裁剪时 t 不变，
	 *   越界的帧渲染时钳制到端值（数据保留不删）。
	 * 语义：有某属性的关键帧 → 该属性由关键帧**覆盖**基础 transform/volume：
	 *   - x/y 与 RtcTransform.x/y 同单位（画幅宽/高比例）；
	 *   - scale=等比单值，取 **scaleX 基准**（覆盖 scaleX，scaleY 按基础 transform 的 Y/X 比跟随）；
	 *   - opacity/volume 0..1；rotation 度（顺时针）。
	 * 读取/采样一律走 lib/rtcKeyframes（effectiveTransformAt / effectiveVolumeAt），勿自行插值。
	 */
	keyframes?: Partial<Record<RtcKfProp, RtcKeyframe[]>>;
	/* ── 第三批：倒放/裁剪/字幕/转场 ── */
	/**
	 * 倒放标记：本片段的素材是 **该原素材 assetId 的倒放副本**（ffmpeg 物理倒放后落成的新本地资产）。
	 * 「取消倒放」凭它换回原素材并把 source 窗口镜像回去（见 rtcOps.applyReverse）；缺省=非倒放。
	 */
	reversedFromAssetId?: string;
	/**
	 * 画面裁剪（保留区域的四边内缩比例 0..1，基准=素材画面自身）；全 0=不裁，
	 * 落库时全 0 **删字段**（rtcCropCore.storeCrop，与 transform 的「等于缺省则不写」同策略）。
	 * 导出剪映时挂在 material 的 crop 上——带裁剪的片段会单独克隆一条 material（素材文件仍只复制一份）。
	 */
	crop?: RtcCrop;
	/**
	 * 字幕内容与样式（text 轨片段专用）：content 为正文；样式缺省经 rtcTextCore.textStyleOf 统一回退
	 * （字号=画幅高比例约 0.07、白字黑描边、底部居中 y≈0.4）。⚠ 读取一律走 textStyleOf()，别自写回退。
	 */
	text?: RtcSubtitle;
	/**
	 * 转场（挂在**前一段**上，作用于与下一段的衔接；仅视频轨有意义）。
	 * effectId/resourceId 来自剪映内置转场资源表（lib/jyTransitions），导出草稿时落 materials.transitions
	 * 并追加进本片段的 extra_material_refs；**预览不渲染转场效果，导出剪映后生效**。
	 */
	transitionAfter?: RtcTransition;
}

/* ── 第二批：标记/关键帧 ── */

/** 时间轴标记（doc 级）：timeUs=时间轴绝对微秒；color 取 lib/rtcMarkers 的调色板（非法值归第一色） */
export interface RtcMarker {
	id: string;
	timeUs: number;
	color: string;
	note?: string;
}

/** 可打关键帧的属性（x/y/scale/rotation/opacity 作用于画面变换；volume 作用于声音） */
export type RtcKfProp = "x" | "y" | "scale" | "rotation" | "opacity" | "volume";

/** 单个关键帧：t=相对片段 target 起点的微秒，v=该属性的目标值（单位随属性，见 RtcSegment.keyframes 注释） */
export interface RtcKeyframe {
	t: number;
	v: number;
}

/* ── 第三批：倒放/裁剪/字幕/转场 —— 配套接口 ── */

/**
 * 画面裁剪：四边内缩比例（0..1，基准=素材画面自身宽/高），全 0=不裁。
 * 约束（rtcCropCore.normalizeCrop 收敛）：left+right / top+bottom 至少给画面留 10%。
 */
export interface RtcCrop {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/**
 * 字幕内容与基础样式。
 * fontSize=**相对画幅高的比例**（默认约 0.07——对应剪映字幕默认 8 号档）；
 * x/y=画幅比例定位（0=画幅中心，x 正向右、y 正向下；默认底部居中 y≈0.4）；
 * color/strokeColor 为 #RRGGBB（默认白字黑描边）。
 */
export interface RtcSubtitle {
	content: string;
	fontSize?: number;
	color?: string;
	strokeColor?: string;
	x?: number;
	y?: number;
}

/** 转场描述（资源三元组 + 时长；资源表见 lib/jyTransitions） */
export interface RtcTransition {
	/** 剪映转场 effect_id（短数字串） */
	effectId: string;
	/** 剪映转场 resource_id（长数字串） */
	resourceId: string;
	/** 展示名（叠化/闪黑…） */
	name: string;
	/** 转场时长（微秒） */
	durationUs: number;
}

/** 新建轨道（id 走库内统一 genId 惯例） */
export function createRtcTrack(type: RtcTrackType, name?: string): RtcTrack {
	return { id: genId("track"), type, ...(name ? { name } : {}), segments: [] };
}

/** 新建空剪辑文档：默认 30fps、画幅 1920×1080（16:9），含一条视频轨 + 一条音频轨 */
export function createEmptyRtcDoc(name = "未命名剪辑"): RtcDoc {
	return {
		id: genId("rtc"),
		name,
		fps: 30,
		canvas: { ...DEFAULT_RTC_CANVAS },
		tracks: [createRtcTrack("video"), createRtcTrack("audio")],
	};
}
