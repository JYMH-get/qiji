/**
 * 极简文件存储（JSON / JSONL）。
 *
 * 阶段2 用本地文件持久化 users / models / logs，零外部依赖、重启不丢。
 * 接口稳定，阶段后期可整体换 Postgres 而不动调用方。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(here, "..", "..", "data");

function ensureDir(): void {
	if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function pathOf(name: string): string {
	return join(DATA_DIR, name);
}

/** 读 JSON 文件，缺失/损坏时回退默认值 */
export function loadJson<T>(name: string, fallback: T): T {
	try {
		const p = pathOf(name);
		if (!existsSync(p)) return fallback;
		return JSON.parse(readFileSync(p, "utf8")) as T;
	} catch {
		return fallback;
	}
}

/** 原子写 JSON 文件 */
export function saveJson(name: string, data: unknown): void {
	ensureDir();
	const p = pathOf(name);
	const tmp = `${p}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
	writeFileSync(p, readFileSync(tmp));
}

/** 追加一行 JSONL（用于日志，避免整文件重写） */
export function appendJsonl(name: string, obj: unknown): void {
	ensureDir();
	appendFileSync(pathOf(name), JSON.stringify(obj) + "\n", "utf8");
}

/** 读 JSONL 全部行（缺失返回空数组） */
export function readJsonl<T>(name: string): T[] {
	try {
		const p = pathOf(name);
		if (!existsSync(p)) return [];
		return readFileSync(p, "utf8")
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => {
				try {
					return JSON.parse(line) as T;
				} catch {
					return null;
				}
			})
			.filter((x): x is T => x !== null);
	} catch {
		return [];
	}
}

/** 整体重写 JSONL（用于日志清理/裁剪） */
export function writeJsonl(name: string, rows: unknown[]): void {
	ensureDir();
	writeFileSync(pathOf(name), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "utf8");
}

let _idSeq = 0;
/** 简易自增 id（带前缀 + 时间基 + 序号，进程内单调） */
export function genId(prefix: string): string {
	_idSeq += 1;
	return `${prefix}_${Date.now().toString(36)}${_idSeq.toString(36)}`;
}

/** 截断 base64 / data URL，避免日志/存储膨胀 */
export function truncateBase64(obj: unknown): unknown {
	if (typeof obj === "string") {
		if (obj.startsWith("data:") && obj.includes(";base64,")) {
			const [prefix, b64] = obj.split(";base64,");
			return `${prefix};base64,${b64.slice(0, 64)}…[truncated ${b64.length}]`;
		}
		if (obj.length > 256 && /^[A-Za-z0-9+/=]+$/.test(obj)) {
			return `${obj.slice(0, 64)}…[truncated base64 ${obj.length}]`;
		}
		return obj;
	}
	if (Array.isArray(obj)) return obj.map(truncateBase64);
	if (obj && typeof obj === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(obj)) out[k] = truncateBase64(v);
		return out;
	}
	return obj;
}
