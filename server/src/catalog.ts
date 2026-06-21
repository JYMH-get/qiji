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
	CatalogImageTemplate,
	CatalogVariantPrefix,
	AssetType,
} from "./contract.ts";
import { listEnabledModels, catalogVersion } from "./store/models.ts";
import { listEnabledTemplates, templatesVersion } from "./store/templates.ts";

/** 模板由 store/templates.ts 数据化构建（管理端可增删改 + 编辑正文 + 绑定节点） */
function buildTemplates(): CatalogTemplate[] {
	return listEnabledTemplates()
		.slice()
		.sort((a, b) => a.order - b.order)
		.map((t) => ({
			id: t.id,
			name: t.name,
			capability: t.capability,
			purpose: t.purpose,
			category: t.category,
			variables: t.variables,
			schemaId: t.schemaId,
			nodeTypes: t.nodeTypes,
			isDefault: t.isDefault,
			images: t.images,
			// 正文权威留管理端，仅下发预览（截断）
			bodyPreview: t.body.length > 200 ? t.body.slice(0, 200) + "…" : t.body,
			// 预设类模板（无 purpose，如画风）下发完整正文，供客户端直接取值
			body: t.purpose ? undefined : t.body,
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
						plot: { type: "string" },
						dialogue: { type: "string", description: "≤30字，无则填'无'，不增不删" },
						dynamicVideoPrompt: { type: "string" },
						refCharacters: { type: "array", items: { type: "string" } },
						refScenes: { type: "array", items: { type: "string" } },
						refProps: { type: "array", items: { type: "string" } },
						durationSec: { type: "number", description: "≤15" },
					},
					required: ["index", "plot", "dialogue", "dynamicVideoPrompt", "durationSec"],
				},
			},
		},
		required: ["episodeIndex", "shots"],
	},
	"asset.extract.v1": {
		type: "object",
		properties: {
			visualBible: { type: "object" },
			characters: { type: "array", items: { type: "object" } },
			scenes: { type: "array", items: { type: "object" } },
			creatures: { type: "array", items: { type: "object" } },
			props: { type: "array", items: { type: "object" } },
			episodes: { type: "array", items: { type: "object" } },
			ledger: { type: "object" },
		},
		required: ["visualBible", "characters", "scenes", "creatures", "props", "episodes", "ledger"],
	},
};

/** 由模型存储 + 静态模板/schema 构建客户端 catalog（每次读取实时反映管理端改动） */
export function buildCatalog(): Catalog {
	const models: CatalogModel[] = listEnabledModels().map((m) => ({
		id: m.id,
		label: m.label,
		capability: m.capability,
		params: m.params,
		cost: m.cost,
	}));
	return {
		// 版本并入模板版本：模型或模板任一改动都触发用户端热更新
		version: `${catalogVersion()}.t${templatesVersion()}`,
		models,
		templates: buildTemplates(),
		nodes: [],
		imageTemplates,
		variantPrefixes,
		schemas,
	};
}

export function getSchema(id: string): unknown {
	return schemas[id];
}

/** 取某资产类型的变体前缀（图生图"保 DNA 不变"前缀） */
export function getVariantPrefix(assetType: AssetType): CatalogVariantPrefix | undefined {
	return variantPrefixes.find((v) => v.assetType === assetType);
}
