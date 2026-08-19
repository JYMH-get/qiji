/**
 * 管理端目录（catalog）数据 —— 远程下发给用户端的模型/模板/出图模板/变体前缀/schema。
 *
 * 模型部分已数据化到 store/models.ts（管理端可增删改 + 编辑翻译格式）；
 * 模板/出图模板/变体前缀/schema 仍为静态（后续可同样数据化）。
 */
import type {
	Catalog,
	CatalogModel,
	CatalogTemplate,
	CatalogPreset,
	CatalogImageTemplate,
	CatalogVariantPrefix,
	AssetType,
	Capability,
} from "./contract.ts";
import { listEnabledModels, catalogVersion, modelAllowedForAgent } from "./store/models.ts";
import { listModes, modesVersion } from "./store/modes.ts";
import { listFamilies, familiesVersion } from "./store/families.ts";
import { listEnabledTemplatesForAgent, templatesVersion } from "./store/templates.ts";
import { listEnabledPresets, presetsVersion } from "./store/presets.ts";
import { chainPricingVersion, agentModelLabel } from "./store/agents.ts";

/** 模板由 store/templates.ts 数据化构建；按用户归属渠道商下发（平台模板 + 该渠道商自营模板） */
function buildTemplates(agentId?: string): CatalogTemplate[] {
	return listEnabledTemplatesForAgent(agentId)
		.slice()
		.sort((a, b) => a.order - b.order)
		.map((t) => ({
			id: t.id,
			name: t.name,
			capability: t.capability,
			purpose: t.purpose,
			category: t.category,
			variables: t.variables,
			presetGroup: t.presetGroup,
			presetPosition: t.presetPosition,
			schemaId: t.schemaId,
			nodeTypes: t.nodeTypes,
			isDefault: t.isDefault,
			images: t.images,
			// ⚠ 正文权威留管理端（第198轮）：可执行模板（带 purpose）正文与预览一律不下发——
			// 客户端只需 id/name 即可选用（提交带 templateId，服务端展开正文）；此前下发的前 200 字
			// bodyPreview 会经悬浮提示暴露提示词开头（用户判定为泄露），连同 viewangle.*/panorama.*
			// 的保密占位一并收编为统一规则。
			bodyPreview: t.purpose ? undefined : t.body.length > 200 ? t.body.slice(0, 200) + "…" : t.body,
			// 预设类模板（无 purpose，如画风）下发完整正文，供客户端直接取值
			body: t.purpose ? undefined : t.body,
		}));
}

/**
 * 兼容投影（第174轮，⚠ 客户端全量升级后可删）：预设拆为独立库后，**旧打包客户端**仍从
 * catalog.templates 的 分类=画风/预设方案 读取 画风选项与预设胶囊正文——不补这层，只部署服务端
 * 会让旧客户端 预设下拉变空、已插的【预设:id】胶囊提交时不展开（标记文本漏发上游）。
 * 故把预设以「模板形状」附加进 templates 下发（无 purpose=不进任何可执行选择器）；
 * 新客户端见 catalog.presets 非空即走新轨、天然忽略这份兼容层。
 */
function presetCompatTemplates(): CatalogTemplate[] {
	return listEnabledPresets()
		.slice()
		.sort((a, b) => (a.category || "").localeCompare(b.category || "") || a.order - b.order || a.id.localeCompare(b.id))
		.map((p) => ({
			id: p.id,
			name: p.name,
			capability: "image" as Capability,
			purpose: undefined,
			category: p.category || "预设方案",
			variables: [],
			presetGroup: p.group || undefined,
			presetPosition: p.position === "suffix" ? "suffix" : undefined,
			nodeTypes: [],
			isDefault: false,
			images: p.images?.length ? p.images : undefined,
			body: p.body,
		}));
}

/** 预设清单（第174轮独立实体）：全文下发（预设=正文片段，正文即价值），按 分类→order 排序 */
function buildPresets(): CatalogPreset[] {
	return listEnabledPresets()
		.slice()
		.sort((a, b) => (a.category || "").localeCompare(b.category || "") || a.order - b.order || a.id.localeCompare(b.id))
		.map((p) => ({
			id: p.id,
			name: p.name,
			category: p.category || undefined,
			body: p.body,
			position: p.position === "suffix" ? "suffix" : undefined,
			group: p.group || undefined,
			images: p.images?.length ? p.images : undefined,
			autoAttach: p.autoAttach?.length ? p.autoAttach : undefined,
		}));
}

function imageTemplate(assetType: AssetType, style: string): CatalogImageTemplate {
	return {
		id: `img.${assetType}.${style}`,
		assetType,
		style,
		prefix: `${style}，电影级布光，统一视觉风格`,
		slotOrder: ["身份", "年龄", "体型", "气质", "脸型五官", "眼神", "发型", "发色", "服装", "主色调", "辅色", "标志特征"],
		suffix: "不要多余文字水印，不要低分辨率，不要肢体畸变",
	};
}

