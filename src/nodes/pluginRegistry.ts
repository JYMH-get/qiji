import {
	Type,
	ScrollText,
	Image as ImageIcon,
	Clapperboard,
	AudioLines,
	type LucideIcon,
} from "lucide-react";
import type { Asset } from "@/store/libraryStore";

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

export async function defaultNodeExecute(nodeId: string): Promise<void> {
	const { useCanvasStore } = await import("@/store/canvasStore");
	const { useLibraryStore } = await import("@/store/libraryStore");
	const { useProjectStore } = await import("@/store/projectStore");

	const store = useCanvasStore.getState();
	const node = store.nodes[nodeId];
	if (!node) return;

	const type = node.type;
	const plugin = getPlugin(type);
	if (!plugin) return;

	const params = node.data.params;
	const { resolveActiveModelKey } = await import("@/services/adapters/channelAdapter");
	const modelKey = resolveActiveModelKey(node.type, params.model, plugin.defaultModel);

	// 查找 adapter — 找不到直接报错，不回退 mock
	const { getAdapter } = await import("@/services/modelAdapter");
	const adapter = getAdapter(modelKey);
	if (!adapter) {
		const errorMsg = modelKey
			? `未找到模型适配器「${modelKey}」，请在「设置→模型」中选择已启用的模型`
			: `节点未选择模型，请在节点面板中选择模型`;
		store.setRuntime(nodeId, { status: "failed", progress: 100, error: errorMsg });
		return;
	}

	try {
		store.setRuntime(nodeId, { status: "queued", progress: 0 });

		const { resolveMentions } = await import("@/lib/mentionResolver");
		const resolvedPrompt = resolveMentions(nodeId, String(params.prompt || ""));
		const inputData = { prompt: resolvedPrompt, ...node.data.input || {} };

		const { taskId } = await adapter.submit(inputData, params, type);
		// 黑匣子：attach 到实际 taskId
		const traceId = nodeId;
		console.log(`[Blackbox] ${traceId} → adapter=${adapter.key} model=${modelKey} taskId=${taskId}`);

		store.setRuntime(nodeId, { status: "running", progress: 10 });

		let pollCount = 0;
		const maxPolls = 120;
		const runPolling = () => {
			setTimeout(async () => {
				try {
					const pollResult = await adapter.poll(taskId);
					pollCount++;
					console.log(`[Blackbox] ${traceId} poll#${pollCount} status=${pollResult.status} progress=${pollResult.progress}`);

					if (pollResult.status === "success") {
						const resultUri = pollResult.resultUri || "";
						const aid = `asset-${taskId}`;
						const filename = `${plugin.type}_output_${Date.now()}`;
						useLibraryStore.getState().addAsset({
							id: aid,
							kind: plugin.resultKind as Asset["kind"],
							name: filename,
							uri: resultUri,
							thumbnailUri: null,
							createdAt: new Date().toISOString(),
							deletedByUser: false,
							localPath: null,
						});
						const updatedNodes = { ...store.nodes };
						if (updatedNodes[nodeId]) {
							updatedNodes[nodeId] = { ...updatedNodes[nodeId], data: { ...updatedNodes[nodeId].data, resultAssetId: aid } };
							useCanvasStore.setState({ nodes: updatedNodes });
						}
						store.setRuntime(nodeId, { status: "success", progress: 100 });
						useProjectStore.getState().scheduleAutoSave("history");
					} else if (pollResult.status === "failed") {
						store.setRuntime(nodeId, { status: "failed", progress: 100, error: pollResult.error || "生成失败" });
					} else {
						store.setRuntime(nodeId, { status: pollResult.status, progress: pollResult.progress || Math.min(pollCount * 10, 95) });
						if (pollCount < maxPolls) runPolling();
						else store.setRuntime(nodeId, { status: "failed", progress: 100, error: "生成超时，已取消" });
					}
				} catch (err) {
					console.error("[Blackbox] Polling error:", err);
					store.setRuntime(nodeId, { status: "failed", progress: 100, error: err instanceof Error ? err.message : "轮询异常" });
				}
			}, 1000);
		};
		runPolling();
	} catch (err) {
		console.error(`[Blackbox] Node ${nodeId} submit failed:`, err);
		const msg = err instanceof Error ? err.message : "请求发送失败";
		store.setRuntime(nodeId, { status: "failed", progress: 100, error: msg });
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

// ── 本地加载核心集成 ──
import { Sparkles, FileUp } from "lucide-react";

export const iconMap: Record<string, LucideIcon> = {
	Type,
	ScrollText,
	ImageIcon,
	Clapperboard,
	AudioLines,
	Sparkles,
	FileUp,
};

export function registerSerializedPlugin(plugin: any) {
	const nodePlugin: NodePlugin = {
		type: plugin.type || plugin.id,
		label: plugin.label || plugin.name,
		code: plugin.code || (plugin.id || plugin.type || "").toUpperCase(),
		icon: iconMap[plugin.iconName] || Sparkles,
		accentVar: plugin.accentVar || "var(--node-accent)",
		resultKind: plugin.resultKind || plugin.type || "text",
		defaultModel: plugin.defaultModel || (plugin.models && plugin.models[0]?.id) || "",
		description: plugin.description || "",
		category: plugin.category || "other",
		thumbnail: plugin.thumbnail || null,
		inputs: plugin.inputs || [],
		outputs: plugin.outputs || [],
		canStack: plugin.canStack,
		actions: [],
		isActive: plugin.isActive !== false,
		isDeleted: !!plugin.isDeleted,
	};

	// Compile cost estimation function if provided
	let estimateCostFn = (modeKey: string, params: Record<string, unknown>) => {
		if (plugin.estimateCost) {
			try {
				return plugin.estimateCost(modeKey, params);
			} catch (e) {
				console.error("Error evaluating estimateCost function:", e);
			}
		}
		return plugin.adapter?.baseCost || 10;
	};
	if (plugin.scripts?.estimateCost) {
		try {
			const compiledCost = new Function("modeKey", "params", "baseCost", plugin.scripts.estimateCost);
			estimateCostFn = (modeKey, params) => {
				try {
					return compiledCost(modeKey, params, plugin.adapter?.baseCost || 10);
				} catch (e) {
					console.error("Error evaluating estimateCost script:", e);
					return plugin.adapter?.baseCost || 10;
				}
			};
		} catch (err) {
			console.error(`Failed to compile estimateCost for ${plugin.type || plugin.id}:`, err);
		}
	}

	// Compile transformInput function if provided
	let transformInputFn = (params: Record<string, unknown>, _nodeId: string) => {
		return { prompt: params.prompt || "", ...params };
	};
	if (plugin.scripts?.transformInput) {
		try {
			const compiledTransform = new Function("params", "nodeId", plugin.scripts.transformInput);
			transformInputFn = (params, nodeId) => {
				try {
					return compiledTransform(params, nodeId);
				} catch (e) {
					console.error("Error evaluating transformInput script:", e);
					return { prompt: params.prompt || "", ...params };
				}
			};
		} catch (err) {
			console.error(`Failed to compile transformInput for ${plugin.type || plugin.id}:`, err);
		}
	}

	const hasJsAdapter = !!(plugin.createTask && plugin.queryTask);
	const adapterKey = plugin.adapter?.key || plugin.id || plugin.type;
	const adapterModes = plugin.adapter?.modes || (plugin.models?.map((m: any) => ({
		key: m.id,
		label: m.name,
		inputHint: m.inputHint || "根据提示词生成...",
		paramsSchema: m.paramsSchema || []
	}))) || [];

	// If adapter is defined or standard methods are present, register it dynamically
	if (plugin.adapter || hasJsAdapter) {
		const dynamicSubmit = async (input: Record<string, unknown>, params: Record<string, unknown>) => {
			if (plugin.createTask) {
				const config = {};
				const taskId = await plugin.createTask(config, { ...input, ...params });
				return { taskId };
			}
			const { getAdapter } = await import("@/services/modelAdapter");
			const adapter = getAdapter(adapterKey);
			if (adapter) {
				return adapter.submit(input, params);
			}
			throw new Error(`Adapter ${adapterKey} not registered`);
		};

		const dynamicPoll = async (taskId: string) => {
			if (plugin.queryTask) {
				const config = {};
				const result = await plugin.queryTask(config, taskId);
				return {
					status: result.status,
					progress: result.progress,
					resultUri: result.video_url || result.image_url || result.audio_url || result.text || "",
					error: result.error
				};
			}
			const { getAdapter } = await import("@/services/modelAdapter");
			const adapter = getAdapter(adapterKey);
			if (adapter) {
				return adapter.poll(taskId);
			}
			throw new Error(`Adapter ${adapterKey} not registered`);
		};

		const dynamicAdapter = {
			key: adapterKey,
			displayName: plugin.adapter?.displayName || plugin.name || plugin.label,
			vendor: plugin.adapter?.vendor || "内置",
			nodeTypes: [nodePlugin.type],
			modes: adapterModes,
			baseCost: plugin.adapter?.baseCost || 10,
			estimateCost: estimateCostFn,
			submit: dynamicSubmit,
			poll: dynamicPoll,
		};

		import("@/services/modelAdapter").then(({ registerAdapter }) => {
			registerAdapter(dynamicAdapter);
		});
	}

	// Compile execute method or use adapter-based execution
	let executeFn = defaultNodeExecute;

	if (plugin.adapter || hasJsAdapter) {
		executeFn = async (nodeId: string) => {
			const { useCanvasStore } = await import("@/store/canvasStore");
			const { useLibraryStore } = await import("@/store/libraryStore");
			const { useProjectStore } = await import("@/store/projectStore");
			const { getAdapter } = await import("@/services/modelAdapter");

			const store = useCanvasStore.getState();
			const node = store.nodes[nodeId];
			if (!node) return;

			const params = node.data.params;
			const { resolveActiveModelKey } = await import("@/services/adapters/channelAdapter");
			const modelKey = resolveActiveModelKey(node.type, params.model, nodePlugin.defaultModel);
			const adapter = getAdapter(modelKey);
			if (!adapter) {
				const errorMsg = `未找到模型适配器「${modelKey || "未选择"}」，请在节点面板中选择模型`;
				store.setRuntime(nodeId, { status: "failed", progress: 100, error: errorMsg });
				return;
			}

			try {
				store.setRuntime(nodeId, { status: "queued", progress: 0 });

				const { resolveMentions } = await import("@/lib/mentionResolver");
				const resolvedPrompt = resolveMentions(nodeId, String(params.prompt || ""));
				const inputData = transformInputFn({ prompt: resolvedPrompt, ...params, ...node.data.input || {} }, nodeId);
				const { taskId } = await adapter.submit(inputData, params, node.type);
				console.log(`[Blackbox] ${nodeId} → adapter=${adapter.key} model=${modelKey} taskId=${taskId}`);

				store.setRuntime(nodeId, { status: "running", progress: 10 });

				let pollCount = 0;
				const maxPolls = 120;
				const runPolling = () => {
					setTimeout(async () => {
						try {
							const pollResult = await adapter.poll(taskId);
							pollCount++;
							console.log(`[Blackbox] ${nodeId} poll#${pollCount} status=${pollResult.status} progress=${pollResult.progress}`);

							if (pollResult.status === "success") {
								const resultUri = pollResult.resultUri || "";
								const assetId = `asset-${taskId}`;
								const filename = `${nodePlugin.type}_output_${Date.now()}`;

								useLibraryStore.getState().addAsset({
									id: assetId,
									kind: nodePlugin.resultKind as Asset["kind"],
									name: filename,
									uri: resultUri,
									thumbnailUri: null,
									createdAt: new Date().toISOString(),
									deletedByUser: false,
									localPath: null,
								});

								const updatedNodes = { ...store.nodes };
								if (updatedNodes[nodeId]) {
									updatedNodes[nodeId] = {
										...updatedNodes[nodeId],
										data: {
											...updatedNodes[nodeId].data,
											resultAssetId: assetId,
										},
									};
									useCanvasStore.setState({ nodes: updatedNodes });
								}

								store.setRuntime(nodeId, { status: "success", progress: 100 });
								useProjectStore.getState().scheduleAutoSave("history");
							} else if (pollResult.status === "failed") {
								store.setRuntime(nodeId, { status: "failed", progress: 100, error: pollResult.error || "生成失败" });
							} else {
								store.setRuntime(nodeId, {
									status: pollResult.status,
									progress: pollResult.progress || Math.min(pollCount * 10, 95),
								});
								if (pollCount < maxPolls) {
									runPolling();
								} else {
									store.setRuntime(nodeId, { status: "failed", progress: 100, error: "生成超时，已取消" });
								}
							}
						} catch (err) {
							console.error("[Blackbox] Polling error:", err);
							const msg = err instanceof Error ? err.message : "轮询异常";
							store.setRuntime(nodeId, { status: "failed", progress: 100, error: msg });
						}
					}, 1000);
				};
				runPolling();
			} catch (err) {
				console.error(`[Blackbox] Node ${nodeId} submit failed:`, err);
				const msg = err instanceof Error ? err.message : "请求发送失败";
				store.setRuntime(nodeId, { status: "failed", progress: 100, error: msg });
			}
		};
	}

	nodePlugin.execute = executeFn;
	plugins.set(nodePlugin.type, nodePlugin);
}

// ── 加载并注册本地 JS 插件文件 ──
const localPluginModules = import.meta.glob("./plugins/*.js", { eager: true });
for (const path in localPluginModules) {
	const mod = localPluginModules[path];
	const pluginData = (mod as any).default || mod;
	registerSerializedPlugin(pluginData);
}