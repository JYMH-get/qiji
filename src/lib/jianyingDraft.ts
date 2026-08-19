/**
 * jianyingDraft.ts — 剪映草稿（draft_content.json / draft_meta_info.json）纯 JSON 构建器。
 *
 * 格式依据：GuanYixuan/pyJianYingDraft（剪映 5.9 明文模板，新版剪映可导入旧版明文草稿）——
 *   - 草稿文件夹 = <草稿根>\<草稿名>\{draft_content.json, draft_meta_info.json}，放进草稿根即被识别；
 *   - draft_content.json：模板骨架（fps/duration/canvas_config/materials{44 组}/tracks/platform 5.9.0）；
 *   - 素材：materials.videos[]（视频与图片，图片 type:"photo"、时长恒 3h）/ audios[]（type:"extract_music"）；
 *   - 片段：target_timerange/source_timerange 均 {start,duration} 微秒；每段一条 speeds 变速素材经
 *     extra_material_refs 关联；音频段 clip/hdr_settings 为 null；render_index=轨道导出序（pyJianYingDraft dumps 同法）；
 *   - id：素材/片段/轨道 = uuid4().hex（32 位小写十六进制无连字符）；草稿 id = 大写带连字符 UUID（模板同形）。
 *
 * ⚠ 图层顺序（勿回退，已核对 pyJianYingDraft 源码而非臆测）：
 *   - 该库 `dumps()` 里 `segment_json["render_index"] = export_index`（轨道按 track_order 升序后的下标），
 *     而 `append_track()` 的语义是「加到**最上层**」、`insert_track(at_index=…)` 的 0=最底层、
 *     len(tracks)=最顶层——即 **导出数组越靠后 = render_index 越大 = 图层越靠上（前景）**；
 *   - 我们侧显示序（rtcOps.orderTracksForDisplay）里，视频组 **doc.tracks 越靠后 = 时间轴上显示越靠上**
 *     （主轨=第一条 video 轨恒在视频组最下）——两者方向**一致**，故按 doc.tracks 数组序原样导出即可，
 *     **不需要反转**；改动导出顺序前先回头看这段，别把版本堆叠的上下层导反。
 *   - 导出范围=时间轴上全部轨道全部片段照单全导（剪映本就是图层叠加，覆盖关系与我们预览一致），
 *     只跳过尚无真实素材的占位片段（保留 warning）。
 *
 * ⚠ 素材去重（硬性要求，勿回退）：同一 assetId（无论被分割成多少段、被多轨引用多少次）在 materials
 *   里只出现一条，所有 segment 经同一 material_id 引用、各自带自己的 source_timerange。
 *
 * ⚠ 画面变换（segment.clip）：由片段的 RtcTransform 经 lib/rtcTransformCore.toJyClip 映射——
 *   位置单位换算（画幅比例 → 半画幅，**且 y 轴取负**）与 uniform_scale 语义的核实依据全在那个文件的
 *   注释里（已核 pyJianYingDraft segment.py 的 ClipSettings/VisualSegment，非臆测），改前先看。
 *   缺省（片段无 transform 字段）→ segTransform 回退默认值 → 映射结果恰为「不变换」的 clip
 *   （alpha 1 / flip 全 false / rotation 0 / scale 1,1 / transform 0,0 + uniform_scale{on:true,value:1}），
 *   与本轮之前硬编码的那份**逐键完全一致**，存量草稿零变化。此处**恒写 clip 而非省略**：
 *   pyJianYingDraft 的 VisualSegment.export_json 对每个可视片段都写 clip 与 uniform_scale，
 *   我们照写以保持模板同形（省略字段的风险未经验证，不值得为省几字节冒险）。音频片段 clip 恒 null
 *   （没有画面，剪映模板即如此），故音频片段上的 transform 在导出时被有意忽略。
 *
 * 纯函数零环境依赖（node 可测）：素材落地路径由调用方经 resolve 回调给出（服务层先定好
 *   草稿文件夹内 assets\ 的目标绝对路径再构建，见 services/jianyingExport.ts）。
 */
import { segTransform, type RtcDoc, type RtcSegment, type RtcTrack, type RtcTransition } from "@/types/rtc";
import { jyUniformScaleOn, toJyClip } from "./rtcTransformCore";
/* ── 第二批：关键帧导出（common_keyframes 按 pyJianYingDraft 5.9 形态；property_type 映射与
 *    位置单位换算（×2 半画幅、y 取负）的核实依据都在 rtcKeyframes.toJyCommonKeyframes 的注释里） */
import { toJyCommonKeyframes } from "./rtcKeyframes";
/* ── 第三批：倒放/裁剪/字幕/转场 ── 裁剪/字幕/转场的映射依据各自核心层（勿在本文件另写换算） */
import { toJyCrop, type JyCropJson } from "./rtcCropCore";
import { clampTransitionUs, findJyTransition } from "./jyTransitions";
import { hexToRgb01, jyTextSize, textStyleOf, type RtcSubtitleStyle } from "./rtcTextCore";
import {
	buildCompoundSegmentJson,
	buildCompoundShared,
	type JyCompanionSink,
	type JyCompoundShared,
	type JySubdraftFile,
} from "./jianyingCompound";

