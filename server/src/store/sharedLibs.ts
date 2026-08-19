/**
 * 共享素材库存储（第120轮，文件持久化 shared-libs.json + 防抖异步落盘）。
 *
 * 三级结构：共享资产库（SharedLibrary）→ 共享文件夹（SharedFolder）→ 素材记录（SharedAssetRec）。
 *  - 库由渠道商/源站创建并设**加入密码**；按受众隔离（ownerAudience = agentId | "platform"，
 *    第111轮「源站作为一个渠道商管理」同构）——用户只能搜索/加入自己受众的库（渠道商区分系统）。
 *  - 素材**只存 OSS 记录**（assetId + url + name），字节绝不复制：分享方登记记录、
 *    使用方解析 OSS 直链自行下载（id 是真理——带 assetId 的记录下发时按台账刷新当前直链）。
 *  - 用户加入库后可增加文件夹与素材（只增；删除/停用属管理面：门户/管理端）。
 * 写频率=用户操作级（非热路径），走 scheduleSave 防抖异步落盘（§9 热路径写盘规则）。
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { loadJson, scheduleSave, genId } from "./db.ts";

export interface SharedLibrary {
	id: string; // lib_xxx
	name: string;
	/** 受众隔离：渠道商 id 或 "platform"（源站直属用户） */
	ownerAudience: string;
	/** 团队共享库（第172轮）：归属团队 id。团队成员**不限归属**（第173轮）——带 teamId 的库对其成员
	 *  豁免受众隔离（路由层按 isMember 判定；搜索/密码加入仍走受众，团队库靠随团自动入库） */
	teamId?: string;
	salt: string;
	/** scrypt(加入密码, salt) 十六进制 */
	passwordHash: string;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface SharedFolder {
	id: string; // sf_xxx
	libraryId: string;
	name: string;
	/** 创建者（用户名，展示用） */
	by: string;
	createdAt: string;
}

export interface SharedAssetRec {
	id: string; // sa_xxx
	libraryId: string;
	folderId: string;
	/** 台账资产 id（有则下发时按台账刷新当前直链——id 是真理） */
	assetId?: string;
	/** OSS 公网直链（缓存） */
	url: string;
	name: string;
	mime?: string;
	/** 分享者（用户名，展示用） */
	by: string;
	createdAt: string;
}

interface Db {
	libraries: SharedLibrary[];
	folders: SharedFolder[];
	assets: SharedAssetRec[];
	/** libraryId → 已加入的 userId 列表 */
	members: Record<string, string[]>;
}

const FILE = "shared-libs.json";
const db: Db = {
	libraries: [],
	folders: [],
	assets: [],
	members: {},
	...loadJson<Partial<Db>>(FILE, {}),
};

function persist(): void {
	scheduleSave(FILE, () => JSON.stringify(db, null, 2));
}

function hashPw(password: string, salt: string): string {
	return scryptSync(password, salt, 32).toString("hex");
}

// ── 上限（防滥用；到顶明确报错而非静默截断） ──
const MAX_LIBS_PER_AUDIENCE = 50;
const MAX_FOLDERS_PER_LIB = 200;
const MAX_ASSETS_PER_FOLDER = 2000;

// ── 库 CRUD（门户/管理端） ──

export function getLibrary(id: string): SharedLibrary | undefined {
	return db.libraries.find((l) => l.id === id);
}

export function listLibrariesByAudience(audience: string): SharedLibrary[] {
	return db.libraries.filter((l) => l.ownerAudience === audience);
}

/**
 * 全部共享素材的台账 assetId（P2 保留策略用）——**共享库里的素材永久保留**。
 * 只有带 assetId 的记录才算（纯 url 记录不是我方台账资产，清理任务本就碰不到）。
 */
export function listSharedAssetIds(): string[] {
	return [...new Set(db.assets.map((a) => a.assetId).filter((x): x is string => !!x))];
}

export function listAllLibraries(): SharedLibrary[] {
	return [...db.libraries];
}

export type LibResult = { ok: true; library: SharedLibrary } | { ok: false; error: string };

