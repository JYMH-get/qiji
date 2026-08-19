/**
 * sharedLibStore —— 共享素材库的客户端缓存（第120轮）。
 *
 * 三级惰性加载（用户点「获取」才拉，绝不一次性全量）：
 *  一级：已加入的库列表（轻量）；二级：库内文件夹+素材数；三级：进入文件夹后点「获取」
 *  才拉素材记录并**下载到本地**（应用级目录 <appData>/Qiji/shared/，跨项目共用），
 *  缩略图从本地加载；二次「获取」=刷新（只补下载新增记录）。不获取时只显示本地已缓存的素材。
 *
 * 缓存元数据持久化到 <appData>/Qiji/shared-cache.json（应用级，非项目级）；
 * 浏览器（非 Tauri）降级 localStorage + 直接用远程 url 显示。
 */
import { create } from "zustand";
import { managedClient } from "@/services/managedClient";
import type { SharedLibraryInfo, SharedFolderInfo, SharedAssetRecord } from "@/contract";

export interface CachedSharedAsset extends SharedAssetRecord {
	/** 本地副本显示 uri（asset://…；非 Tauri 为远程 url） */
	localUri?: string;
	localPath?: string;
}

/** 合并「服务端最新记录」与「本地缓存」：以服务端为准（删了的消失），保留已下载的 localUri（按记录 id 对齐）。 */
export function mergeSharedAssets(cached: CachedSharedAsset[], fetched: SharedAssetRecord[]): CachedSharedAsset[] {
	const byId = new Map(cached.map((c) => [c.id, c]));
	return fetched.map((r) => {
		const old = byId.get(r.id);
		return old ? { ...r, localUri: old.localUri, localPath: old.localPath } : { ...r };
	});
}

interface FetchProgress {
	done: number;
	total: number;
}

/** 共享页上次所在位置（随缓存持久化，重开恢复到上次浏览的库/文件夹） */
export interface SharedLastView {
	libId: string;
	folderId?: string;
}

interface SharedLibState {
	initialized: boolean;
	libs: SharedLibraryInfo[];
	foldersByLib: Record<string, SharedFolderInfo[]>;
	assetsByFolder: Record<string, CachedSharedAsset[]>;
	/** 上次浏览位置（null=库列表首页） */
	lastView: SharedLastView | null;
	setLastView: (v: SharedLastView | null) => void;
	/** 进行中的「获取」进度（key=libId 或 folderId；会话态不持久化） */
	fetching: Record<string, FetchProgress>;
	init: () => Promise<void>;
	/** 一级：刷新已加入的库列表 */
	fetchLibs: () => Promise<void>;
	/** 二级「获取」：只拉文件夹 + 素材数 */
	fetchFolders: (libId: string) => Promise<void>;
	/** 三级「获取」：拉当前文件夹素材记录并下载到本地（进度条驱动）；二次调用=刷新补新 */
	fetchFolderAssets: (folderId: string) => Promise<void>;
	/** 加入成功后并入缓存 */
	addLib: (lib: SharedLibraryInfo) => void;
	removeLib: (libId: string) => void;
	addFolder: (libId: string, folder: SharedFolderInfo) => void;
	save: () => Promise<void>;
}

const isTauri = () => typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
const LS_KEY = "Qiji:sharedCache";
const CACHE_FILE = "shared-cache.json";

async function sharedDir(): Promise<string> {
	const { appDataDir, join } = await import("@tauri-apps/api/path");
	const { exists, mkdir } = await import("@tauri-apps/plugin-fs");
	const dir = await join(await appDataDir(), "Qiji", "shared");
	if (!(await exists(dir))) await mkdir(dir, { recursive: true });
	return dir;
}

