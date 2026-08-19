/**
 * jianyingCompound.ts — 剪映**复合片段**导出构建（第四批，纯 JSON 构建零环境依赖）。
 *
 * ⚠ 格式唯一事实来源：docs/剪映复合片段草稿结构.md（真机逆向 + 探针 v1→v4 二分实锤；
 *   pyJianYingDraft 不支持复合片段，勿按那套猜）。要点复述：
 *   - 主草稿三件套：①虚拟视频素材（materials.videos，path 空 + extra_type_option:2，§2.2）
 *     ②复合片段本体（12 键精简形态 + source:"segmentsourcenormal"，§2.1）
 *     ③drafts/combination 素材（8 键 + **子时间轴完整内联**，§2.3）；
 *   - 复合段 extra_material_refs = **8 组伴生**，顺序 drafts → speeds → placeholder_infos → hsl
 *     → canvases → sound_channel_mappings → material_colors → vocal_separations
 *     （⚠ 只挂 speeds 时剪映认得出复合但**不渲染画面**——伴生组是渲染必要条件，探针实锤）；
 *   - 内联子时间轴 = 精简方言：顶层 18 键 + 片段 12 键（伴生 6 组，无 drafts/hsl）+ 伴生极简条目；
 *   - subdraft/<X>/ 两件 JSON（wrapper + sub_draft_config）+ 松散副本；封面 jpg 可选不写；
 *   - 复合相关 id（X / combination_id / drafts 素材 id）用**大写连字符 UUID**（jyUuidUpper），
 *     与我们既有小写 hex id 混用 v4 实测无碍。
 *
 * 素材去重红线：内联子时间轴引用的 assetId 照常参与全局去重复制（onAssetUsed 上报）——
 * 内联 videos 条目是独立 material 记录，但 path 指向草稿 assets\ 里**同一份文件**。
 */
import type { RtcSegment, RtcSubDoc } from "@/types/rtc";
import {
	JY_PHOTO_DURATION_US,
	contentTemplate,
	jyUuidHex,
	jyUuidUpper,
	type JyAssetResolver,
	type JyResolvedAsset,
} from "./jianyingDraft";
import { subDocDurationUs } from "./rtcCompound";

type Json = Record<string, unknown>;

/** subdraft/<X>/ 两件落盘文件（服务层写盘 + 松散副本） */
export interface JySubdraftFile {
	uuid: string;
	wrapperJson: Json;
	configJson: Json;
}

/** 主草稿里复合段可能用到的伴生素材组收集器（buildDraftContent 传入自己的数组） */
export interface JyCompanionSink {
	speeds: Json[];
	placeholder_infos: Json[];
	hsl: Json[];
	canvases: Json[];
	sound_channel_mappings: Json[];
	material_colors: Json[];
	vocal_separations: Json[];
}

export interface JyCompoundBuildOpts {
	resolve: JyAssetResolver;
	fps: number;
	canvasWidth: number;
	canvasHeight: number;
	/** epoch 毫秒（sub_draft_config 时间戳；测试注入） */
	nowMs: number;
	/** 草稿文件夹绝对路径（wrapper 内 draft_file_path 等要绝对路径）；缺省退相对形态（纯测试） */
	draftFolderPath?: string;
	warnings: string[];
	/** 内联引用到的素材上报（全局 assetId 去重复制/meta 登记由 buildDraftContent 收口） */
	onAssetUsed: (assetId: string, r: JyResolvedAsset) => void;
}

/** 一个子文档在主草稿里的共享部件（同一 subDoc 被分割成多段时全部共享，绝不复制） */
export interface JyCompoundShared {
	/** X：subdraft 文件夹名 / 内联 id / config id（大写连字符 UUID） */
	subdraftUuid: string;
	/** 虚拟视频素材（materials.videos 一条，§2.2） */
	virtualMaterial: Json;
	/** drafts/combination 素材（materials.drafts 一条，§2.3，含内联） */
	draftsMaterial: Json;
	subDurationUs: number;
	subdraft: JySubdraftFile;
}

/* ────────────────────────── 伴生素材（极简条目，§2.3） ────────────────────────── */

interface CompanionRefs {
	ids: string[]; // 按 6 组内联顺序：speeds → placeholder_infos → canvases → sound_channel_mappings → material_colors → vocal_separations
}

