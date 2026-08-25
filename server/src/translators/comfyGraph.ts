/**
 * 奇迹云 H3 工作流图构建器（纯函数零 IO，可单测）。
 *
 * 把用户请求（提示词/时长/比例/分辨率/素材文件名）动态组装成 ComfyUI /prompt 所需的完整节点图。
 * 骨架来自用户在自家实例上调好的工作流（jianyi933，原件存档 资料/奇迹云H3工作流-jianyi933.json）：
 *   MinimaxH3_HybridLoader(fl2va+ref2va) → LoRA 8step turbo → SageAttention →
 *   MiniMaxH3ReferenceToVideo(136) → SamplerCustomAdvanced → VAE 解码（视频+音频）→ VHS_VideoCombine(149)。
 *
 * ⚠ 模型更新情报源：无外部上游——工作流骨架就在本文件（内嵌常量）。用户重导出工作流时，
 *   删掉样例素材节点、剥掉 136 节点的 ref_* 键后替换 H3_SKELETON（节点 id 会漂，见下）。
 *
 * ⚠ 节点定位一律按 class_type（不靠死 id）：用户在 ComfyUI 里重导出工作流时节点 id 会漂，
 *   class_type 才是稳定标识。任一定位失败 → throw 明确文案（骨架被换掉时第一时间暴露）。
 *
 * 素材节点按需动态生成（用户明令：零素材类别不产生任何节点与键，防实例资源浪费）——
 * 图 N 张建 N 个 LoadImage 接 ref_images.ref_image_0..N-1，视频/音频同理。
 */

/** 骨架常量：jianyi933 原件去掉样例素材节点（189/195/224/230）、136 节点剥掉 ref_* 键后的形态。
 *  其余节点原样保留（含 149 输出参数、131 帧数表达式、multiple:32 等用户调好的值，勿"顺手优化"）。 */
const H3_SKELETON: Record<string, any> = {
	"115": {
		inputs: { aspect_ratio: "16:9 (Widescreen)", megapixels: 0.4, multiple: 32 },
		class_type: "ResolutionSelector",
		_meta: { title: "设置输出视频的分辨率" },
	},
	"119": {
		inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" },
		class_type: "VAELoader",
		_meta: { title: "加载VAE" },
	},
	"120": {
		inputs: { vae_name: "minimax_h3_audio_vae_fp32.safetensors" },
		class_type: "VAELoader",
		_meta: { title: "加载VAE" },
	},
	"121": {
		inputs: { samples: ["125", 0], vae: ["120", 0] },
		class_type: "VAEDecodeAudio",
		_meta: { title: "VAE解码（音频）" },
	},
	"122": {
		inputs: { samples: ["125", 0], vae: ["119", 0] },
		class_type: "VAEDecode",
		_meta: { title: "VAE解码" },
	},
	"123": {
		inputs: { sampler_name: "euler" },
		class_type: "KSamplerSelect",
		_meta: { title: "K采样器选择" },
	},
	"124": {
		inputs: { scheduler: "simple", steps: 8, denoise: 1, model: ["141", 0] },
		class_type: "BasicScheduler",
		_meta: { title: "基本调度器" },
	},
	"125": {
		inputs: {
			noise: ["129", 0],
			guider: ["126", 0],
			sampler: ["123", 0],
			sigmas: ["124", 0],
			latent_image: ["136", 1],
		},
		class_type: "SamplerCustomAdvanced",
		_meta: { title: "自定义采样器（高级）" },
	},
	"126": {
		inputs: { model: ["141", 0], conditioning: ["136", 0] },
		class_type: "BasicGuider",
		_meta: { title: "基本引导器" },
	},
	"128": {
		inputs: { clip_name: "qwen3vl_32b_minimax_h3_int8_convrot.safetensors", type: "minimax", device: "default" },
		class_type: "CLIPLoader",
		_meta: { title: "加载CLIP" },
	},
	"129": {
		inputs: { noise_seed: 42 },
		class_type: "RandomNoise",
		_meta: { title: "随机噪波" },
	},
	"131": {
		// 帧数表达式：时长(秒)×24fps，最少 5 帧且对齐 (n-5)%17==0（H3 latent 帧组约束，用户实机调好的公式勿动）
		inputs: { expression: "max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17", "values.a": ["132", 0] },
		class_type: "ComfyMathExpression",
		_meta: { title: "数学表达式" },
	},
	"132": {
		inputs: { value: 15 },
		class_type: "PrimitiveFloat",
		_meta: { title: "视频时长" },
	},
	"136": {
		// ref_images.*/ref_videos.*/ref_audios.* 键已剥掉——由 buildH3Graph 按素材数量动态补
		inputs: {
			prompt: ["138", 0],
			width: ["115", 0],
			height: ["115", 1],
			length: ["131", 1],
			ref_image_size: "max",
			clip: ["128", 0],
			vae: ["119", 0],
			audio_vae: ["120", 0],
		},
		class_type: "MiniMaxH3ReferenceToVideo",
		_meta: { title: "MiniMax H3 Reference to Video" },
	},
	"138": {
		inputs: { value: "" },
		class_type: "PrimitiveStringMultiline",
		_meta: { title: "Input Text (Prompt)" },
	},
	"141": {
		inputs: { sage_attention: "sageattn3", allow_compile: false, model: ["153", 0] },
		class_type: "PathchSageAttentionKJ",
		_meta: { title: "Patch Sage Attention KJ" },
	},
	"149": {
		inputs: {
			frame_rate: 24,
			loop_count: 0,
			filename_prefix: "minimax_h3",
			format: "video/h264-mp4",
			pix_fmt: "yuv420p",
			crf: 19,
			save_metadata: true,
			trim_to_audio: false,
			pingpong: false,
			save_output: true,
			images: ["122", 0],
			audio: ["121", 0],
		},
		class_type: "VHS_VideoCombine",
		_meta: { title: "Video Combine 🎥🅥🅗🅢" },
	},
	"153": {
		inputs: { lora_name: "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors", strength_model: 1, model: ["156", 0] },
		class_type: "LoraLoaderModelOnly",
		_meta: { title: "LoRA加载器（仅模型）" },
	},
	"156": {
		inputs: { base_model: "minimax_h3_fl2va_bf16.safetensors", overlay_model: "minimax_h3_ref2va_bf16.safetensors" },
		class_type: "MinimaxH3_HybridLoader",
		_meta: { title: "Minimax H3混合加载器" },
	},
};