function extOf(url: string, mime?: string): string {
	const m = url.split(/[?#]/)[0].match(/\.([a-zA-Z0-9]{2,5})$/);
	if (m) return m[1].toLowerCase();
	if (mime?.includes("/")) return mime.split("/")[1].replace("jpeg", "jpg").split(";")[0] || "png";
	return "png";
}

/** 下载一条共享素材到应用级 shared 目录，返回 {localPath, localUri}；失败返回 null。 */
async function downloadShared(rec: SharedAssetRecord): Promise<{ localPath: string; localUri: string } | null> {
	if (!isTauri()) return null;
	try {
		const key = rec.assetId || rec.id; // 台账 id 优先：同一资产跨文件夹天然去重
		const dir = await sharedDir();
		const { join } = await import("@tauri-apps/api/path");
		const fs = await import("@tauri-apps/plugin-fs");
		const { convertFileSrc, invoke } = await import("@tauri-apps/api/core");
		const dest = await join(dir, `${key}.${extOf(rec.url, rec.mime)}`);
		if (!(await fs.exists(dest))) {
			// 优先 Rust 原生下载（绕 webview CORS）；失败回退 webview fetch
			let done = false;
			try {
				const r = await invoke<{ path: string; content_type: string }>("download_url", { url: rec.url });
				if (r?.path) {
					await fs.copyFile(r.path, dest);
					await fs.remove(r.path).catch(() => {});
					done = true;
				}
			} catch { /* 回退 fetch */ }
			if (!done) {
				const resp = await fetch(rec.url);
				if (!resp.ok) return null;
				await fs.writeFile(dest, new Uint8Array(await resp.arrayBuffer()));
			}
		}
		return { localPath: dest, localUri: convertFileSrc(dest) };
	} catch (e) {
		console.warn("[sharedLib] downloadShared failed:", rec.url, e);
		return null;
	}
}

export const useSharedLibStore = create<SharedLibState>((set, get) => ({
	initialized: false,
	libs: [],
	foldersByLib: {},
	assetsByFolder: {},
	lastView: null,
	setLastView: (v) => {
		set({ lastView: v });
		void get().save();
	},
	fetching: {},

	init: async () => {
		if (get().initialized) return;
		try {
			let raw = "";
			if (isTauri()) {
				const { appDataDir, join } = await import("@tauri-apps/api/path");
				const { exists, readTextFile } = await import("@tauri-apps/plugin-fs");
				const p = await join(await appDataDir(), "Qiji", CACHE_FILE);
				if (await exists(p)) raw = await readTextFile(p);
			} else {
				raw = localStorage.getItem(LS_KEY) || "";
			}
			if (raw) {
				const parsed = JSON.parse(raw) as Partial<Pick<SharedLibState, "libs" | "foldersByLib" | "assetsByFolder" | "lastView">>;
				set({
					libs: Array.isArray(parsed.libs) ? parsed.libs : [],
					foldersByLib: parsed.foldersByLib && typeof parsed.foldersByLib === "object" ? parsed.foldersByLib : {},
					assetsByFolder: parsed.assetsByFolder && typeof parsed.assetsByFolder === "object" ? parsed.assetsByFolder : {},
					lastView: parsed.lastView && typeof parsed.lastView === "object" && typeof parsed.lastView.libId === "string" ? parsed.lastView : null,
				});
			}
		} catch (e) {
			console.warn("[sharedLib] init failed:", e);
		}
		set({ initialized: true });
	},

	save: async () => {
		const { libs, foldersByLib, assetsByFolder, lastView } = get();
		const data = JSON.stringify({ libs, foldersByLib, assetsByFolder, lastView });
		try {
			if (isTauri()) {
				const { appDataDir, join } = await import("@tauri-apps/api/path");
				const { exists, mkdir, writeTextFile } = await import("@tauri-apps/plugin-fs");
				const dir = await join(await appDataDir(), "Qiji");
				if (!(await exists(dir))) await mkdir(dir, { recursive: true });
				await writeTextFile(await join(dir, CACHE_FILE), data);
			} else {
				localStorage.setItem(LS_KEY, data);
			}
		} catch (e) {
			console.warn("[sharedLib] save failed:", e);
		}
	},

	fetchLibs: async () => {
		const libs = await managedClient.sharedLibraries();
		set({ libs });
		void get().save();
	},

	fetchFolders: async (libId) => {
		set((s) => ({ fetching: { ...s.fetching, [libId]: { done: 0, total: 1 } } }));
		try {
			const items = await managedClient.sharedFolders(libId);
			set((s) => ({ foldersByLib: { ...s.foldersByLib, [libId]: items } }));
			void get().save();
		} finally {
			set((s) => {
				const f = { ...s.fetching };
				delete f[libId];
				return { fetching: f };
			});
		}
	},

	fetchFolderAssets: async (folderId) => {
		// 先拉记录清单（轻量），再逐条下载缺本地副本的（进度条=下载进度）
		const records = await managedClient.sharedFolderAssets(folderId);
		const merged = mergeSharedAssets(get().assetsByFolder[folderId] ?? [], records);
		set((s) => ({ assetsByFolder: { ...s.assetsByFolder, [folderId]: merged } }));
		const missing = merged.filter((r) => !r.localUri);
		if (missing.length === 0 || !isTauri()) {
			// 非 Tauri：直接用远程 url 显示（浏览器无 CSP 限制）
			if (!isTauri() && missing.length) {
				set((s) => ({
					assetsByFolder: {
						...s.assetsByFolder,
						[folderId]: (s.assetsByFolder[folderId] ?? []).map((r) => (r.localUri ? r : { ...r, localUri: r.url })),
					},
				}));
			}
			void get().save();
			return;
		}
		set((s) => ({ fetching: { ...s.fetching, [folderId]: { done: 0, total: missing.length } } }));
		try {
			let done = 0;
			const CONC = 4;
			let idx = 0;
			const worker = async () => {
				while (idx < missing.length) {
					const rec = missing[idx++];
					const local = await downloadShared(rec);
					done += 1;
					set((s) => ({
						fetching: { ...s.fetching, [folderId]: { done, total: missing.length } },
						...(local
							? {
									assetsByFolder: {
										...s.assetsByFolder,
										[folderId]: (s.assetsByFolder[folderId] ?? []).map((r) => (r.id === rec.id ? { ...r, ...local } : r)),
									},
								}
							: {}),
					}));
				}
			};
			await Promise.all(Array.from({ length: Math.min(CONC, missing.length) }, worker));
			void get().save();
		} finally {
			set((s) => {
				const f = { ...s.fetching };
				delete f[folderId];
				return { fetching: f };
			});
		}
	},

	addLib: (lib) => {
		set((s) => ({ libs: s.libs.some((l) => l.id === lib.id) ? s.libs : [...s.libs, lib] }));
		void get().save();
	},

	removeLib: (libId) => {
		set((s) => {
			const folders = s.foldersByLib[libId] ?? [];
			const assetsByFolder = { ...s.assetsByFolder };
			for (const f of folders) delete assetsByFolder[f.id];
			const foldersByLib = { ...s.foldersByLib };
			delete foldersByLib[libId];
			return {
				libs: s.libs.filter((l) => l.id !== libId),
				foldersByLib,
				assetsByFolder,
				lastView: s.lastView?.libId === libId ? null : s.lastView,
			};
		});
		void get().save();
	},

	addFolder: (libId, folder) => {
		set((s) => ({ foldersByLib: { ...s.foldersByLib, [libId]: [...(s.foldersByLib[libId] ?? []), folder] } }));
		void get().save();
	},
}));
