/**
 * 资产存储（OSS 优先 + 内存兜底 + 元数据落盘）。
 *
 * 规格不变量：资产 id 全局唯一、永不复用，由管理端分配；按**类型前缀**编号。
 *  - 前缀：C 核心人物 / A 配角反派神明 / G 群像 / M 怪物异兽 / S 场景 / P 道具 / video / audio。
 *  - 文件名即 id：C00000123.png、S00000123.png、video00000123.mp4。
 * 元数据(assets.json)落盘，含每前缀自增计数 → 重启不归零、不复用。
 * 字节：配置 OSS 时上传到 OSS（公有读直链）；否则留内存供 /raw 兜底。
 */
import type { Capability } from "../contract.ts";
import { loadJson, saveJson } from "./db.ts";
import { isOssConfigured, ossPut, ossPublicUrl } from "./oss.ts";

const FILE = "assets.json";

export interface AssetRecord {
	id: string; // 类型前缀 + 8 位，如 C00000123
	type: Capability;
	contentType: string;
	name?: string; // 资产名（便于检索/展示）
	url: string; // OSS 公网直链；未配 OSS 时为空（走 /raw）
	ossKey?: string; // OSS 对象键，如 assets/C00000123.png
	createdAt: string;
}

interface AssetIndex {
	seqs: Record<string, number>; // 每前缀自增计数（永不复用）
	records: Record<string, AssetRecord>;
}

const idx: AssetIndex = loadJson<AssetIndex>(FILE, { seqs: {}, records: {} });
// 字节仅在内存（OSS 未配置时的兜底；不落盘）
const memBytes = new Map<string, Buffer>();

function persist(): void {
	saveJson(FILE, idx);
}

/** 分配下一个 id：{prefix}{8位}，按前缀单调、永不复用 */
export function nextAssetId(prefix = "a"): string {
	const p = prefix || "a";
	idx.seqs[p] = (idx.seqs[p] ?? 0) + 1;
	return `${p}${String(idx.seqs[p]).padStart(8, "0")}`;
}

function extFor(contentType: string): string {
	const m: Record<string, string> = {
		"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg",
		"video/mp4": "mp4", "video/webm": "webm",
		"audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/ogg": "ogg",
		"text/plain": "txt", "text/plain; charset=utf-8": "txt",
	};
	return m[contentType] || m[contentType.split(";")[0].trim()] || "bin";
}

/** 资产元数据 */
export function getAsset(id: string): AssetRecord | undefined {
	return idx.records[id];
}
/** 内存字节（OSS 未配置时的 /raw 兜底） */
export function getAssetBytes(id: string): Buffer | undefined {
	return memBytes.get(id);
}

/**
 * 创建资产：分配类型前缀 id → 配置 OSS 则上传得公网直链；否则字节留内存。
 * 元数据落盘（重启可解析）。
 */
export async function createAsset(
	data: Buffer,
	contentType: string,
	type: Capability,
	opts?: { prefix?: string; name?: string },
): Promise<AssetRecord> {
	const id = nextAssetId(opts?.prefix);
	const ossKey = `assets/${id}.${extFor(contentType)}`;
	let url = "";
	if (isOssConfigured()) {
		url = await ossPut(ossKey, data, contentType);
	} else {
		memBytes.set(id, data); // 兜底：无 OSS 时留内存供 /raw
	}
	const rec: AssetRecord = {
		id,
		type,
		contentType,
		name: opts?.name,
		url,
		ossKey: isOssConfigured() ? ossKey : undefined,
		createdAt: new Date().toISOString(),
	};
	idx.records[id] = rec;
	persist();
	return rec;
}

/** 资产可访问 url：优先 OSS 直链；否则回退服务端 /raw（凭 id 重解析） */
export function assetUrl(baseUrl: string, id: string): string {
	const rec = idx.records[id];
	if (rec?.url) return rec.url;
	if (rec?.ossKey) return ossPublicUrl(rec.ossKey);
	return `${baseUrl.replace(/\/+$/, "")}/v1/assets/${id}/raw`;
}