// ── 素材 loader 模板（形状来自骨架原件的样例素材节点 189/195/224/230，字段值即用户调好的值）──
const LOAD_IMAGE = (file: string) => ({
	inputs: { image: file },
	class_type: "LoadImage",
	_meta: { title: "加载图像" },
});
const LOAD_VIDEO = (file: string) => ({
	inputs: {
		video: file,
		force_rate: 8,
		custom_width: 0,
		custom_height: 0,
		frame_load_cap: 240,
		skip_first_frames: 0,
		select_every_nth: 1,
		format: "AnimateDiff",
	},
	class_type: "VHS_LoadVideo",
	_meta: { title: "Load Video (Upload) 🎥🅥🅗🅢" },
});
const LOAD_AUDIO = (file: string, durationSec: number) => ({
	inputs: { audio: file, start_time: 0, end_time: durationSec, duration: durationSec, audio_ui: "" },
	class_type: "LoadAudioUI",
	_meta: { title: "加载音频" },
});

/** 比例 → ResolutionSelector 下拉枚举串。⚠ 枚举串逐字来自 ComfyUI 下拉（截图实锤），错一个字符节点拒收 */
const ASPECT_MAP: Record<string, string> = {
	"16:9": "16:9 (Widescreen)",
	"9:16": "9:16 (Portrait Widescreen)",
	"1:1": "1:1 (Square)",
	"4:3": "4:3 (Standard)",
	"3:4": "3:4 (Portrait Standard)",
	"2:3": "2:3 (Portrait Photo)",
	"3:2": "3:2 (Photo)",
	"21:9": "21:9 (Ultrawide)",
};

/** 分辨率档 → megapixels（ResolutionSelector 按百万像素×multiple:32 对齐换算出宽高） */
const RESOLUTION_MAP: Record<string, number> = {
	"480p": 0.4,
	"640p": 0.7,
	"768p": 1,
	"1080p": 2,
};

export interface H3GraphOpts {
	/** 工作流骨架名（=模型 upstreamModel）；目前仅 "jianyi933"，多工作流预留 */
	workflow: string;
	prompt: string;
	durationSec?: number | string;
	aspect?: string;
	resolution?: string;
	seed: number;
	images: { file: string }[];
	videos: { file: string }[];
	audios: { file: string; durationSec: number }[];
}

/** 按 class_type 找唯一节点；找不到=骨架被换坏，throw 明确文案 */
function nodeOfClass(graph: Record<string, any>, classType: string): any {
	for (const node of Object.values(graph)) {
		if ((node as any)?.class_type === classType) return node;
	}
	throw new Error(`工作流骨架缺少 ${classType} 节点——骨架被更换后未同步 comfyGraph.ts，请联系管理员`);
}

/** 时长节点：PrimitiveFloat 且标题「视频时长」；兜底=被 ComfyMathExpression 的 values.a 引用的 PrimitiveFloat
 *（用户重导出工作流时中文标题可能被改，连线关系比标题稳） */
