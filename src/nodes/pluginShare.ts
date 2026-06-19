/**
 * pluginShare — 插件导入/分享
 *
 * 支持两种操作：
 * 1. 导出：将指定插件的 JSON 序列化为 `.qiji-plugin.json` 文件，触发下载
 * 2. 导入：弹出文件对话框选择 `.qiji-plugin.json`，解析后注册到 pluginRegistry
 */
import { registerSerializedPlugin, getPlugin } from "./pluginRegistry";
import type { SerializedPluginJSON } from "./SerializedPluginJSON";

const PLUGIN_FILE_EXT = ".qiji-plugin.json";
const PLUGIN_FILE_MIME = "application/json";

/**
 * 导出指定类型的插件为 .qiji-plugin.json 文件
 * 如果不传 type，导出所有非内置插件
 */
export async function exportPlugin(type?: string): Promise<void> {
	if (type) {
		const plugin = getPlugin(type);
		if (!plugin) {
			console.error(`[PluginShare] 插件 ${type} 不存在`);
			return;
		}
		const json = serializePluginForExport(plugin.type);
		if (!json) return;
		downloadJson(json, `${plugin.type}${PLUGIN_FILE_EXT}`);
	} else {
		// 导出所有自定义插件（非内置）
		const builtins = new Set(["text", "script", "image", "video", "audio", "file_document", "file_image", "file_video", "file_audio"]);
		const { listPlugins } = await import("./pluginRegistry");
		for (const plugin of listPlugins()) {
			if (builtins.has(plugin.type)) continue;
			const json = serializePluginForExport(plugin.type);
			if (json) {
				downloadJson(json, `${plugin.type}${PLUGIN_FILE_EXT}`);
			}
		}
	}
}

/**
 * 导入 .qiji-plugin.json 文件
 * 弹出文件对话框，解析后注册插件
 */
export async function importPlugin(): Promise<{ success: boolean; type?: string; error?: string }> {
	const isTauri =
		typeof window !== "undefined" &&
		("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

	if (isTauri) {
		return importPluginTauri();
	}
	return importPluginBrowser();
}

/**
 * Tauri 环境：通过 dialog API 选择文件
 */
async function importPluginTauri(): Promise<{ success: boolean; type?: string; error?: string }> {
	try {
		const { readTextFile } = await import("@tauri-apps/plugin-fs");
		const { open } = await import("@tauri-apps/plugin-dialog");

		const selected = await open({
			multiple: false,
			filters: [{ name: "Qiji 插件", extensions: ["qiji-plugin.json", "json"] }],
		}) as string | null;

		if (!selected) return { success: false, error: "未选择文件" };

		const content = await readTextFile(selected);
		return parseAndRegisterPlugin(content);
	} catch (err) {
		const msg = err instanceof Error ? err.message : "导入失败";
		console.error("[PluginShare] Tauri 导入失败:", err);
		return { success: false, error: msg };
	}
}

/**
 * 浏览器环境：通过 <input type=file> 选择文件
 */
function importPluginBrowser(): Promise<{ success: boolean; type?: string; error?: string }> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".qiji-plugin.json,.json";

		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) {
				resolve({ success: false, error: "未选择文件" });
				return;
			}

			try {
				const text = await file.text();
				resolve(parseAndRegisterPlugin(text));
			} catch (err) {
				const msg = err instanceof Error ? err.message : "读取文件失败";
				resolve({ success: false, error: msg });
			}
		};

		input.oncancel = () => resolve({ success: false, error: "取消选择" });
		input.click();
	});
}

/**
 * 解析 JSON 文本并注册插件
 */
function parseAndRegisterPlugin(content: string): { success: boolean; type?: string; error?: string } {
	try {
		const json: SerializedPluginJSON = JSON.parse(content);

		if (!json.type) {
			return { success: false, error: "缺少 type 字段" };
		}
		if (!json.label) {
			return { success: false, error: "缺少 label 字段" };
		}

		const existing = getPlugin(json.type);
		if (existing) {
			console.log(`[PluginShare] 覆盖已注册插件: ${json.type}`);
		}

		registerSerializedPlugin(json);
		console.log(`[PluginShare] 插件注册成功: ${json.type} (${json.label})`);

		return { success: true, type: json.type };
	} catch (err) {
		const msg = err instanceof Error ? err.message : "JSON 解析失败";
		return { success: false, error: msg };
	}
}

/**
 * 从运行时插件反序列化为可导出的 JSON
 */
function serializePluginForExport(type: string): SerializedPluginJSON | null {
	// 读取内嵌的 JSON 源文件（如果有）
	// 否则从运行时 plugin 构建最小 JSON
	const plugin = getPlugin(type);
	if (!plugin) return null;

	return {
		type: plugin.type,
		label: plugin.label,
		code: plugin.code,
		accentVar: plugin.accentVar,
		resultKind: plugin.resultKind,
		defaultModel: plugin.defaultModel,
		description: plugin.description,
		category: plugin.category,
		thumbnail: plugin.thumbnail,
		inputs: plugin.inputs,
		outputs: plugin.outputs,
		canStack: plugin.canStack,
		isActive: plugin.isActive,
		adapter: undefined,
		scripts: undefined,
	};
}

/**
 * 下载 JSON 文件
 */
function downloadJson(json: SerializedPluginJSON, filename: string): void {
	const content = JSON.stringify(json, null, 2);
	const blob = new Blob([content], { type: PLUGIN_FILE_MIME });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}