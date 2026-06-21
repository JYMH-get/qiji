import {
	Type,
	ScrollText,
	Image as ImageIcon,
	Clapperboard,
	AudioLines,
	Sparkles,
	FileUp,
	type LucideIcon,
} from "lucide-react";
import type { Capability, Purpose } from "@/contract";
import type { NodeRuntime } from "@/types";
import { buildManagedAdapter, registerAdapter, getAdapter } from "@/services/modelAdapter";
import { NODE_DEFAULT_PURPOSE } from "@/lib/purposeRegistry";

/**
 * 声明式节点插件注册表。
 *
 * 阶段1步骤B：插件不再执行任何远程/本地 JS（移除 new Function / createTask / queryTask /
 * import.meta.glob('*.js')）。内置节点改为声明式 JSON；自定义插件亦为 JSON。
 * 节点统一走 defaultNodeExecute → 已注册的 ManagedAdapter（经管理端网关）→ 集中轮询。
 */

export interface PortType {
	name: string;
	formats: string[];
}

export interface NodeAction {
	name: string;
	label: string;
	targetNodeType: string;
	handler: (
		nodeId: string,
		context: {
			store: ReturnType<typeof import("@/store/canvasStore").useCanvasStore.getState>;
			dispatch: (command: unknown) => void;
		}
	) => void;
}

export interface NodePlugin {
	type: string;
	label: string;
	code: string;
	icon: LucideIcon;
	accentVar: string;
	resultKind: string;
	defaultModel: string;
	description?: string;
	category?: string;
	thumbnail?: string | null;
	inputs: PortType[];
	outputs: PortType[];
	canStack?: boolean;
	actions?: NodeAction[];
	execute?: (nodeId: string) => Promise<void>;
	isActive?: boolean;
	isDeleted?: boolean;
}

const plugins = new Map<string, NodePlugin>();

/** 节点类型 → 能力（用于为内置节点合成网关适配器） */
const CAP_BY_TYPE: Record<string, Capability> = {
	text: "text",
	script: "text",
	image: "image",
	video: "video",
	audio: "audio",
};

/**
 * 默认节点执行：提交到已注册适配器拿到 taskId 后，交给集中式 taskTracker 轮询。
 * 不再在此处自建 setTimeout 轮询循环。
 */
export async function defaultNodeExecute(nodeId: string): Promise<void> {
	const { useCanvasStore } = await import("@/store/canvasStore");
	const node = useCanvasStore.getState().nodes[nodeId];
	if (!node) return;

	const plugin = getPlugin(node.type);
	if (!plugin) return;

	const params = node.data.params;
	const { resolveActiveModelKey } = await import("@/services/adapters/channelAdapter");
	const modelKey = resolveActiveModelKey(node.type, params.model, plugin.defaultModel);

	// 跨 await 后 store 快照会过期，运行态一律取最新 state 再写
	const setRuntime = (patch: Partial<NodeRuntime>) =>
		useCanvasStore.getState().setRuntime(nodeId, patch);

	// 模型预检：给出画布特有的精确提示（runPurpose 也会兜底返回 no_model）
	if (!getAdapter(modelKey)) {
		setRuntime({
			status: "failed",
			progress: 100,
			error: modelKey
				? `未找到模型适配器「${modelKey}」，请在「设置」中配置管理端并选择模型`
				: `节点未选择模型，请在节点面板中选择模型`,
		});
		return;
	}

	try {
		setRuntime({ status: "queued", progress: 0 });

		const { resolveMentions } = await import("@/lib/mentionResolver");
		const resolvedPrompt = resolveMentions(nodeId, String(params.prompt || ""));

		// 收口：画布节点与表格按键共用唯一提交路径 runPurpose（单例 taskCenter 集中轮询）
		const purpose =
			(params.purpose as Purpose) ||
			(NODE_DEFAULT_PURPOSE as Record<string, Purpose | undefined>)[node.type] ||
			"script.analyze";
		const { runPurpose } = await import("@/services/purposeRunner");
		const templateId =
			typeof params.templateId === "string" && params.templateId ? params.templateId : undefined;
		const run = await runPurpose(purpose, {
			prompt: resolvedPrompt,
			params,
			input: node.data.input || undefined,
			modelKey,
			templateId,
			onProgress: (progress, status) => {
				if (status === "queued" || status === "running") {
					setRuntime({ status, progress: progress || 10 });
				}
			},
		});

		if (run.status !== "success") {
			setRuntime({
				status: "failed",
				progress: 100,
				error: run.status === "no_model" ? "未配置可用模型" : run.error,
			});
			return;
		}

		// 成功：落资产库 + 回写节点 resultAssetId（原 nodeTaskTracker 成功分支搬运至此）
		const { useLibraryStore } = await import("@/store/libraryStore");
		const { useProjectStore } = await import("@/store/projectStore");
		const assetId = `asset-${run.taskId ?? nodeId}`;
		useLibraryStore.getState().addAsset({
			id: assetId,
			kind: plugin.resultKind as "image" | "video" | "audio" | "script",
			name: `${plugin.type}_output_${Date.now()}`,
			uri: run.resultUri,
			thumbnailUri: null,
			createdAt: new Date().toISOString(),
			deletedByUser: false,
			localPath: null,
		});

		const cs = useCanvasStore.getState();
		if (cs.nodes[nodeId]) {
			useCanvasStore.setState({
				nodes: {
					...cs.nodes,
					[nodeId]: {
						...cs.nodes[nodeId],
						data: { ...cs.nodes[nodeId].data, resultAssetId: assetId },
					},
				},
			});
		}
		setRuntime({ status: "success", progress: 100 });
		useProjectStore.getState().scheduleAutoSave("history");
	} catch (err) {
		console.error(`[Node ${nodeId}] execute failed:`, err);
		setRuntime({
			status: "failed",
			progress: 100,
			error: err instanceof Error ? err.message : "请求发送失败",
		});
	}
}

