/**
 * 嵌入式 SQLite（Node 24 内置 node:sqlite，无原生模块、无外部服务）。
 *
 * 用途：承载「无上限增长 + 需按 id 索引查」的数据（首个迁移对象=资产台账 assets）。
 * 相比 JSON 全量读进内存 + 每次插入整文件重写，SQLite 单条索引读写是微秒级、
 * 不阻塞 event loop，且崩溃安全（WAL）。同步 API 在 Fastify 单线程下正合适
 * （要消灭的是「几百 ms 重写大文件」，不是微秒级索引写）。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./db.ts";

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, "qiji.db"));
// WAL：更好的写并发 + 崩溃安全；NORMAL：与 WAL 搭配的耐久/性能平衡；busy_timeout：偶发锁等待
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA busy_timeout = 5000");

/** 优雅关闭：checkpoint WAL 并关闭连接（配合 index.ts 的 SIGTERM/SIGINT） */
export function closeSqlite(): void {
	try {
		db.close();
	} catch {
		/* 已关闭/忽略 */
	}
}
