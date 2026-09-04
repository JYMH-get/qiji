/**
 * 「官方」素材库映射缓存。
 *
 * Qiji 资产 id 仍是真实身份；这里只保存同一用户、同一渠道密钥、同一上游模型下的
 * 官方素材 id，避免每次生成重复预处理。Seedance 2.0 还在同一隔离范围下缓存
 * 上游素材分组；Seedance 2.5 不创建、不保存分组。
 * 密钥只保存 SHA-256 指纹，绝不落明文。
 * 表为纯增量 CREATE TABLE/INDEX，不修改或删除现有资产台账。
 */
import { db } from "./sqlite.ts";

export interface OfficialAssetScope {
	userId: string;
	channelId: string;
	credentialHash: string;
	upstreamModel: string;
}

export interface OfficialAssetBinding extends OfficialAssetScope {
	sourceKey: string;
	sourceUrlHash: string;
	assetType: "Image" | "Video" | "Audio";
	groupId?: string;
	assetId: string;
	status: string;
	errorCode?: string;
	errorMessage?: string;
	createdAt: number;
	updatedAt: number;
	lastUsedAt: number;
}

export interface OfficialAssetGroup extends OfficialAssetScope {
	groupId: string;
	createdAt: number;
	updatedAt: number;
	lastUsedAt: number;
}

db.exec(`
	CREATE TABLE IF NOT EXISTS official_asset_bindings (
		user_id          TEXT NOT NULL,
		channel_id       TEXT NOT NULL,
		credential_hash  TEXT NOT NULL,
		upstream_model   TEXT NOT NULL,
		source_key       TEXT NOT NULL,
		source_url_hash  TEXT NOT NULL,
		asset_type       TEXT NOT NULL,
		group_id         TEXT NOT NULL DEFAULT '', -- 2.0 记录所用分组；2.5 保持空字符串
		asset_id         TEXT NOT NULL,
		status           TEXT NOT NULL,
		error_code       TEXT,
		error_message    TEXT,
		created_at       INTEGER NOT NULL,
		updated_at       INTEGER NOT NULL,
		last_used_at     INTEGER NOT NULL,
		PRIMARY KEY (user_id, channel_id, credential_hash, upstream_model, source_key)
	);
	CREATE TABLE IF NOT EXISTS official_asset_groups (
		user_id          TEXT NOT NULL,
		channel_id       TEXT NOT NULL,
		credential_hash  TEXT NOT NULL,
		upstream_model   TEXT NOT NULL,
		group_id         TEXT NOT NULL,
		created_at       INTEGER NOT NULL,
		updated_at       INTEGER NOT NULL,
		last_used_at     INTEGER NOT NULL,
		PRIMARY KEY (user_id, channel_id, credential_hash, upstream_model)
	);
`);

// 兼容已运行过旧实现的数据库：CREATE TABLE IF NOT EXISTS 不会给存量表补列。
// 必须先补列并回填，再创建依赖该列的索引和预编译语句，否则服务端会在启动阶段崩溃。
for (const table of ["official_asset_bindings", "official_asset_groups"] as const) {
	const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name));
	if (!columns.has("last_used_at")) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN last_used_at INTEGER NOT NULL DEFAULT 0`);
		db.exec(`UPDATE ${table} SET last_used_at = updated_at WHERE last_used_at = 0`);
	}
}

db.exec(`
	CREATE INDEX IF NOT EXISTS idx_official_asset_id
		ON official_asset_bindings(asset_id);
	CREATE INDEX IF NOT EXISTS idx_official_asset_last_used
		ON official_asset_bindings(last_used_at);
	CREATE INDEX IF NOT EXISTS idx_official_asset_group_last_used
		ON official_asset_groups(last_used_at);
`);

const bindingGet = db.prepare(`
	SELECT source_url_hash, asset_type, group_id, asset_id, status, error_code, error_message,
		created_at, updated_at, last_used_at
	FROM official_asset_bindings
	WHERE user_id=? AND channel_id=? AND credential_hash=? AND upstream_model=? AND source_key=?