/** 剪映素材大类（materials.videos 里图片 type:"photo"） */
export type JyMaterialKind = "video" | "photo" | "audio";

/** resolve 回调返回：某 assetId 的落地信息（absPath=草稿最终引用的绝对路径） */
export interface JyResolvedAsset {
	absPath: string;
	/** 素材总时长（微秒）；photo 可给 0（内部落模板惯例 3h） */
	durationUs: number;
	width?: number;
	height?: number;
	kind: JyMaterialKind;
}

export type JyAssetResolver = (assetId: string) => JyResolvedAsset | null | undefined;

export interface BuildDraftOptions {
	/** 草稿名（draft_meta_info.draft_name）；缺省用 doc.name */
	draftName?: string;
	/** 画布尺寸（canvas_config），缺省 1920×1080 */
	canvasWidth?: number;
	canvasHeight?: number;
	/** 素材登记的导入时间戳（毫秒）；缺省 Date.now()——测试注入用 */
	nowMs?: number;
	/** 第四批：草稿文件夹绝对路径（复合片段 wrapper 内的绝对路径引用需要；纯测试可缺省） */
	draftFolderPath?: string;
}

export interface BuildDraftResult {
	draftContent: Record<string, unknown>;
	draftMetaInfo: Record<string, unknown>;
	warnings: string[];
	/** 实际被导出片段引用（且 resolve 成功）的 assetId 去重清单——服务层据此复制素材文件
	 *  （第四批：含复合片段子时间轴内联引用的素材——文件仍只复制一份） */
	usedAssetIds: string[];
	/** 第四批：待落盘的 subdraft/<uuid>/ 文件（无复合片段时为空数组） */
	subdrafts: JySubdraftFile[];
}

/** 图片素材时长（微秒）：剪映/pyJianYingDraft 惯例 3 小时 */
export const JY_PHOTO_DURATION_US = 10_800_000_000;

/** uuid v4 → 32 位小写 hex（无连字符）：素材/片段/轨道 id（pyJianYingDraft uuid4().hex 同形） */
export function jyUuidHex(): string {
	const b = randomBytes16();
	b[6] = (b[6] & 0x0f) | 0x40; // version 4
	b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
	let s = "";
	for (const x of b) s += x.toString(16).padStart(2, "0");
	return s;
}