export function createLibrary(input: { name?: string; password?: string; ownerAudience: string; teamId?: string }): LibResult {
	const name = (input.name || "").trim();
	if (!name || name.length > 40) return { ok: false, error: "库名需 1–40 字" };
	const password = (input.password || "").trim();
	if (password.length < 4) return { ok: false, error: "加入密码至少 4 位" };
	const mine = listLibrariesByAudience(input.ownerAudience);
	if (mine.length >= MAX_LIBS_PER_AUDIENCE) return { ok: false, error: `共享库数量已达上限（${MAX_LIBS_PER_AUDIENCE}）` };
	if (mine.some((l) => l.name === name)) return { ok: false, error: "已存在同名共享库" };
	const now = new Date().toISOString();
	const salt = randomBytes(16).toString("hex");
	const library: SharedLibrary = {
		id: genId("lib"),
		name,
		ownerAudience: input.ownerAudience,
		teamId: input.teamId,
		salt,
		passwordHash: hashPw(password, salt),
		enabled: true,
		createdAt: now,
		updatedAt: now,
	};
	db.libraries.push(library);
	persist();
	return { ok: true, library };
}

export function updateLibrary(id: string, patch: { name?: string; password?: string; enabled?: boolean }): LibResult {
	const l = getLibrary(id);
	if (!l) return { ok: false, error: "共享库不存在" };
	if (patch.name !== undefined) {
		const name = patch.name.trim();
		if (!name || name.length > 40) return { ok: false, error: "库名需 1–40 字" };
		if (listLibrariesByAudience(l.ownerAudience).some((x) => x.name === name && x.id !== id)) return { ok: false, error: "已存在同名共享库" };
		l.name = name;
	}
	if (patch.password) {
		const password = patch.password.trim();
		if (password.length < 4) return { ok: false, error: "加入密码至少 4 位" };
		l.salt = randomBytes(16).toString("hex");
		l.passwordHash = hashPw(password, l.salt);
	}
	if (patch.enabled !== undefined) l.enabled = patch.enabled;
	l.updatedAt = new Date().toISOString();
	persist();
	return { ok: true, library: l };
}

/** 删除库：级联删除其文件夹/素材记录/成员关系（素材字节在 OSS，本操作不动字节） */
export function deleteLibrary(id: string): boolean {
	const before = db.libraries.length;
	db.libraries = db.libraries.filter((l) => l.id !== id);
	if (db.libraries.length === before) return false;
	db.folders = db.folders.filter((f) => f.libraryId !== id);
	db.assets = db.assets.filter((a) => a.libraryId !== id);
	delete db.members[id];
	persist();
	return true;
}

/** 库的统计（门户/管理端列表 + 用户端「已加入」列表共用） */
export function libraryCounts(id: string): { folderCount: number; assetCount: number; memberCount: number } {
	return {
		folderCount: db.folders.filter((f) => f.libraryId === id).length,
		assetCount: db.assets.filter((a) => a.libraryId === id).length,
		memberCount: (db.members[id] ?? []).length,
	};
}

// ── 成员（用户端加入/退出） ──

export function isMember(libraryId: string, userId: string): boolean {
	return (db.members[libraryId] ?? []).includes(userId);
}

export function verifyLibraryPassword(l: SharedLibrary, password: string): boolean {
	const cand = hashPw(password || "", l.salt);
	return cand.length === l.passwordHash.length && timingSafeEqual(Buffer.from(cand, "hex"), Buffer.from(l.passwordHash, "hex"));
}

export function joinLibrary(libraryId: string, userId: string): void {
	const arr = db.members[libraryId] ?? (db.members[libraryId] = []);
	if (!arr.includes(userId)) {
		arr.push(userId);
		persist();
	}
}

export function leaveLibrary(libraryId: string, userId: string): void {
	const arr = db.members[libraryId];
	if (arr?.includes(userId)) {
		db.members[libraryId] = arr.filter((u) => u !== userId);
		persist();
	}
}

/** 用户已加入且启用的库（用户端「共享资产」首层） */
export function memberLibraries(userId: string): SharedLibrary[] {
	return db.libraries.filter((l) => l.enabled && (db.members[l.id] ?? []).includes(userId));
}

/** 按名搜索（加入用；只回启用的库，绝不带密码信息）。
 *  ⚠ 第173轮用户定「共享库开放，不需要隔离」：**全局搜索不限归属**——搜索+加入密码即是访问控制；
 *  ownerAudience 从此仅作创建方归属（门户/管理端各管自己建的库），不再限制用户侧可见性。 */
export function searchLibraries(q: string): SharedLibrary[] {
	const needle = (q || "").trim().toLowerCase();
	if (!needle) return [];
	return db.libraries.filter((l) => l.enabled && l.name.toLowerCase().includes(needle)).slice(0, 20);
}