/** 往 sink 里落 6 组伴生极简条目（speed ≠1 时 speeds 条目带值，其余恒极简）；返回引用 id 顺序表 */
function pushCompanions(sink: JyCompanionSink, speed: number): CompanionRefs {
	const speedId = jyUuidHex();
	sink.speeds.push(
		speed !== 1
			? { curve_speed: null, id: speedId, mode: 0, speed, type: "speed" }
			: { id: speedId, type: "speed" },
	);
	const phId = jyUuidHex();
	sink.placeholder_infos.push({ id: phId, meta_type: "none", type: "placeholder_info" });
	const cvId = jyUuidHex();
	sink.canvases.push({ id: cvId, type: "canvas_color" });
	const scmId = jyUuidHex();
	sink.sound_channel_mappings.push({ id: scmId, type: "none" });
	const mcId = jyUuidHex();
	sink.material_colors.push({ id: mcId });
	const vsId = jyUuidHex();
	sink.vocal_separations.push({ id: vsId, type: "vocal_separation" });
	return { ids: [speedId, phId, cvId, scmId, mcId, vsId] };
}

/** 12 键精简片段形态（§2.1；内联片段与主复合段同形，仅 extra_material_refs 组数不同） */
function sampleSegmentJson(
	extraRefs: string[],
	materialId: string,
	targetStart: number,
	targetDuration: number,
	sourceStart: number,
	sourceDuration: number,
): Json {
	return {
		responsive_layout: {},
		render_timerange: {},
		id: jyUuidHex(),
		enable_adjust_mask: false,
		enable_hsl: false,
		extra_material_refs: extraRefs,
		material_id: materialId,
		target_timerange: { start: targetStart, duration: targetDuration },
		source_timerange: { start: sourceStart, duration: sourceDuration },
		source: "segmentsourcenormal",
		hdr_settings: { mode: 1 },
		clip: { transform: { x: 0, y: 0 }, flip: {} },
	};
}

/* ────────────────────────── 内联子时间轴（§2.3 精简方言） ────────────────────────── */

function basenameOf(absPath: string): string {
	const parts = absPath.split(/[\\/]/);
	return parts[parts.length - 1] || absPath;
}

/** 小写连字符 uuid（内联 10.9 视频素材的 local_material_id 形态） */
function lowerHyphenUuid(): string {
	return jyUuidUpper().toLowerCase();
}

/** 内联视频/图片素材（10.9 形态近似：check_flag 62978047 + local_material_id 小写连字符 uuid） */
function inlineVideoMaterialJson(id: string, r: JyResolvedAsset, durationUs: number): Json {
	return {
		audio_fade: null,
		category_id: "",
		category_name: "local",
		check_flag: 62978047,
		crop: {
			upper_left_x: 0.0, upper_left_y: 0.0, upper_right_x: 1.0, upper_right_y: 0.0,
			lower_left_x: 0.0, lower_left_y: 1.0, lower_right_x: 1.0, lower_right_y: 1.0,
		},
		crop_ratio: "free",
		crop_scale: 1.0,
		duration: durationUs,
		extra_type_option: 0,
		height: r.height && r.height > 0 ? Math.round(r.height) : 1080,
		id,
		local_material_id: lowerHyphenUuid(),
		material_id: "",
		material_name: basenameOf(r.absPath),
		media_path: "",
		path: r.absPath,
		type: r.kind === "photo" ? "photo" : "video",
		width: r.width && r.width > 0 ? Math.round(r.width) : 1920,
	};
}