function durationNode(graph: Record<string, any>): any {
	for (const node of Object.values(graph)) {
		const n = node as any;
		if (n?.class_type === "PrimitiveFloat" && n?._meta?.title === "视频时长") return n;
	}
	for (const node of Object.values(graph)) {
		const n = node as any;
		if (n?.class_type !== "ComfyMathExpression") continue;
		const ref = n?.inputs?.["values.a"];
		if (Array.isArray(ref) && typeof ref[0] === "string") {
			const target = graph[ref[0]];
			if (target?.class_type === "PrimitiveFloat") return target;
		}
	}
	throw new Error("工作流骨架缺少「视频时长」节点（PrimitiveFloat）——骨架被更换后未同步 comfyGraph.ts，请联系管理员");
}

/**
 * 组装 H3 完整节点图（POST /prompt 的 prompt 字段）。
 * durationSec/aspect/resolution：显式给了才写（缺省=骨架默认值兜底）；
 * ⚠ 非法值一律 throw 明确报错——本函数就是「上游」（§9 语义：静默改写/静默丢弃永远禁止）。
 */
export function buildH3Graph(opts: H3GraphOpts): Record<string, any> {
	if (opts.workflow !== "jianyi933") {
		throw new Error(`未知工作流骨架「${opts.workflow}」：请在管理端把该模型的「上游模型名」改回 jianyi933（或联系管理员接入新骨架）`);
	}
	// 上限兜底断言（上层 matLimits 已闸，这里防直接调用方越限）
	if (opts.images.length > 9) throw new Error(`图片素材最多 9 张（当前 ${opts.images.length} 张）`);
	if (opts.videos.length > 3) throw new Error(`视频素材最多 3 条（当前 ${opts.videos.length} 条）`);
	if (opts.audios.length > 3) throw new Error(`音频素材最多 3 条（当前 ${opts.audios.length} 条）`);

	const graph: Record<string, any> = structuredClone(H3_SKELETON);

	// ── 核心节点定位（按 class_type）──
	const resNode = nodeOfClass(graph, "ResolutionSelector");
	const durNode = durationNode(graph);
	const promptNode = nodeOfClass(graph, "PrimitiveStringMultiline");
	const noiseNode = nodeOfClass(graph, "RandomNoise");
	const refNode = nodeOfClass(graph, "MiniMaxH3ReferenceToVideo");

	promptNode.inputs.value = opts.prompt;
	noiseNode.inputs.noise_seed = opts.seed;

	if (opts.durationSec !== undefined) {
		const n = Number(opts.durationSec);
		if (!Number.isFinite(n) || n <= 0) throw new Error(`时长参数无效：「${opts.durationSec}」（需为正数秒数）`);
		durNode.inputs.value = n;
	}
	if (opts.aspect !== undefined && opts.aspect !== "") {
		const mapped = ASPECT_MAP[opts.aspect];
		if (!mapped) throw new Error(`比例参数无效：「${opts.aspect}」（支持 ${Object.keys(ASPECT_MAP).join("/")}）`);
		resNode.inputs.aspect_ratio = mapped;
	}
	if (opts.resolution !== undefined && opts.resolution !== "") {
		const mp = RESOLUTION_MAP[opts.resolution];
		if (mp === undefined) throw new Error(`分辨率参数无效：「${opts.resolution}」（支持 ${Object.keys(RESOLUTION_MAP).join("/")}）`);
		resNode.inputs.megapixels = mp;
	}

	// ── 素材节点动态生成（零素材类别不产生任何节点与键）──
	let nextId = 9001;
	const addNode = (node: any): string => {
		while (String(nextId) in graph) nextId += 1; // 与骨架现有 id 无碰撞（骨架 id 均 <300，此为防御）
		const id = String(nextId);
		graph[id] = node;
		nextId += 1;
		return id;
	};
	opts.images.forEach((m, i) => {
		refNode.inputs[`ref_images.ref_image_${i}`] = [addNode(LOAD_IMAGE(m.file)), 0];
	});
	opts.videos.forEach((m, i) => {
		refNode.inputs[`ref_videos.ref_video_${i}`] = [addNode(LOAD_VIDEO(m.file)), 0];
	});
	opts.audios.forEach((m, i) => {
		refNode.inputs[`ref_audios.ref_audio_${i}`] = [addNode(LOAD_AUDIO(m.file, m.durationSec)), 0];
	});

	return graph;
}

/**
 * @tag 图例 → H3 官方引用标签：@ImageN→<Picture N> / @VideoN→<Video N> / @AudioN→<Audio N>。
 * injectReferenceTags 注入的编号与 ref_image_N（0 基）天然对齐（@Image1 = ref_image_0 = <Picture 1>）。
 */
export function toOfficialTags(prompt: string): string {
	return prompt
		.replace(/@Image(\d+)/g, "<Picture $1>")
		.replace(/@Video(\d+)/g, "<Video $1>")
		.replace(/@Audio(\d+)/g, "<Audio $1>");
}
