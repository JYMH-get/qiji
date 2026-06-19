/**
 * pluginWatcher — 插件热加载监控
 *
 * 监控项目目录下 `plugins/` 或自定义插件目录中的 .json 文件变更，
 * 检测到新增或修改时自动调用 registerSerializedPlugin 重新注册插件。
 *
 * Tauri 环境：使用 @tauri-apps/plugin-fs 的 watchImmediate API
 * 浏览器降级：不做监控（无文件系统访问）
 */

import { registerSerializedPlugin, getPlugin } from "./pluginRegistry";
import type { SerializedPluginJSON } from "./SerializedPluginJSON";

let _unwatchFn: (() => void | Promise<void>) | null = null;

/**
 * 启动插件目录监控
 *
 * @param pluginsDir 插件目录绝对路径
 */
export async function startPluginWatcher(pluginsDir: string): Promise<void> {
	// 清理旧 watcher
	if (_unwatchFn) {
		await _unwatchFn();
		_unwatchFn = null;
	}

	const isTauri =
		typeof window !== "undefined" &&
		("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

	if (!isTauri) {
		console.warn("[PluginWatcher] 非 Tauri 环境，跳过热加载");
		return;
	}

	try {
		const { readTextFile, watchImmediate } = await import(
			"@tauri-apps/plugin-fs"
		);

		// 先扫描现有文件做一次全量加载（避免遗漏已存在的自定义插件）
		await loadAllPluginsFromDir(pluginsDir);

		// 监控目录变更
		_unwatchFn = await watchImmediate(
			pluginsDir,
			async (event) => {
				const path = event.paths[0];
				if (!path || !path.endsWith(".json")) return;

				try {
					const content = await readTextFile(path);
					const json: SerializedPluginJSON = JSON.parse(content);
					if (!json.type) return;

					const existing = getPlugin(json.type);
					if (existing) {
						console.log(`[PluginWatcher] 插件已更新: ${json.type}`);
					} else {
						console.log(`[PluginWatcher] 发现新插件: ${json.type}`);
					}

					registerSerializedPlugin(json);
				} catch (err) {
					console.error(`[PluginWatcher] 解析插件 JSON 失败: ${path}`, err);
				}
			},
			{ recursive: false }
		);

		console.log(`[PluginWatcher] 已启动监控: ${pluginsDir}`);
	} catch (err) {
		// watchImmediate 不可用时降级为轮询
		console.warn("[PluginWatcher] watchImmediate 不可用，使用轮询降级", err);
		await startPollingWatcher(pluginsDir);
	}
}

/**
 * 停止插件监控
 */
export async function stopPluginWatcher(): Promise<void> {
	if (_unwatchFn) {
		await _unwatchFn();
		_unwatchFn = null;
	}
}

/**
 * 轮询降级方案：每 3 秒扫描一次目录
 */
async function startPollingWatcher(pluginsDir: string): Promise<void> {
	const { readDir, readTextFile } = await import("@tauri-apps/plugin-fs");

	const knownFiles = new Map<string, number>(); // path -> last modified time

	const poll = async () => {
		try {
			const entries = await readDir(pluginsDir);
			for (const entry of entries) {
				if (!entry.name?.endsWith(".json")) continue;
				const fullPath = `${pluginsDir}/${entry.name}`;

				try {
					const content = await readTextFile(fullPath);
					const hash = simpleHash(content);
					const prev = knownFiles.get(fullPath);

					if (prev !== hash) {
						knownFiles.set(fullPath, hash);
						const json: SerializedPluginJSON = JSON.parse(content);
						if (json.type) {
							registerSerializedPlugin(json);
						}
					}
				} catch {
					// 文件可能正在被写入，跳过
				}
			}
		} catch {
			// 目录不存在，忽略
		}
	};

	await poll();
	const timer = setInterval(poll, 3000);
	_unwatchFn = async () => clearInterval(timer);
}

/**
 * 从目录批量加载所有插件 JSON
 */
async function loadAllPluginsFromDir(dir: string): Promise<void> {
	const isTauri =
		typeof window !== "undefined" &&
		("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
	if (!isTauri) return;

	try {
		const { readDir, readTextFile } = await import("@tauri-apps/plugin-fs");
		const entries = await readDir(dir);

		for (const entry of entries) {
			if (!entry.name?.endsWith(".json")) continue;
			try {
				const content = await readTextFile(`${dir}/${entry.name}`);
				const json: SerializedPluginJSON = JSON.parse(content);
				if (json.type) {
					registerSerializedPlugin(json);
				}
			} catch (err) {
				console.error(`[PluginWatcher] 加载插件失败: ${entry.name}`, err);
			}
		}
	} catch {
		// 目录不存在，忽略
	}
}

/**
 * 简单字符串哈希（用于检测文件内容是否变更）
 */
function simpleHash(str: string): number {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		hash = (hash << 5) - hash + ch;
		hash |= 0;
	}
	return hash;
}