const imageTemplates: CatalogImageTemplate[] = [
	imageTemplate("character", "3D国风动画"),
	imageTemplate("scene", "3D国风动画"),
	imageTemplate("creature", "3D国风动画"),
	imageTemplate("prop", "3D国风动画"),
];

const variantPrefixes: CatalogVariantPrefix[] = [
	{ assetType: "character", prefix: "保持人物 DNA 不变，仅按以下描述改变：{{变体描述}}。整体维持 {{视觉风格}}。" },
	{ assetType: "scene", prefix: "保持场景结构与风格不变，仅改变：{{变体描述}}。维持 {{视觉风格}}。" },
	{ assetType: "creature", prefix: "保持生物形态与材质 DNA 不变，仅改变：{{变体描述}}。维持 {{视觉风格}}。" },
	{ assetType: "prop", prefix: "保持道具核心特征不变，仅改变：{{变体描述}}。维持 {{视觉风格}}。" },
];

// ── 输出 schema（结构化输出强制 + 校验依据）──
const schemas: Record<string, unknown> = {
	// ① storyboard.split：单集剧本 → 大分镜卡（每卡 scriptContent + duration）
	"storyboard.v1": {
		type: "object",
		properties: {
			episodeIndex: { type: "number" },
			shots: {
				type: "array",
				items: {
					type: "object",
					properties: {
						index: { type: "number" },
						scriptContent: {
							type: "string",
							description: "本卡剧本内容，保留【对话】/【旁白】/【画外音】/【内心OS】标签与原换行；含足够动作神态支撑15秒内多镜头",
						},
						durationSec: { type: "number", description: "固定 15" },
					},
					required: ["index", "scriptContent", "durationSec"],
				},
			},
		},
		required: ["episodeIndex", "shots"],
	},
	// ② storyboard.toVideoPrompt：分镜 → 视频生成提示词（第26轮新增；visualDescription 保留代码公式）
	"videoPrompt.v1": {
		type: "object",
		properties: {
			shots: {
				type: "array",
				items: {
					type: "object",
					properties: {
						id: { type: "string", description: "如 card_01" },
						durationSec: { type: "number", description: "固定 15" },
						visualDescription: {
							type: "string",
							description:
								"完整视频提示词，必须保留代码公式：人物 {角色:名}、场景 {场景:名}、台词 {音频:角色名}的音色[情绪]:\"…\"、内心 {音频:OS-角色名}、旁白 {音频:VO-旁白}、音效 音效:\"…\"；含动态15秒时间轴(5-8镜头)",
						},
					},
					required: ["id", "durationSec", "visualDescription"],
				},
			},
		},
		required: ["shots"],
	},
	// ③ script.analyze：剧本 → 资产体系。整段模板版——每个资产带 imagePrompt(完整出图提示词，LLM 直接产)
	"asset.extract.v1": {
		type: "object",
		properties: {
			visualBible: { type: "object", description: "项目视觉圣经：style/styleAnchors[]/negativeBaseline[]" },
			characters: { type: "array", items: { type: "object" }, description: "{code,name,importance,voiceHint,firstAppearance,imagePrompt,variants[]}" },
			scenes: { type: "array", items: { type: "object" } },
			creatures: { type: "array", items: { type: "object" } },
			props: { type: "array", items: { type: "object" } },
			episodes: { type: "array", items: { type: "object" } },
			ledger: { type: "object", description: "状态账本：newVariants[]/deprecated[]/filteredTemp[]" },
		},
		required: ["visualBible", "characters", "scenes", "creatures", "props", "episodes", "ledger"],
	},
};