export function registerPlugin(plugin: NodePlugin) {
	if (!plugin.execute) {
		plugin.execute = defaultNodeExecute;
	}
	plugins.set(plugin.type, plugin);
}

export function getPlugin(type: string): NodePlugin | undefined {
	return plugins.get(type);
}

export function listPlugins(): NodePlugin[] {
	return Array.from(plugins.values());
}

export const iconMap: Record<string, LucideIcon> = {
	Type,
	ScrollText,
	ImageIcon,
	Clapperboard,
	AudioLines,
	Sparkles,
	FileUp,
};

/**
 * 注册一个声明式插件（来自内置 JSON / 自定义 .qiji-plugin.json / 管理端 catalog）。
 *
 * 纯数据驱动：节点 UI 来自 JSON 字段；若声明了 adapter.modes，则为该节点合成一个
 * 经管理端网关的 ManagedAdapter（携带这些 modes 作为面板参数表单），不执行任何脚本。
 */
export function registerSerializedPlugin(plugin: any) {
	const type: string = plugin.type || plugin.id;
	if (!type) return;

	const nodePlugin: NodePlugin = {
		type,
		label: plugin.label || plugin.name || type,
		code: plugin.code || type.toUpperCase(),
		icon: iconMap[plugin.iconName] || Sparkles,
		accentVar: plugin.accentVar || "var(--node-accent)",
		resultKind: plugin.resultKind || type,
		defaultModel: plugin.defaultModel || plugin.adapter?.key || "",
		description: plugin.description || "",
		category: plugin.category || "other",
		thumbnail: plugin.thumbnail || null,
		inputs: plugin.inputs || [],
		outputs: plugin.outputs || [],
		canStack: plugin.canStack,
		actions: [],
		execute: defaultNodeExecute,
		isActive: plugin.isActive !== false,
		isDeleted: !!plugin.isDeleted,
	};
	plugins.set(type, nodePlugin);

	// 声明式适配器：把 JSON 里的 modes（纯数据）挂到一个网关适配器上。
	const modes = plugin.adapter?.modes as unknown[] | undefined;
	const cap = CAP_BY_TYPE[type];
	if (modes && modes.length && cap) {
		const adapterKey: string = plugin.adapter?.key || type;
		const baseCost: number = plugin.adapter?.baseCost ?? 10;
		const adapter = buildManagedAdapter({
			id: adapterKey,
			label: plugin.adapter?.displayName || nodePlugin.label,
			capability: cap,
			params: [],
			cost: baseCost,
		});
		adapter.modes = modes as typeof adapter.modes;
		adapter.nodeTypes = [type as (typeof adapter.nodeTypes)[number]];
		adapter.vendor = plugin.adapter?.vendor || "管理端";
		adapter.estimateCost = (_modeKey, params) => baseCost * (Number(params?.quantity) || 1);
		registerAdapter(adapter);
	}
}

// ── 加载内置声明式节点（JSON）──
const builtinPluginModules = import.meta.glob("./plugins/*.json", { eager: true });
for (const path in builtinPluginModules) {
	const mod = builtinPluginModules[path] as any;
	const pluginData = mod.default || mod;
	registerSerializedPlugin(pluginData);
}