/** uuid v4 → 大写带连字符（草稿 id / draft_id，与模板同形） */
export function jyUuidUpper(): string {
	const h = jyUuidHex().toUpperCase();
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function randomBytes16(): Uint8Array {
	const b = new Uint8Array(16);
	const c = (globalThis as { crypto?: Crypto }).crypto;
	if (c?.getRandomValues) c.getRandomValues(b);
	else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
	return b;
}

/** 微秒取整并夹非负 */
function us(n: number | undefined, fallback = 0): number {
	const v = Number(n);
	return Number.isFinite(v) && v > 0 ? Math.round(v) : fallback;
}

function basenameOf(absPath: string): string {
	const parts = absPath.split(/[\\/]/);
	return parts[parts.length - 1] || absPath;
}

/** 模板骨架：draft_content.json（pyJianYingDraft assets/draft_content_template.json 逐键同形）。
 *  第四批起导出：jianyingCompound 以它为 wrapper 骨架（§3 允许最简化，待真机再收）。 */
export function contentTemplate(): Record<string, unknown> {
	return {
		canvas_config: { height: 1080, ratio: "original", width: 1920 },
		color_space: 0,
		config: {
			adjust_max_index: 1,
			attachment_info: [],
			combination_max_index: 1,
			export_range: null,
			extract_audio_last_index: 1,
			lyrics_recognition_id: "",
			lyrics_sync: true,
			lyrics_taskinfo: [],
			maintrack_adsorb: true,
			material_save_mode: 0,
			multi_language_current: "none",
			multi_language_list: [],
			multi_language_main: "none",
			multi_language_mode: "none",
			original_sound_last_index: 1,
			record_audio_last_index: 1,
			sticker_max_index: 1,
			subtitle_keywords_config: null,
			subtitle_recognition_id: "",
			subtitle_sync: true,
			subtitle_taskinfo: [],
			system_font_list: [],
			video_mute: false,
			zoom_info_params: null,
		},
		cover: null,
		create_time: 0,
		duration: 0,
		extra_info: null,
		fps: 30.0,
		free_render_index_mode_on: false,
		group_container: null,
		id: jyUuidUpper(),
		keyframe_graph_list: [],
		keyframes: {
			adjusts: [], audios: [], effects: [], filters: [],
			handwrites: [], stickers: [], texts: [], videos: [],
		},
		last_modified_platform: { app_id: 3704, app_source: "lv", app_version: "5.9.0", os: "windows" },
		platform: { app_id: 3704, app_source: "lv", app_version: "5.9.0", os: "windows" },
		materials: emptyMaterials(),
		mutable_config: null,
		name: "",
		new_version: "110.0.0",
		relationships: [],
		render_index_track_mode_on: false,
		retouch_cover: null,
		source: "default",
		static_cover_image_path: "",
		time_marks: null,
		tracks: [],
		update_time: 0,
		version: 360000,
	};
}

/** materials 全量空骨架（44 组，键名与模板逐一对应） */
function emptyMaterials(): Record<string, unknown[]> {
	return {
		ai_translates: [], audio_balances: [], audio_effects: [], audio_fades: [],
		audio_track_indexes: [], audios: [], beats: [], canvases: [], chromas: [],
		color_curves: [], digital_humans: [], drafts: [], effects: [], flowers: [],
		green_screens: [], handwrites: [], hsl: [], images: [], log_color_wheels: [],
		loudnesses: [], manual_deformations: [], masks: [], material_animations: [],
		material_colors: [], multi_language_refs: [], placeholders: [], plugin_effects: [],
		primary_color_wheels: [], realtime_denoises: [], shapes: [], smart_crops: [],
		smart_relights: [], sound_channel_mappings: [], speeds: [], stickers: [],
		tail_leaders: [], text_templates: [], texts: [], time_marks: [], transitions: [],
		video_effects: [], video_trackings: [], videos: [], vocal_beautifys: [],
		vocal_separations: [],
	};
}

/** 模板骨架：draft_meta_info.json（pyJianYingDraft assets/draft_meta_info.json 逐键同形；
 *  路径类字段留空即可被剪映识别并自行回填——pyJianYingDraft 实证，勿填猜测值） */
function metaTemplate(): Record<string, unknown> {
	return {
		cloud_package_completed_time: "",
		draft_cloud_capcut_purchase_info: "",
		draft_cloud_last_action_download: false,
		draft_cloud_materials: [],
		draft_cloud_purchase_info: "",
		draft_cloud_template_id: "",
		draft_cloud_tutorial_info: "",
		draft_cloud_videocut_purchase_info: "",
		draft_cover: "",
		draft_deeplink_url: "",
		draft_enterprise_info: {
			draft_enterprise_extra: "",
			draft_enterprise_id: "",
			draft_enterprise_name: "",
			enterprise_material: [],
		},
		draft_fold_path: "",
		draft_id: jyUuidUpper(),
		draft_is_ai_packaging_used: false,
		draft_is_ai_shorts: false,
		draft_is_ai_translate: false,
		draft_is_article_video_draft: false,
		draft_is_from_deeplink: "false",
		draft_is_invisible: false,
		draft_materials: [0, 1, 2, 3, 6, 7, 8].map((t) => ({ type: t, value: [] })),
		draft_materials_copied_info: [],
		draft_name: "",
		draft_new_version: "",
		draft_removable_storage_device: "",
		draft_root_path: "",
		draft_segment_extra_info: [],
		draft_type: "",
		tm_draft_cloud_completed: "",
		tm_draft_cloud_modified: 0,
		tm_draft_removed: 0,
		tm_duration: 0,
	};
}

/** 视频/图片素材条目（pyJianYingDraft VideoMaterial.export_json 同形）。
 *  第三批：可选 crop 覆盖默认的「不裁」8 角坐标（画面裁剪挂 material，见 rtcCropCore.toJyCrop）。 */
function videoMaterialJson(id: string, r: JyResolvedAsset, durationUs: number, crop?: JyCropJson | null): Record<string, unknown> {
	return {
		audio_fade: null,
		category_id: "",
		category_name: "local",
		check_flag: 63487,
		crop: crop ?? {
			upper_left_x: 0.0, upper_left_y: 0.0, upper_right_x: 1.0, upper_right_y: 0.0,
			lower_left_x: 0.0, lower_left_y: 1.0, lower_right_x: 1.0, lower_right_y: 1.0,
		},
		crop_ratio: "free",
		crop_scale: 1.0,
		duration: durationUs,
		height: r.height && r.height > 0 ? Math.round(r.height) : 1080,
		id,
		local_material_id: "",
		material_id: id,
		material_name: basenameOf(r.absPath),
		media_path: "",
		path: r.absPath,
		type: r.kind === "photo" ? "photo" : "video",
		width: r.width && r.width > 0 ? Math.round(r.width) : 1920,
	};
}

/** 音频素材条目（pyJianYingDraft AudioMaterial.export_json 同形，type 恒 "extract_music"） */
function audioMaterialJson(id: string, r: JyResolvedAsset, durationUs: number): Record<string, unknown> {
	return {
		app_id: 0,
		category_id: "",
		category_name: "local",
		check_flag: 3,
		copyright_limit_type: "none",
		duration: durationUs,
		effect_id: "",
		formula_id: "",
		id,
		local_material_id: id,
		music_id: id,
		name: basenameOf(r.absPath),
		path: r.absPath,
		source_platform: 0,
		type: "extract_music",
		wave_points: [],
	};
}

interface SegmentBuild {
	json: Record<string, unknown>;
	endUs: number;
}

/** 单个片段 → 剪映 segment JSON（含专属 speeds 变速素材登记） */
function buildSegmentJson(
	seg: RtcSegment,
	materialId: string,
	kind: JyMaterialKind,
	speeds: Record<string, unknown>[],
): SegmentBuild {
	const speed = seg.speed && seg.speed > 0 ? seg.speed : 1;
	const volume = seg.muted ? 0 : seg.volume != null && seg.volume >= 0 ? seg.volume : 1;
	const targetStart = us(seg.targetStartUs);
	const targetDuration = us(seg.targetDurationUs);
	// source 窗口：doc 给了就原样用；缺省（图片等）按剪映语义 source.duration = target.duration × speed
	const hasSource = seg.sourceDurationUs != null && seg.sourceDurationUs > 0;
	const sourceStart = hasSource ? us(seg.sourceStartUs) : 0;
	const sourceDuration = hasSource ? us(seg.sourceDurationUs) : Math.round(targetDuration * speed);

	const speedId = jyUuidHex();
	speeds.push({ curve_speed: null, id: speedId, mode: 0, speed, type: "speed" });

	const json: Record<string, unknown> = {
		enable_adjust: true,
		enable_color_correct_adjust: false,
		enable_color_curves: true,
		enable_color_match_adjust: false,
		enable_color_wheels: true,
		enable_lut: true,
		enable_smart_color_adjust: false,
		last_nonzero_volume: volume > 0 ? volume : 1.0,
		reverse: false,
		track_attribute: 0,
		track_render_index: 0,
		visible: true,
		id: jyUuidHex(),
		material_id: materialId,
		target_timerange: { start: targetStart, duration: targetDuration },
		// ── 第二批：关键帧——无关键帧片段恒为 []（与改造前逐字节一致，存量草稿零变化）；
		// 音频片段只导 volume（KFTypeVolume），视觉片段六属性全导，越界帧钳制见 toJyCommonKeyframes
		common_keyframes: toJyCommonKeyframes(seg, kind, jyUuidHex),
		keyframe_refs: [],
		source_timerange: { start: sourceStart, duration: sourceDuration },
		speed,
		volume,
		extra_material_refs: [speedId],
		is_tone_modify: false,
	};
	if (kind === "audio") {
		// 音频无画面：剪映模板里 clip/hdr_settings 恒 null（片段上若带 transform，导出时有意忽略）
		json.clip = null;
		json.hdr_settings = null;
	} else {
		// 画面变换：缺省 transform → segTransform 回默认 → 与本轮之前硬编码的「不变换」clip 逐键一致
		const t = segTransform(seg);
		json.clip = toJyClip(t);
		json.uniform_scale = { on: jyUniformScaleOn(t), value: 1.0 };
		json.hdr_settings = { intensity: 1.0, mode: 1, nits: 1000 };
	}
	return { json, endUs: targetStart + targetDuration };
}

function segLabel(track: RtcTrack, seg: RtcSegment, index: number): string {
	return seg.name || `${track.name || track.type} 轨第 ${index + 1} 段`;
}

/**
 * RtcDoc → 剪映草稿两份 JSON。
 * 规则：placeholder 片段跳过记 warning；素材按 assetId 去重为单条 material；
 *       全空轨道不导出；duration = 全部导出片段的最大 target 终点。
 * 第三批：
 *   - **字幕轨真导出**（materials.texts + text 轨；无内容的字幕片段跳过记 warning）；
 *     ⚠ text 轨统一排在导出数组**末尾**——render_index 按导出序分配、越大越靠上（前景），
 *     字幕必须压在全部画面层之上；video/audio 轨的导出序原样保留（存量草稿零变化）；
 *   - **画面裁剪**：crop 挂 material（剪映语义）→ 带 crop 的片段**单独克隆一条 material**
 *     （同 path 不同 material id，素材文件仍只复制一份），无 crop 的片段照旧共享去重条目；
 *   - **转场**：挂在前一段上的 transitionAfter → materials.transitions 条目 + 该段 extra_material_refs。
 */
export function buildDraftContent(
	doc: RtcDoc,
	resolve: JyAssetResolver,
	opts?: BuildDraftOptions,
): BuildDraftResult {
	const warnings: string[] = [];
	const speeds: Record<string, unknown>[] = [];
	const videoMaterials: Record<string, unknown>[] = [];
	const audioMaterials: Record<string, unknown>[] = [];
	const textMaterials: Record<string, unknown>[] = [];
	const transitionMaterials: Record<string, unknown>[] = [];
	/** assetId → { materialId, kind }：去重的唯一登记处 */
	const materialByAsset = new Map<string, { materialId: string; kind: JyMaterialKind }>();
	/** assetId → resolve 结果（meta 素材登记要 absPath/宽高/时长） */
	const resolvedByAsset = new Map<string, JyResolvedAsset>();
	const usedAssetIds: string[] = [];
	/** assetId → 该素材全部片段 source 终点最大值（素材时长兜底：duration 必须 ≥ 一切 source 终点） */
	const maxSourceEnd = new Map<string, number>();
	/** 带 crop 的素材克隆条目（同 assetId 不同 material id；时长收尾时一并兜底） */
	const cropClones: Array<{ assetId: string; mat: Record<string, unknown> }> = [];
	/** 文本轨导出条目（收尾统一 push 到 tracks 末尾——render_index 高位=字幕恒在画面之上） */
	const textTrackJsons: Record<string, unknown>[] = [];

	/** 解析并登记素材（首见才 resolve；失败记 warning 返回 null）——去重与 crop 克隆共用同一入口 */
	const ensureResolved = (assetId: string, label: string): JyResolvedAsset | null => {
		const cached = resolvedByAsset.get(assetId);
		if (cached) return cached;
		const r = resolve(assetId);
		if (!r || !r.absPath) {
			warnings.push(`素材 ${assetId}（片段「${label}」）本地文件缺失，已跳过`);
			return null;
		}
		resolvedByAsset.set(assetId, r);
		usedAssetIds.push(assetId);
		return r;
	};

	const nowMs = opts?.nowMs ?? Date.now();
	const canvasW = opts?.canvasWidth && opts.canvasWidth > 0 ? Math.round(opts.canvasWidth) : 1920;
	const canvasH = opts?.canvasHeight && opts.canvasHeight > 0 ? Math.round(opts.canvasHeight) : 1080;

	/* ── 第四批：复合片段（格式依据 docs/剪映复合片段草稿结构.md，构建在 jianyingCompound.ts） ── */
	const subdrafts: JySubdraftFile[] = [];
	/** subDocId → 共享部件（分割出的多个复合段共享同一份内联/subdraft，绝不重复） */
	const compoundSharedBySub = new Map<string, JyCompoundShared>();
	const draftsMaterials: Record<string, unknown>[] = [];
	/** 复合段的伴生素材组（speeds 与普通段共用同一数组；其余组仅复合存在时并入 materials） */
	const compSink: JyCompanionSink = {
		speeds,
		placeholder_infos: [],
		hsl: [],
		canvases: [],
		sound_channel_mappings: [],
		material_colors: [],
		vocal_separations: [],
	};
	/** 仅被子时间轴内联引用的素材的 kind（meta 登记用；主 materials 不为它们建条目——内联自带记录） */
	const subKindByAsset = new Map<string, JyMaterialKind>();
	const noteSubAsset = (assetId: string, r: JyResolvedAsset) => {
		if (!resolvedByAsset.has(assetId)) {
			resolvedByAsset.set(assetId, r);
			usedAssetIds.push(assetId);
		}
		if (!subKindByAsset.has(assetId)) subKindByAsset.set(assetId, r.kind);
	};

	const tracks: Record<string, unknown>[] = [];
	let docDurationUs = 0;

	for (const track of doc.tracks) {
		// 原文参考轨（role:"script"）：设计即不导出（剪辑参考信息，非成片内容）——静默跳过不记 warning
		if (track.role === "script") continue;
		if (track.type === "text") {
			// 第三批：字幕轨真导出（原「P0 跳过」废止）。有内容的片段 → texts material + text 片段；
			// 无内容（含误落进来的占位/素材片段）→ 跳过记 warning，措辞保留「文本轨」字样。
			const segJsons: Record<string, unknown>[] = [];
			const ordered = [...track.segments].sort((a, b) => (a.targetStartUs || 0) - (b.targetStartUs || 0));
			for (let i = 0; i < ordered.length; i++) {
				const seg = ordered[i];
				if (seg.kind !== "media" || !seg.text?.content?.trim()) {
					warnings.push(`文本轨「${track.name || "字幕"}」第 ${i + 1} 段（${segLabel(track, seg, i)}）无字幕内容，已跳过`);
					continue;
				}
				if (!(us(seg.targetDurationUs) > 0)) {
					warnings.push(`文本轨片段「${segLabel(track, seg, i)}」时长为 0，已跳过`);
					continue;
				}
				const style = textStyleOf(seg);
				const matId = jyUuidHex();
				textMaterials.push(textMaterialJson(matId, style));
				const built = buildTextSegmentJson(seg, matId, style, speeds);
				segJsons.push(built.json);
				docDurationUs = Math.max(docDurationUs, built.endUs);
			}
			if (segJsons.length === 0) continue;
			textTrackJsons.push({
				attribute: track.muted ? 1 : 0,
				flag: 0,
				id: jyUuidHex(),
				is_default_name: !track.name,
				name: track.name || "",
				segments: segJsons,
				type: "text",
			});
			continue;
		}
		const segJsons: Record<string, unknown>[] = [];
		// 防御式按时间轴位置升序（rtcOps 恒维持该不变量，这里兜底）
		const ordered = [...track.segments].sort((a, b) => (a.targetStartUs || 0) - (b.targetStartUs || 0));
		for (let i = 0; i < ordered.length; i++) {
			const seg = ordered[i];
			if (seg.kind === "placeholder") {
				warnings.push(`占位符片段「${segLabel(track, seg, i)}」尚未生成视频，已跳过`);
				continue;
			}
			// 第四批：复合片段 → 三件套构建分支（同 subDoc 只建一次共享部件，段各自 12 键 + 8 组伴生）
			if (seg.kind === "compound") {
				const sub = seg.subDocId ? doc.subDocs?.[seg.subDocId] : undefined;
				if (!sub) {
					warnings.push(`复合片段「${segLabel(track, seg, i)}」缺少子时间轴数据，已跳过`);
					continue;
				}
				if (!(us(seg.targetDurationUs) > 0)) {
					warnings.push(`复合片段「${segLabel(track, seg, i)}」时长为 0，已跳过`);
					continue;
				}
				let shared = compoundSharedBySub.get(seg.subDocId!);
				if (!shared) {
					shared = buildCompoundShared(sub, {
						resolve,
						fps: doc.fps && doc.fps > 0 ? doc.fps : 30,
						canvasWidth: canvasW,
						canvasHeight: canvasH,
						nowMs,
						draftFolderPath: opts?.draftFolderPath,
						warnings,
						onAssetUsed: noteSubAsset,
					});
					compoundSharedBySub.set(seg.subDocId!, shared);
					videoMaterials.push(shared.virtualMaterial); // 虚拟视频素材（§2.2）
					draftsMaterials.push(shared.draftsMaterial); // drafts/combination 素材（§2.3）
					subdrafts.push(shared.subdraft);
				}
				segJsons.push(buildCompoundSegmentJson(seg, shared, compSink));
				docDurationUs = Math.max(docDurationUs, us(seg.targetStartUs) + us(seg.targetDurationUs));
				continue;
			}
			if (!seg.assetId) {
				warnings.push(`片段「${segLabel(track, seg, i)}」缺少素材引用（assetId），已跳过`);
				continue;
			}
			if (!(us(seg.targetDurationUs) > 0)) {
				warnings.push(`片段「${segLabel(track, seg, i)}」时长为 0，已跳过`);
				continue;
			}
			const r = ensureResolved(seg.assetId, segLabel(track, seg, i));
			if (!r) continue;
			// 第三批：带 crop 的画面片段单独克隆一条 material（crop 挂素材上、素材又按 assetId 去重，
			// 二者冲突的定稿解法——克隆 material 不克隆文件）；音频无画面，crop 忽略。
			const cropJson = r.kind !== "audio" ? toJyCrop(seg.crop) : null;
			let materialId: string;
			let kind: JyMaterialKind;
			if (cropJson) {
				materialId = jyUuidHex();
				kind = r.kind;
				const dur = r.kind === "photo" ? (us(r.durationUs) || JY_PHOTO_DURATION_US) : us(r.durationUs);
				const mat = videoMaterialJson(materialId, r, dur, cropJson);
				videoMaterials.push(mat);
				cropClones.push({ assetId: seg.assetId, mat });
			} else {
				let entry = materialByAsset.get(seg.assetId);
				if (!entry) {
					entry = { materialId: jyUuidHex(), kind: r.kind };
					materialByAsset.set(seg.assetId, entry);
					// 素材条目先占位（duration 收尾统一按 maxSourceEnd 兜底修正）
					if (r.kind === "audio") audioMaterials.push(audioMaterialJson(entry.materialId, r, us(r.durationUs)));
					else videoMaterialJson0(videoMaterials, entry.materialId, r);
				}
				materialId = entry.materialId;
				kind = entry.kind;
			}
			const built = buildSegmentJson(seg, materialId, kind, speeds);
			const srcEnd = (built.json.source_timerange as { start: number; duration: number });
			maxSourceEnd.set(seg.assetId, Math.max(maxSourceEnd.get(seg.assetId) ?? 0, srcEnd.start + srcEnd.duration));
			// 第三批：转场（挂在前一段上；仅视频轨有画面衔接语义）
			if (track.type === "video" && seg.transitionAfter) {
				const trId = jyUuidHex();
				transitionMaterials.push(transitionMaterialJson(trId, seg.transitionAfter));
				(built.json.extra_material_refs as string[]).push(trId);
			}
			segJsons.push(built.json);
			docDurationUs = Math.max(docDurationUs, built.endUs);
		}
		if (segJsons.length === 0) continue; // 空轨（含全被跳过的）不导出
		tracks.push({
			attribute: track.muted ? 1 : 0,
			flag: 0,
			id: jyUuidHex(),
			is_default_name: !track.name,
			name: track.name || "",
			segments: segJsons,
			type: track.type,
		});
	}

	// 文本轨恒排在导出数组末尾（第三批）：render_index 按导出序分配、越大越靠上，字幕压全部画面之上
	tracks.push(...textTrackJsons);

	// render_index = 轨道导出序（pyJianYingDraft dumps 同法：该轨全部片段共用）
	// ⚠ 越大 = 图层越靠上（前景），与我们「doc.tracks 越靠后 = 时间轴显示越靠上」同向 → 原样按数组序，勿反转（见文件头）
	tracks.forEach((t, ti) => {
		for (const s of t.segments as Record<string, unknown>[]) {
			// 第四批：复合段是样本 12 键精简形态（source:"segmentsourcenormal"），不带 render_index——照样本勿补
			if (s.source === "segmentsourcenormal") continue;
			s.render_index = ti;
		}
	});

	// 素材时长收尾：duration 必须 ≥ 该素材全部片段 source 终点（探测失败/photo 默认值兜底）
	for (const [assetId, entry] of materialByAsset) {
		const list = entry.kind === "audio" ? audioMaterials : videoMaterials;
		const mat = list.find((m) => m.id === entry.materialId);
		if (!mat) continue;
		const need = maxSourceEnd.get(assetId) ?? 0;
		const cur = Number(mat.duration) || 0;
		if (entry.kind === "photo") mat.duration = Math.max(cur > 0 ? cur : JY_PHOTO_DURATION_US, need);
		else mat.duration = Math.max(cur, need);
	}
	// crop 克隆条目同规兜底（maxSourceEnd 按 assetId 聚合，恒 ≥ 该克隆自己引用的 source 终点）
	for (const { assetId, mat } of cropClones) {
		mat.duration = Math.max(Number(mat.duration) || 0, maxSourceEnd.get(assetId) ?? 0);
	}

	const draftContent = contentTemplate();
	draftContent.fps = doc.fps && doc.fps > 0 ? doc.fps : 30;
	draftContent.duration = docDurationUs;
	draftContent.canvas_config = { height: canvasH, ratio: "original", width: canvasW };
	const materials = draftContent.materials as Record<string, unknown[]>;
	materials.videos = videoMaterials;
	materials.audios = audioMaterials;
	materials.speeds = speeds;
	materials.texts = textMaterials; // 第三批：字幕素材
	materials.transitions = transitionMaterials; // 第三批：转场素材
	// 第四批：复合片段的伴生素材组——**仅存在复合段时**并入（无复合时导出逐字节与旧版一致；
	// placeholder_infos 是 10.9 组、5.9 骨架无此键，也只在此时补上）
	if (compoundSharedBySub.size > 0) {
		materials.drafts = draftsMaterials;
		materials.placeholder_infos = compSink.placeholder_infos;
		materials.hsl = compSink.hsl;
		materials.canvases = compSink.canvases;
		materials.sound_channel_mappings = compSink.sound_channel_mappings;
		materials.material_colors = compSink.material_colors;
		materials.vocal_separations = compSink.vocal_separations;
	}
	draftContent.tracks = tracks;

	const draftMetaInfo = metaTemplate();
	draftMetaInfo.draft_name = opts?.draftName || doc.name || "";
	draftMetaInfo.tm_duration = docDurationUs;

	/*
	 * 素材面板登记（draft_meta_info.draft_materials 的 type:0 桶）——⚠ 缺了它草稿能放但**素材栏为空**，
	 * 用户没法从面板取素材二次编辑（第236轮复合片段探针 v2 真机实锤修复；形态见
	 * docs/剪映复合片段草稿结构.md §4）。`metetype` 是剪映原文拼写，勿"修正"。
	 */
	const nowSec = Math.floor(nowMs / 1000);
	const metaEntries = usedAssetIds.map((assetId) => {
		const r = resolvedByAsset.get(assetId);
		if (!r) return null;
		// 第三批：素材可能只以 crop 克隆条目出现（materialByAsset 无登记）——kind/duration 改从
		// resolve 结果与克隆条目兜底取，面板登记一条不少
		const entry = materialByAsset.get(assetId);
		const kind = entry?.kind ?? subKindByAsset.get(assetId) ?? r.kind;
		const mat = entry
			? (kind === "audio" ? audioMaterials : videoMaterials).find((m) => m.id === entry.materialId)
			: cropClones.find((c) => c.assetId === assetId)?.mat;
		const dur = kind === "photo" ? 0 : Number(mat?.duration) || us(r.durationUs);
		return {
			create_time: nowSec,
			duration: dur,
			extra_info: basenameOf(r.absPath),
			file_Path: r.absPath,
			height: r.height && r.height > 0 ? Math.round(r.height) : 0,
			id: jyUuidUpper(),
			import_time: nowSec,
			import_time_ms: nowMs,
			item_source: 1,
			md5: "",
			metetype: kind === "photo" ? "photo" : kind === "audio" ? "music" : "video",
			roughcut_time_range: { duration: dur, start: 0 },
			sub_time_range: { duration: -1, start: -1 },
			type: 0,
			width: r.width && r.width > 0 ? Math.round(r.width) : 0,
		};
	}).filter((e): e is NonNullable<typeof e> => e !== null);
	const buckets = draftMetaInfo.draft_materials as Array<{ type: number; value: unknown[] }>;
	const bucket0 = buckets.find((b) => b.type === 0);
	if (bucket0) bucket0.value = metaEntries;

	return { draftContent, draftMetaInfo, warnings, usedAssetIds, subdrafts };
}

/** 视频/图片素材首次登记（duration 先按 resolve 值占位，收尾统一兜底修正） */
function videoMaterialJson0(list: Record<string, unknown>[], id: string, r: JyResolvedAsset): void {
	const dur = r.kind === "photo" ? (us(r.durationUs) || JY_PHOTO_DURATION_US) : us(r.durationUs);
	list.push(videoMaterialJson(id, r, dur));
}

/* ── 第三批：倒放/裁剪/字幕/转场 —— 字幕/转场的 JSON 构建 ── */

/**
 * 字幕素材条目（materials.texts）——pyJianYingDraft TextSegment.export_material 同形（已核源码非臆测）：
 *   - `content` 是**序列化后的 JSON 字符串**（styles[0] 带 fill/size/strokes + range=[0, 字符数]）；
 *   - 颜色为 [0,1] RGB 三元组（hexToRgb01 换算）；字号经 jyTextSize 锚点换算（0.07↔8 号）；
 *   - 我方恒有黑描边默认 → strokes 恒一条，check_flag = 7|8 = 15（基础 7 + 描边 8）；
 *   - 描边 width 0.08 = pyJianYingDraft 默认 40 档的内部值（40/100×0.2）；
 *   - alignment 1 = 居中（字幕惯例）；line_max_width 0.82 / line_spacing 0.02 为该库缺省。
 */
function textMaterialJson(id: string, style: RtcSubtitleStyle): Record<string, unknown> {
	const content = {
		styles: [
			{
				fill: {
					alpha: 1.0,
					content: { render_type: "solid", solid: { alpha: 1.0, color: hexToRgb01(style.color, [1, 1, 1]) } },
				},
				range: [0, [...style.content].length],
				size: jyTextSize(style.fontSize),
				bold: false,
				italic: false,
				underline: false,
				strokes: [
					{ content: { solid: { alpha: 1.0, color: hexToRgb01(style.strokeColor, [0, 0, 0]) } }, width: 0.08 },
				],
			},
		],
		text: style.content,
	};
	return {
		id,
		content: JSON.stringify(content),
		typesetting: 0,
		alignment: 1,
		letter_spacing: 0,
		line_spacing: 0.02,
		line_feed: 1,
		line_max_width: 0.82,
		force_apply_line_max_width: false,
		check_flag: 15,
		type: "text",
		global_alpha: 1.0,
	};
}

/**
 * 字幕片段 JSON —— pyJianYingDraft TextSegment（VisualSegment 基类）export 同形：
 *   - `source_timerange` 恒 **null**（文本无源素材窗口，与 video 片段不同）；
 *   - 每段照旧登记一条 speeds（speed 恒 1）经 extra_material_refs 关联（该库对文本同样如此）；
 *   - `clip.transform` 按位置换算：x×2 / **−y×2**（半画幅单位 + y 轴取负，rtcTransformCore.toJyClip
 *     同一口径——默认 y=0.4 → transform.y=−0.8，恰是剪映导入字幕的惯用值，ClipSettings docstring 实证）；
 *   - **不写 hdr_settings**（那是 VideoSegment 专属；VisualSegment 基类无此键）。
 */
function buildTextSegmentJson(
	seg: RtcSegment,
	materialId: string,
	style: RtcSubtitleStyle,
	speeds: Record<string, unknown>[],
): SegmentBuild {
	const targetStart = us(seg.targetStartUs);
	const targetDuration = us(seg.targetDurationUs);
	const speedId = jyUuidHex();
	speeds.push({ curve_speed: null, id: speedId, mode: 0, speed: 1, type: "speed" });
	const r2 = (n: number) => Math.round(n * 100) / 100 + 0; // 定点 2 位并消 -0
	const json: Record<string, unknown> = {
		enable_adjust: true,
		enable_color_correct_adjust: false,
		enable_color_curves: true,
		enable_color_match_adjust: false,
		enable_color_wheels: true,
		enable_lut: true,
		enable_smart_color_adjust: false,
		last_nonzero_volume: 1.0,
		reverse: false,
		track_attribute: 0,
		track_render_index: 0,
		visible: true,
		id: jyUuidHex(),
		material_id: materialId,
		target_timerange: { start: targetStart, duration: targetDuration },
		common_keyframes: [],
		keyframe_refs: [],
		source_timerange: null,
		speed: 1,
		volume: 1,
		extra_material_refs: [speedId],
		is_tone_modify: false,
		clip: {
			alpha: 1.0,
			flip: { horizontal: false, vertical: false },
			rotation: 0.0,
			scale: { x: 1.0, y: 1.0 },
			transform: { x: r2(style.x * 2), y: r2(-style.y * 2) },
		},
		uniform_scale: { on: true, value: 1.0 },
	};
	return { json, endUs: targetStart + targetDuration };
}

/**
 * 转场素材条目（materials.transitions）——pyJianYingDraft Transition.export_json 同形
 * （category_id/category_name 空串、platform "all"、不导出 path/request_id；已核源码非臆测）。
 * is_overlap 按 effect_id 查资源表（lib/jyTransitions），表外资源按 true 兜底；时长夹 0.1–5s。
 */
function transitionMaterialJson(id: string, tr: RtcTransition): Record<string, unknown> {
	return {
		category_id: "",
		category_name: "",
		duration: clampTransitionUs(tr.durationUs, tr.effectId),
		effect_id: tr.effectId,
		id,
		is_overlap: findJyTransition(tr.effectId)?.isOverlap ?? true,
		name: tr.name || "",
		platform: "all",
		resource_id: tr.resourceId,
		type: "transition",
	};
}
