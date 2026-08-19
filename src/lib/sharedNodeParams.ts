/**
 * sharedNodeParams —— 画布同类型节点共享生成设置（输出一致性）。
 *
 * 规则：同一画布内，同类型节点的**生成设置**保持一致——在任一节点修改共享键
 * （如图片节点把比例改成 9:16），同画布其余同类型节点立即跟随；新建/裂变/拖入的
 * 同类型节点也继承当前画布同类节点的既有设置（而非 spec 默认值）。
 *
 * 只联动「设置」，不联动「内容/语义」：prompt/assetName/purpose/idPrefix 等字段一律各自独立。
 * 例外：智能推理节点的 templateId 视为「设置」参与联动（用户定：一个节点选了某提示词，
 * 其余智能推理节点跟随切换）——purpose 不随之扇出，执行时由模板决定用途（pluginRegistry 自愈）。
 * 处理类节点（超分/去字幕/片段 resultOnly）既不作为联动源、也不被联动——它们与
 * 生成节点同为 image.gen/video.gen 类型，但 params 是处理配置，同键不同义。
 */

import { useCanvasStore } from "@/store/canvasStore";
import { useCatalogStore } from "@/store/catalogStore";
import { smartInferContext } from "@/lib/inferUpstream";
import { adaptParamsToSchema, schemaForNodeModel } from "@/lib/modelParamAdapt";

/** 同类型节点共享的设置键（不在表内的节点类型不联动）。
 *  ⚠ 视频 duration 不共享：智能推理每卡带指定时长（per-镜语义，如 2.2s/8s 各不同），
 *  联动会把整排按卡设好的时长抹平——时长属「内容」不属「设置」。 */
export const SHARED_PARAM_KEYS: Record<string, readonly string[]> = {
	"image.gen": ["model", "mode", "quality", "aspect", "resolution"],
	"video.gen": ["model", "mode", "resolution", "aspect_ratio"],
	"smart.infer": ["model", "mode", "templateId"],
	"asset.split": ["model", "mode"],
};

/**
 * 处理类/只读结果节点判定（与 ProcessInfoPanel 的锁定面板同一把尺）：
 * 超分/去字幕/图像超分节点，或「分段」等只承载结果的节点。
 */
export function isProcessNodeParams(params: Record<string, unknown> | undefined): boolean {
	const p = params?.purpose;
	return (
		p === "video.upscale" ||
		p === "video.desub" ||
		p === "image.upscale" ||
		params?.resultOnly === true
	);
}

/**
 * 把某节点参数变更里的共享键扇出到**同画布其余同类型节点**。
 * 在 updateNodeParams 命令处理器里调用（源节点自身已由 store.updateNodeParams 更新）。
 * 非结构变更（与参数编辑本身同语义，不进撤销栈）；批量单次 setState（§9 性能规则）。
 */
export function fanOutSharedParams(sourceId: string, patch: Record<string, unknown>): void {
	const s = useCanvasStore.getState();
	const src = s.nodes[sourceId];
	if (!src) return;
	const keys = SHARED_PARAM_KEYS[src.type];
	if (!keys) return;
	// 处理节点的参数是处理配置（倍率/擦除范围等），不向生成节点扇出
	if (isProcessNodeParams(src.data.params)) return;
	const shared: Record<string, unknown> = {};
	for (const k of keys) {
		if (k in patch) shared[k] = patch[k];
	}
	if (!Object.keys(shared).length) return;
	// 智能推理模板联动门禁（第108轮，单卡/多卡分用途）：templateId 只扇出到**允许该模板用途**的节点
	//（上游智能推理→仅单卡节点、上游剧集分集→仅多卡节点，见 inferUpstream）——多卡模板不会串到单卡原文节点。
	// 模板不在 catalog（测试桩/热更空窗）→ 维持旧行为原样扇出。
	const sharedTplPurpose =
		src.type === "smart.infer" && typeof shared.templateId === "string"
			? useCatalogStore.getState().catalog?.templates.find((t) => t.id === shared.templateId)?.purpose
			: undefined;
	let changed = false;
	const nodes = { ...s.nodes };
	for (const [id, n] of Object.entries(s.nodes)) {
		if (id === sourceId || n.type !== src.type) continue;
		if (isProcessNodeParams(n.data.params)) continue;
		let forNode = shared;
		if (sharedTplPurpose && !smartInferContext(id, s.nodes, s.edges).purposes.includes(sharedTplPurpose)) {
			const { templateId: _omit, ...rest } = shared;
			if (!Object.keys(rest).length) continue; // 只有 templateId 且不允许 → 该节点跳过
			forNode = rest;
		}
		// 换模型时，被联动节点的**非共享**参数（如视频 duration）同样收敛到新模型档位——
		// 否则它们会显示新模型不支持的旧档位（提交层虽再收敛一次，显示与实发不一致）。
		const merged = { ...n.data.params, ...forNode };
		const adapted = typeof shared.model === "string"
			? adaptParamsToSchema(schemaForNodeModel(n.type, shared.model), merged)
			: {};
		nodes[id] = { ...n, data: { ...n.data, params: { ...merged, ...adapted } } };
		changed = true;
	}
	if (changed) useCanvasStore.setState({ nodes });
}

/**
 * 新建节点继承：取当前画布**最后一个**同类型（非处理）节点的共享设置，
 * 覆盖在 spec 默认值之上——保证新落子的节点与画布上既有同类节点设置一致。
 * 画布上没有同类节点时返回空（用 spec 默认值）。
 */
export function inheritSharedParams(type: string): Record<string, unknown> {
	const keys = SHARED_PARAM_KEYS[type];
	if (!keys) return {};
	const s = useCanvasStore.getState();
	let donor: (typeof s.nodes)[string] | null = null;
	for (const n of Object.values(s.nodes)) {
		if (n.type === type && !isProcessNodeParams(n.data.params)) donor = n;
	}
	if (!donor) return {};
	const out: Record<string, unknown> = {};
	for (const k of keys) {
		const v = donor.data.params[k];
		if (v !== undefined) out[k] = v;
	}
	return out;
}