/** 内联音频素材（extract_music 形态；样本未覆盖音频子轨，按主草稿形态保守写） */
function inlineAudioMaterialJson(id: string, r: JyResolvedAsset, durationUs: number): Json {
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

/**
 * 内联子时间轴 JSON（顶层 18 键精简方言）。
 * ⚠ 探针结论：主草稿仍是我们方言时，内联**必须**用样本方言（v2/v4）——别把这里省回 5.9 全量模板。
 */
function buildInlineDraft(sub: RtcSubDoc, uuid: string, opts: JyCompoundBuildOpts): { json: Json; durationUs: number } {
	const speeds: Json[] = [];
	const placeholderInfos: Json[] = [];
	const canvases: Json[] = [];
	const soundChannelMappings: Json[] = [];
	const materialColors: Json[] = [];
	const vocalSeparations: Json[] = [];
	const videos: Json[] = [];
	const audios: Json[] = [];
	const sink: JyCompanionSink = {
		speeds,
		placeholder_infos: placeholderInfos,
		hsl: [], // 内联片段不带 hsl（§2.3：hsl 仅主草稿复合段引用）
		canvases,
		sound_channel_mappings: soundChannelMappings,
		material_colors: materialColors,
		vocal_separations: vocalSeparations,
	};
	/** 内联内的素材去重（assetId → 内联 material id；跨主/子共享的是**文件**，记录各自独立） */
	const matByAsset = new Map<string, { id: string; kind: JyResolvedAsset["kind"] }>();
	let durationUs = 0;
	let transformWarned = false;

	const tracks: Json[] = [];
	for (const t of sub.tracks) {
		if (t.type === "text") {
			if (t.segments.length > 0) opts.warnings.push(`复合片段「${sub.name}」内的文本轨暂不支持导出，已跳过 ${t.segments.length} 段`);
			continue;
		}
		const segJsons: Json[] = [];
		const ordered = [...t.segments].sort((a, b) => (a.targetStartUs || 0) - (b.targetStartUs || 0));
		for (const seg of ordered) {
			if (seg.kind !== "media") {
				opts.warnings.push(`复合片段「${sub.name}」内的占位片段「${seg.name || seg.id}」尚未生成，已跳过`);
				continue;
			}
			if (!seg.assetId || !(seg.targetDurationUs > 0)) {
				opts.warnings.push(`复合片段「${sub.name}」内的片段「${seg.name || seg.id}」缺少素材引用或时长为 0，已跳过`);
				continue;
			}
			let entry = matByAsset.get(seg.assetId);
			if (!entry) {
				const r = opts.resolve(seg.assetId);
				if (!r || !r.absPath) {
					opts.warnings.push(`复合片段「${sub.name}」内素材 ${seg.assetId} 本地文件缺失，已跳过`);
					continue;
				}
				entry = { id: jyUuidHex(), kind: r.kind };
				matByAsset.set(seg.assetId, entry);
				opts.onAssetUsed(seg.assetId, r); // 全局去重复制/meta 登记上报
				const dur = r.kind === "photo" ? JY_PHOTO_DURATION_US : Math.max(0, Math.round(r.durationUs));
				if (r.kind === "audio") audios.push(inlineAudioMaterialJson(entry.id, r, dur));
				else videos.push(inlineVideoMaterialJson(entry.id, r, dur));
			}
			const speed = seg.speed && seg.speed > 0 ? seg.speed : 1;
			const hasSource = seg.sourceDurationUs != null && seg.sourceDurationUs > 0;
			const targetStart = Math.max(0, Math.round(seg.targetStartUs));
			const targetDuration = Math.max(0, Math.round(seg.targetDurationUs));
			const sourceStart = hasSource ? Math.max(0, Math.round(seg.sourceStartUs as number)) : 0;
			const sourceDuration = hasSource
				? Math.max(0, Math.round(seg.sourceDurationUs as number))
				: Math.round(targetDuration * speed);
			const refs = pushCompanions(sink, speed);
			const json = sampleSegmentJson(refs.ids, entry.id, targetStart, targetDuration, sourceStart, sourceDuration);
			// 样本 12 键无 volume——静音/音量按需附加（混排 v4 实测无碍；缺省不写保持样本同形）
			if (seg.muted) json.volume = 0;
			else if (seg.volume != null && seg.volume >= 0 && seg.volume !== 1) json.volume = seg.volume;
			if (seg.transform && !transformWarned) {
				transformWarned = true;
				opts.warnings.push(`复合片段「${sub.name}」内片段的画面变换暂不随剪映导出（P0），已按默认画面导出`);
			}
			segJsons.push(json);
			durationUs = Math.max(durationUs, targetStart + targetDuration);
		}
		if (segJsons.length === 0) continue;
		tracks.push({ id: jyUuidHex(), is_default_name: !t.name, segments: segJsons, type: t.type });
	}

	// 素材时长兜底（duration ≥ 全部 source 终点）：内联侧简单按各条素材自身时长；剪映读内联主要取 path/type
	const json: Json = {
		canvas_config: { height: opts.canvasHeight, width: opts.canvasWidth },
		color_space: 0,
		config: { maintrack_adsorb: true },
		duration: durationUs,
		function_assistant_info: null,
		id: uuid,
		keyframes: {
			adjusts: [], audios: [], effects: [], filters: [],
			handwrites: [], stickers: [], texts: [], videos: [],
		},
		last_modified_platform: { app_id: 3704, app_source: "lv", app_version: "10.9.0", os: "windows" },
		materials: {
			audios,
			canvases,
			material_colors: materialColors,
			placeholder_infos: placeholderInfos,
			sound_channel_mappings: soundChannelMappings,
			speeds,
			videos,
			vocal_separations: vocalSeparations,
		},
		name: sub.name || "复合片段",
		new_version: "110.0.0",
		path: "",
		platform: { app_id: 3704, app_source: "lv", app_version: "10.9.0", os: "windows" },
		render_index_track_mode_on: false,
		smart_ads_info: null,
		tracks,
		uneven_animation_template_info: null,
		version: 360000,
	};
	return { json, durationUs };
}

/* ────────────────────────── 虚拟素材 / drafts 素材 / wrapper ────────────────────────── */

/** 虚拟视频素材（§2.2 样本形态克隆；path 空 = 无真实文件，extra_type_option:2 标记复合） */
function virtualVideoMaterialJson(id: string, name: string, durationUs: number, w: number, h: number): Json {
	return {
		path: "",
		extra_type_option: 2,
		duration: durationUs,
		is_set_beauty_mode: true,
		crop: {},
		video_mask_shadow: { resource_id: "", path: "" },
		check_flag: 62978047,
		video_mask_stroke: { path: "", type: "", resource_id: "" },
		material_name: name,
		id,
		width: w,
		video_algorithm: { story_video_modify_video_config: {}, path: "" },
		material_id: "",
		matting: { path: "" },
		beauty_face_auto_preset: {},
		height: h,
		type: "video",
		stable: { time_range: {} },
		is_copyright: true,
	};
}

/** drafts/combination 素材：主草稿 8 键（rich=false）/ wrapper 富键版（rich=true，§3） */
function draftsMaterialJson(
	uuid: string,
	inline: Json,
	name: string,
	pathPrefix: string,
	rich: boolean,
): Json {
	const base: Json = {
		id: jyUuidUpper(),
		type: "combination",
		combination_type: "none",
		combination_id: uuid,
		draft_cover_path: `${pathPrefix}draft_cover.jpg`,
		draft_config_path: `${pathPrefix}sub_draft_config.json`,
		draft_file_path: `${pathPrefix}draft_content.json`,
		draft: inline,
	};
	if (rich) {
		base.aimusic_mv_template_info = null;
		base.category_id = "";
		base.category_name = "";
		base.formula_id = "";
		base.name = name;
		base.precompile_combination = false;
	}
	return base;
}

/** wrapper（subdraft/<X>/draft_content.json）：完整草稿骨架 + 1 条 video 轨 1 个复合段 + 富键 drafts。
 *  ⚠ §3/§6：wrapper 只服务「双击进入编辑/封面」，渲染数据源是主草稿的内联——按落地清单允许
 *  以最简化骨架（我们 5.9 模板）构建，待真机再收。 */
function buildWrapper(
	sub: RtcSubDoc,
	uuid: string,
	inline: Json,
	subDurationUs: number,
	opts: JyCompoundBuildOpts,
): Json {
	const wrapper = contentTemplate();
	wrapper.id = uuid;
	wrapper.fps = opts.fps;
	wrapper.duration = subDurationUs;
	wrapper.canvas_config = { height: opts.canvasHeight, ratio: "original", width: opts.canvasWidth };
	wrapper.name = sub.name || "复合片段";
	const sep = opts.draftFolderPath ? (opts.draftFolderPath.includes("\\") ? "\\" : "/") : "/";
	const absPrefix = opts.draftFolderPath
		? `${opts.draftFolderPath}${sep}subdraft${sep}${uuid}${sep}`
		: `subdraft/${uuid}/`;
	const materials = wrapper.materials as Record<string, Json[]>;
	const virtualId = jyUuidUpper();
	materials.videos = [
		virtualVideoMaterialJson(virtualId, sub.name || "复合片段", subDurationUs, opts.canvasWidth, opts.canvasHeight),
	];
	const drafts = draftsMaterialJson(uuid, inline, sub.name || "复合片段", absPrefix, true);
	materials.drafts = [drafts];
	materials.placeholder_infos = [];
	const sink: JyCompanionSink = {
		speeds: materials.speeds,
		placeholder_infos: materials.placeholder_infos,
		hsl: materials.hsl,
		canvases: materials.canvases,
		sound_channel_mappings: materials.sound_channel_mappings,
		material_colors: materials.material_colors,
		vocal_separations: materials.vocal_separations,
	};
	const refs = pushCompanions(sink, 1);
	const hslId = jyUuidHex();
	materials.hsl.push({ id: hslId, type: "hsl" });
	// 8 组顺序：drafts → speeds → placeholder_infos → hsl → canvases → scm → material_colors → vocal_separations
	const extraRefs = [drafts.id as string, refs.ids[0], refs.ids[1], hslId, refs.ids[2], refs.ids[3], refs.ids[4], refs.ids[5]];
	const segJson = sampleSegmentJson(extraRefs, virtualId, 0, subDurationUs, 0, subDurationUs);
	wrapper.tracks = [
		{ attribute: 0, flag: 0, id: jyUuidHex(), is_default_name: true, name: "", segments: [segJson], type: "video" },
	];
	return wrapper;
}

/** sub_draft_config.json（§3 逐键） */
function buildSubDraftConfig(sub: RtcSubDoc, uuid: string, subDurationUs: number, nowMs: number): Json {
	return {
		audio_path: "",
		cover_height: 180,
		cover_path: "draft_cover.jpg",
		cover_width: 320,
		create_time: Math.floor(nowMs / 1000),
		draft_json_file: "draft_content.json",
		id: uuid,
		import_time_ms: nowMs,
		is_from_multi_timeline: false,
		is_from_sub_draft: true,
		material_color_tag: "",
		name: sub.name || "复合片段",
		project_id: uuid,
		rough_cut_duration: subDurationUs,
		rough_cut_start: 0,
		source: "timeline",
		type: "video",
	};
}

/* ────────────────────────── 对 buildDraftContent 的两个入口 ────────────────────────── */

/**
 * 构建一个子文档的共享部件（每个 subDoc 恰构建一次；分割出的多个复合段共享它——
 * 素材唯一性红线在导出侧的对应物：**绝不为每段重复内联/重复 subdraft**）。
 */
export function buildCompoundShared(sub: RtcSubDoc, opts: JyCompoundBuildOpts): JyCompoundShared {
	const uuid = jyUuidUpper();
	const { json: inline } = buildInlineDraft(sub, uuid, opts);
	// 时间窗口语义：复合段的 source 总长按子时间轴**结构时长**算（内联被跳过的占位不影响窗口）
	const subDurationUs = Math.max(Number((inline as { duration?: number }).duration) || 0, subDocDurationUs(sub));
	const virtualMaterial = virtualVideoMaterialJson(
		jyUuidUpper(),
		sub.name || "复合片段",
		subDurationUs,
		opts.canvasWidth,
		opts.canvasHeight,
	);
	const draftsMaterial = draftsMaterialJson(uuid, inline, sub.name || "复合片段", `subdraft/${uuid}/`, false);
	const wrapperJson = buildWrapper(sub, uuid, inline, subDurationUs, opts);
	const configJson = buildSubDraftConfig(sub, uuid, subDurationUs, opts.nowMs);
	return {
		subdraftUuid: uuid,
		virtualMaterial,
		draftsMaterial,
		subDurationUs,
		subdraft: { uuid, wrapperJson, configJson },
	};
}

/**
 * 构建主草稿里的一个复合段（12 键 + 8 组伴生引用；同 subDoc 的多个分割段各调一次，
 * 共享同一份 shared，各带各的 target/source 窗口与伴生条目）。
 */
export function buildCompoundSegmentJson(seg: RtcSegment, shared: JyCompoundShared, sink: JyCompanionSink): Json {
	const speed = seg.speed && seg.speed > 0 ? seg.speed : 1;
	const targetStart = Math.max(0, Math.round(seg.targetStartUs));
	const targetDuration = Math.max(0, Math.round(seg.targetDurationUs));
	const hasSource = seg.sourceDurationUs != null && seg.sourceDurationUs > 0;
	const sourceStart = hasSource ? Math.max(0, Math.round(seg.sourceStartUs as number)) : 0;
	const sourceDuration = hasSource ? Math.max(0, Math.round(seg.sourceDurationUs as number)) : shared.subDurationUs;
	const refs = pushCompanions(sink, speed);
	const hslId = jyUuidHex();
	sink.hsl.push({ id: hslId, type: "hsl" });
	const extraRefs = [
		shared.draftsMaterial.id as string,
		refs.ids[0], // speeds
		refs.ids[1], // placeholder_infos
		hslId,
		refs.ids[2], // canvases
		refs.ids[3], // sound_channel_mappings
		refs.ids[4], // material_colors
		refs.ids[5], // vocal_separations
	];
	return sampleSegmentJson(
		extraRefs,
		shared.virtualMaterial.id as string,
		targetStart,
		targetDuration,
		sourceStart,
		sourceDuration,
	);
}