`);
const bindingPut = db.prepare(`
	INSERT INTO official_asset_bindings
		(user_id, channel_id, credential_hash, upstream_model, source_key, source_url_hash,
		 asset_type, group_id, asset_id, status, error_code, error_message, created_at, updated_at, last_used_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(user_id, channel_id, credential_hash, upstream_model, source_key)
	DO UPDATE SET source_url_hash=excluded.source_url_hash, asset_type=excluded.asset_type,
		group_id=excluded.group_id, asset_id=excluded.asset_id, status=excluded.status,
		error_code=excluded.error_code, error_message=excluded.error_message,
		updated_at=excluded.updated_at, last_used_at=excluded.last_used_at
`);
const bindingDelete = db.prepare(`
	DELETE FROM official_asset_bindings
	WHERE user_id=? AND channel_id=? AND credential_hash=? AND upstream_model=? AND source_key=?
`);
const groupGet = db.prepare(`
	SELECT group_id, created_at, updated_at, last_used_at
	FROM official_asset_groups
	WHERE user_id=? AND channel_id=? AND credential_hash=? AND upstream_model=?
`);
const groupPut = db.prepare(`
	INSERT INTO official_asset_groups
		(user_id, channel_id, credential_hash, upstream_model, group_id, created_at, updated_at, last_used_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(user_id, channel_id, credential_hash, upstream_model)
	DO UPDATE SET group_id=excluded.group_id, updated_at=excluded.updated_at, last_used_at=excluded.last_used_at
`);
const groupDelete = db.prepare(`
	DELETE FROM official_asset_groups
	WHERE user_id=? AND channel_id=? AND credential_hash=? AND upstream_model=?
`);

const scopeArgs = (s: OfficialAssetScope): [string, string, string, string] =>
	[s.userId, s.channelId, s.credentialHash, s.upstreamModel];

export function getOfficialAssetBinding(scope: OfficialAssetScope, sourceKey: string): OfficialAssetBinding | undefined {
	const row = bindingGet.get(...scopeArgs(scope), sourceKey) as {
		source_url_hash: string; asset_type: "Image" | "Video" | "Audio"; group_id: string; asset_id: string;
		status: string; error_code: string | null; error_message: string | null;
		created_at: number; updated_at: number; last_used_at: number;
	} | undefined;
	if (!row) return undefined;
	return {
		...scope, sourceKey,
		sourceUrlHash: row.source_url_hash,
		assetType: row.asset_type,
		groupId: row.group_id || undefined,
		assetId: row.asset_id,
		status: row.status,
		errorCode: row.error_code ?? undefined,
		errorMessage: row.error_message ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastUsedAt: row.last_used_at,
	};
}

export function putOfficialAssetBinding(binding: Omit<OfficialAssetBinding, "createdAt" | "updatedAt" | "lastUsedAt"> & Partial<Pick<OfficialAssetBinding, "createdAt" | "updatedAt" | "lastUsedAt">>): void {
	const now = Date.now();
	bindingPut.run(
		...scopeArgs(binding), binding.sourceKey, binding.sourceUrlHash, binding.assetType,
		binding.groupId ?? "", binding.assetId, binding.status, binding.errorCode ?? null, binding.errorMessage ?? null,
		binding.createdAt ?? now, binding.updatedAt ?? now, binding.lastUsedAt ?? now,
	);
}

export function deleteOfficialAssetBinding(scope: OfficialAssetScope, sourceKey: string): void {
	bindingDelete.run(...scopeArgs(scope), sourceKey);
}

export function getOfficialAssetGroup(scope: OfficialAssetScope): OfficialAssetGroup | undefined {
	const row = groupGet.get(...scopeArgs(scope)) as {
		group_id: string; created_at: number; updated_at: number; last_used_at: number;
	} | undefined;
	if (!row) return undefined;
	return {
		...scope,
		groupId: row.group_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastUsedAt: row.last_used_at,
	};
}

export function putOfficialAssetGroup(group: Omit<OfficialAssetGroup, "createdAt" | "updatedAt" | "lastUsedAt"> & Partial<Pick<OfficialAssetGroup, "createdAt" | "updatedAt" | "lastUsedAt">>): void {
	const now = Date.now();
	groupPut.run(
		...scopeArgs(group), group.groupId,
		group.createdAt ?? now, group.updatedAt ?? now, group.lastUsedAt ?? now,
	);
}

export function deleteOfficialAssetGroup(scope: OfficialAssetScope): void {
	groupDelete.run(...scopeArgs(scope));
}
