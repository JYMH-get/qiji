/**
 * 极简文件存储（JSON / JSONL）。
 *
 * 阶段2 用本地文件持久化 users / models / logs，零外部依赖、重启不丢。
 * 接口稳定，阶段后期可整体换 Postgres 而不动调用方。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync } from "node:fs";
import { writeFile, rename, mkdir } from "node:fs/promises";
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

/** 原子写 JSON 文件（同步；用于低频、需即时持久的配置/用户写） */
export function saveJson(name: string, data: unknown): void {
	ensureDir();
	const p = pathOf(name);
	const tmp = `${p}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
	renameSync(tmp, p); // 原子生效；无需再读回重写（旧实现 readFileSync(tmp) 多一次白读）
}

// ── 防抖异步落盘 ──
// 高频热路径（日志/任务）若每次变更都同步全量重写文件，会在 event loop 上造成
// 数百 ms 的 JSON.stringify + writeFileSync 阻塞——并发生成时整个进程近乎冻结，
// 心跳/登录/健康检查/admin 页全部排队超时。故合并同一文件在窗口内的多次写为一次，
// 用 fs/promises 异步写 + 原子 rename，绝不阻塞 event loop。serialize 在真正落盘时
// 才调用，读取的是当时最新的内存状态；同一文件的写按链串行，避免交叠。
const FLUSH_DELAY_MS = 1000;
type Serializer = () => string;
interface PendingSave {
	serialize: Serializer;
	timer: ReturnType<typeof setTimeout> | null;
}
const pendingSaves = new Map<string, PendingSave>();
const writeChains = new Map<string, Promise<void>>();

/**
 * 防抖异步落盘：FLUSH_DELAY_MS 窗口内对同一文件的多次 scheduleSave 合并为一次磁盘写。
 * 适用于高频、可容忍极小窗口丢失的写（日志/任务；进程被 -9 硬杀时最多丢窗口内的写）。
 * 优雅关闭请调用 flushPendingSaves() 立即刷盘。
 */
export function scheduleSave(name: string, serialize: Serializer): void {
	const existing = pendingSaves.get(name);
	if (existing) {
		existing.serialize = serialize; // 用最新 serializer（落盘时才读内存，等价，取最新更稳）
		return;
	}
	const entry: PendingSave = { serialize, timer: null };
	entry.timer = setTimeout(() => void flushSave(name), FLUSH_DELAY_MS);
	entry.timer.unref?.(); // 不因待落盘的定时器阻止进程退出
	pendingSaves.set(name, entry);
}

async function flushSave(name: string): Promise<void> {
	const entry = pendingSaves.get(name);
	if (!entry) return;
	pendingSaves.delete(name);
	if (entry.timer) clearTimeout(entry.timer);
	const prev = writeChains.get(name) ?? Promise.resolve();
	const next = prev
		.then(async () => {
			const data = entry.serialize();
			const p = pathOf(name);
			await mkdir(dirname(p), { recursive: true }); // 支持子目录名（如 logs-index/<日期>.jsonl）
			const tmp = `${p}.tmp`;
			await writeFile(tmp, data, "utf8");
			await rename(tmp, p);
		})
		.catch(() => {
			/* 落盘失败不崩进程；内存仍为准，下次写会覆盖 */
		});
	writeChains.set(name, next);
	await next;
	if (writeChains.get(name) === next) writeChains.delete(name);
}

/** 优雅关闭时把所有待落盘的写立即刷盘（配合 SIGTERM/SIGINT） */
export async function flushPendingSaves(): Promise<void> {
	await Promise.all([...pendingSaves.keys()].map((n) => flushSave(n)));
	await Promise.all([...writeChains.values()]);
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