// ── 文件夹（二级） ──

export function getFolder(id: string): SharedFolder | undefined {
	return db.folders.find((f) => f.id === id);
}

/** 库内文件夹 + 各自素材数（共享主页「获取」只拉这一层） */
export function listFolders(libraryId: string): Array<SharedFolder & { count: number }> {
	const counts = new Map<string, number>();
	for (const a of db.assets) if (a.libraryId === libraryId) counts.set(a.folderId, (counts.get(a.folderId) ?? 0) + 1);
	return db.folders
		.filter((f) => f.libraryId === libraryId)
		.map((f) => ({ ...f, count: counts.get(f.id) ?? 0 }));
}

export type FolderResult = { ok: true; folder: SharedFolder } | { ok: false; error: string };

export function createFolder(libraryId: string, name: string, by: string): FolderResult {
	const nm = (name || "").trim();
	if (!nm || nm.length > 40) return { ok: false, error: "文件夹名需 1–40 字" };
	const inLib = db.folders.filter((f) => f.libraryId === libraryId);
	if (inLib.length >= MAX_FOLDERS_PER_LIB) return { ok: false, error: `文件夹数量已达上限（${MAX_FOLDERS_PER_LIB}）` };
	if (inLib.some((f) => f.name === nm)) return { ok: false, error: "已存在同名文件夹" };
	const folder: SharedFolder = { id: genId("sf"), libraryId, name: nm, by, createdAt: new Date().toISOString() };
	db.folders.push(folder);
	persist();
	return { ok: true, folder };
}

/** 删除文件夹（管理面）：级联删其素材记录 */
export function deleteFolder(id: string): boolean {
	const before = db.folders.length;
	db.folders = db.folders.filter((f) => f.id !== id);
	if (db.folders.length === before) return false;
	db.assets = db.assets.filter((a) => a.folderId !== id);
	persist();
	return true;
}

// ── 素材记录（三级；只存 OSS 记录，不复制字节） ──

export function listFolderAssets(folderId: string): SharedAssetRec[] {
	return db.assets.filter((a) => a.folderId === folderId);
}

export type AddAssetsResult = { ok: true; added: number; skipped: number } | { ok: false; error: string };

/**
 * 登记素材记录（分享=只存记录）。逐条：assetId/url 至少一个；同文件夹内按 assetId/url 去重（跳过不报错）。
 * url 合法性由路由层校验后传入（这里只管落库）。
 */
export function addFolderAssets(
	folder: SharedFolder,
	items: Array<{ assetId?: string; url: string; name: string; mime?: string }>,
	by: string,
): AddAssetsResult {
	const existing = db.assets.filter((a) => a.folderId === folder.id);
	if (existing.length + items.length > MAX_ASSETS_PER_FOLDER) {
		return { ok: false, error: `文件夹素材数量将超上限（${MAX_ASSETS_PER_FOLDER}），请分文件夹存放` };
	}
	const seen = new Set<string>();
	for (const a of existing) {
		if (a.assetId) seen.add(`id:${a.assetId}`);
		if (a.url) seen.add(`url:${a.url}`);
	}
	let added = 0;
	let skipped = 0;
	const now = new Date().toISOString();
	for (const it of items) {
		const keyId = it.assetId ? `id:${it.assetId}` : "";
		const keyUrl = it.url ? `url:${it.url}` : "";
		if ((keyId && seen.has(keyId)) || (keyUrl && seen.has(keyUrl))) {
			skipped++;
			continue;
		}
		if (keyId) seen.add(keyId);
		if (keyUrl) seen.add(keyUrl);
		db.assets.push({
			id: genId("sa"),
			libraryId: folder.libraryId,
			folderId: folder.id,
			assetId: it.assetId,
			url: it.url,
			name: (it.name || "素材").slice(0, 80),
			mime: it.mime,
			by,
			createdAt: now,
		});
		added++;
	}
	if (added > 0) persist();
	return { ok: true, added, skipped };
}

/** 按 id 取素材记录（团长删素材等管理面权限校验用） */
export function getAssetRec(id: string): SharedAssetRec | undefined {
	return db.assets.find((a) => a.id === id);
}

/** 删除单条素材记录（管理面） */
export function deleteAssetRec(id: string): boolean {
	const before = db.assets.length;
	db.assets = db.assets.filter((a) => a.id !== id);
	if (db.assets.length === before) return false;
	persist();
	return true;
}