/** 由模型存储 + 静态模板/schema 构建客户端 catalog（每次读取实时反映管理端改动；模板按用户归属渠道商下发） */
export function buildCatalog(agentId?: string): Catalog {
	// P1 统一定价（2026-08 商业化改造，⚠ 勿回退）：价格恒为平台价，渠道商换价整体退役——
	// 全体用户 预估 = 实扣 = ModelDef 平台计费字段（与 planBilling resolveModelCost 无 override 一致）。
	// hidden=内部模型（如第三方手续费虚拟模型）：可被 /v1/generate 调用计费，但不下发给客户端下拉。
	// modelAllowedForAgent=开放范围（第110轮 shareScope）+ 渠道商禁用清单（第121轮 blockedModels）双闸：
	// 任一不过即不下发（调用也会被 403）；商禁用变更 bump pricingVersion → version 变 → 客户端热更。
	// 第165轮：模式/家族全局启停与排序——
	//   停用的模式：其下模型整体不下发（客户端隐藏；调用另有 routes 403 兜底）；
	//   停用的家族：仅剥模型的 familyId（客户端归「其他」分组——家族是纯展示维度，模型仍可用）；
	//   模型按「模式 order」稳定排序（同模式内保持原序）→ 客户端源折叠/家族内线路顺序跟随管理端拖动排序。
	const modeList = listModes();
	const modeIdx = new Map(modeList.map((m, i) => [m.id, i]));
	const disabledModes = new Set(modeList.filter((m) => m.enabled === false).map((m) => m.id));
	const disabledFams = new Set(listFamilies().filter((f) => f.enabled === false).map((f) => f.id));
	const modeRank = (modeId?: string): number =>
		modeId ? (modeIdx.get(modeId) ?? modeList.length) : modeList.length + 1; // 无模式（默认源）恒最后
	const models: CatalogModel[] = listEnabledModels()
		.filter((m) => !m.hidden && modelAllowedForAgent(m, agentId) && !(m.modeId && disabledModes.has(m.modeId)))
		// 排序键（第176轮）：模式 order → 模型 order（管理端同组内拖动）→ 原始加入序（稳定）
		.sort((a, b) => modeRank(a.modeId) - modeRank(b.modeId)
			|| (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))
		.map((m) => {
		return {
			id: m.id,
			// 第138轮：渠道商可改模型显示名——名下用户看本商改名；直属用户恒平台名
			label: agentModelLabel(agentId, m.id) ?? m.label,
			capability: m.capability,
			modeId: m.modeId, // 第130轮：客户端按 features.modes[modeId] 过滤/隐藏
			// 第163轮：模型家族（一级筛选「家族→渠道/线路→模型→要求」）；无=「其他」。
			// 第165轮：家族被全局停用时剥除（客户端 familyName 回查不到会裸显 id，剥掉才归「其他」）
			familyId: m.familyId && !disabledFams.has(m.familyId) ? m.familyId : undefined,
			methods: m.methods, // 第131轮：生成「方法」（omni 全能参考 / frames 首尾帧），客户端渲染方法级下拉
			officialAssets: m.officialAssets, // 第131轮：官方真人库（苏打水 gf 系）→ 客户端「真人图」多选
			refVideoSecondsWeight: m.refVideoSecondsWeight, // 第140轮：参考视频按秒计费系数（供客户端预估；实扣以服务端为准）
			matLimits: m.matLimits, // 第145轮：素材数量上限（管理端可调；服务端硬闸为准，客户端提交前同尺预检）
			note: m.note, // 第166轮：模型备注（管理端可编辑，用户可见）——客户端悬浮积分图标显示；未设=客户端按 matLimits 派生默认文案
			params: m.params,
			cost: m.cost,
			costField: m.costField,
			costPerUnit: m.costPerUnit,
			// 仅投影计费相关字段（不含上游真实模型名），供客户端按档精确预估（平台价，P1 统一定价）
			costRules: (m.routes ?? []).map((r) => ({ when: r.when, cost: r.cost, costPerUnit: r.costPerUnit })),
		};
	});
	// 第121轮：第三方手续费实价下发——hidden 的 fee-thirdparty 不进 models 下拉，但客户端
	// 预检/预估需要实付价（P1 起=平台价）。
	const feeModel = listEnabledModels().find((m) => m.id === "fee-thirdparty");
	const fees = feeModel ? { thirdParty: feeModel.cost } : undefined;
	// 目录版本 .p 段（沿用旧名 pricingVersion）：该商 改模型显示名/启停模型/换分组 bump →
	// 该用户 catalog version 变化 → 客户端热更（下拉/名称跟随）。
	const pv = chainPricingVersion(agentId);
	return {
		// 版本并入模板版本：模型或模板任一改动都触发用户端热更新；
		// 渠道商用户再并入其归属链定价版本（改价 → 名下用户 catalog 版本变化 → 客户端热更预估价）；
		// 第131轮再并入模式注册表版本（管理端改模式名/增删模式 → 客户端下拉分组名热更）；
		// 第163轮再并入家族注册表版本（改家族名/增删家族/模型改家族经 models version 或 .f 段热更）；
		// 第174轮再并入预设库版本（预设拆为独立存储后改预设不再 bump 模板版本，须自带热更段）
		version: `${catalogVersion()}.t${templatesVersion()}${pv ? `.p${pv}` : ""}.m${modesVersion()}.f${familiesVersion()}.ps${presetsVersion()}`,
		// 第165轮：全局停用的模式/家族不下发（客户端隐藏）；两表本就按 order 排序=管理端拖动排序直达客户端
		modes: modeList.filter((m) => m.enabled !== false).map((m) => ({ id: m.id, name: m.name })),
		families: listFamilies().filter((f) => f.enabled !== false).map((f) => ({ id: f.id, name: f.name, capability: f.capability })),
		models,
		// 模板 + 预设兼容投影（旧客户端从模板分类读预设；新客户端走下方 presets 字段）
		templates: [...buildTemplates(agentId), ...presetCompatTemplates()],
		presets: buildPresets(),
		nodes: [],
		imageTemplates,
		variantPrefixes,
		schemas,
		fees,
	};
}

export function getSchema(id: string): unknown {
	return schemas[id];
}

/** 取某资产类型的变体前缀（图生图"保 DNA 不变"前缀） */
export function getVariantPrefix(assetType: AssetType): CatalogVariantPrefix | undefined {
	return variantPrefixes.find((v) => v.assetType === assetType);
}
