/**
 * 资产存储（内存版）。
 *
 * 关键不变量（来自规格）：资产 id 全局唯一、单调递增、永不复用。
 * 阶段2 用进程内自增计数器模拟；阶段后期换 Postgres SEQUENCE + S3。
 */
import type { Capability } from "../contract.ts";

export interface AssetRecord {
	id: string;
	type: Capability;
	contentType: string;
	data: Buffer;
	createdAt: string;
}

let _seq = 0;
const assets = new Map<string, AssetRecord>();

/** 分配下一个全局单调 id（永不复用） */
export function nextAssetId(): string {
	_seq += 1;
	return `a${String(_seq).padStart(8, "0")}`;
}

export function createAsset(data: Buffer, contentType: string, type: Capability): AssetRecord {
	const rec: AssetRecord = {
		id: nextAssetId(),
		type,
		contentType,
		data,
		createdAt: new Date().toISOString(),
	};
	assets.set(rec.id, rec);
	return rec;
}

export function getAsset(id: string): AssetRecord | undefined {
	return assets.get(id);
}

/** 资产公网 url（id 是真理，url 是可过期缓存；这里始终可由 id 重解析） */
export function assetUrl(baseUrl: string, id: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/v1/assets/${id}/raw`;
}
