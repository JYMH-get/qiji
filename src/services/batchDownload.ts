/**
 * 批量下载（第232轮）——把服务端清单里的产物并发抓到用户选定的文件夹。
 *
 * 为什么需要它：转存 OSS 失败时服务端会回退**上游原链**完成任务（绝不整单报废，第158轮），
 * 那些产物没有永久直链、也不在资产台账里，用户只能一个个手点。这里做的就是「一键全抓下来」。
 *
 * ⚠ 时效性是这件事的核心约束：各家原链 2~24 小时不等（火山 24h、简梦Z 图片约 2h…），
 *   清单里的 `expiryRisk` 就是这么来的——**新的先抓**，所以下载顺序严格按清单顺序（服务端已按时间倒序）。
 *
 * ⚠ `authRequired` 的条目直连必然失败（下载须带上游密钥，而密钥绝不外发）——这里**直接跳过并如实计入**，
 *   不做无谓重试，也不假装成功。
 *
 * 落盘走 Rust `download_to`（流式写入 + `.part` 临时文件 + 完成才 rename）：
 * 中断不会留下半截文件冒充成品，重跑能正确「只补没下到的」。
 */
import { invoke } from "@tauri-apps/api/core";
import type { DownloadItem } from "@/contract";

export interface BatchDownloadProgress {
	/** 已处理（成功 + 跳过 + 失败） */
	done: number;
	total: number;
	ok: number;
	/** 目标已存在而跳过（续跑） */
	skipped: number;
	/** 需服务端代下而跳过（直连下不了） */
	blocked: number;
	failed: number;
	/** 累计落盘字节 */
	bytes: number;
	/** 当前正在下的文件（展示用） */
	current?: string;
}

export interface BatchDownloadFailure {
	item: DownloadItem;
	error: string;
}

export interface BatchDownloadResult extends BatchDownloadProgress {
	failures: BatchDownloadFailure[];
	/** 被用户中途取消 */
	cancelled: boolean;
}

export interface BatchDownloadOptions {
	/** 目标根目录（用户选的文件夹绝对路径） */
	root: string;
	/** 并发数（默认 4；再高对上游 CDN 不友好，且大文件内存/磁盘争用得不偿失） */
	concurrency?: number;
	/** 单个文件超时秒数（默认 600——成片可能几百 MB） */
	timeoutSecs?: number;
	/** 目标已存在且非空则跳过（默认 true：重跑只补没下到的） */
	skipExisting?: boolean;
	/** 失败重试次数（默认 1；瞬时网络抖动值得再试一次，403/404 这类重试也没用但代价极小） */
	retries?: number;
	onProgress?: (p: BatchDownloadProgress) => void;
	/** 返回 true 即中止（用户点取消） */
	shouldStop?: () => boolean;
}

/** 拼绝对路径：root + 清单给的相对路径（清单侧已做过文件名安全化） */
function joinPath(root: string, rel: string): string {
	const r = root.replace(/[\\/]+$/, "");
	const sep = r.includes("\\") ? "\\" : "/";
	return r + sep + rel.split("/").join(sep);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 跑一批下载。返回汇总结果（含失败清单——失败项如实列出，绝不吞）。
 * 顺序即清单顺序（新的先抓），并发由 concurrency 控制。
 */
export async function runBatchDownload(items: DownloadItem[], opts: BatchDownloadOptions): Promise<BatchDownloadResult> {
	const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, 16));
	const retries = Math.max(0, opts.retries ?? 1);
	const skipExisting = opts.skipExisting !== false;
	const failures: BatchDownloadFailure[] = [];
	const p: BatchDownloadProgress = { done: 0, total: items.length, ok: 0, skipped: 0, blocked: 0, failed: 0, bytes: 0 };
	let cancelled = false;
	let cursor = 0;

	const report = () => opts.onProgress?.({ ...p });

	async function worker() {
		for (;;) {
			if (opts.shouldStop?.()) {
				cancelled = true;
				return;
			}
			const i = cursor++;
			if (i >= items.length) return;
			const it = items[i];

			// 直连下不了的（须带上游密钥）：如实跳过，不做无谓重试
			if (it.authRequired) {
				p.blocked++;
				p.done++;
				report();
				continue;
			}

			const dest = joinPath(opts.root, it.suggestedPath);
			p.current = it.suggestedPath;
			let lastErr = "";
			for (let attempt = 0; attempt <= retries; attempt++) {
				if (opts.shouldStop?.()) {
					cancelled = true;
					return;
				}
				try {
					const r = await invoke<{ bytes: number; skipped: boolean }>("download_to", {
						url: it.url,
						dest,
						timeoutSecs: opts.timeoutSecs ?? 600,
						skipExisting,
					});
					if (r.skipped) p.skipped++;
					else {
						p.ok++;
						p.bytes += r.bytes;
					}
					lastErr = "";
					break;
				} catch (e) {
					lastErr = e instanceof Error ? e.message : String(e);
					if (attempt < retries) await sleep(800 * (attempt + 1));
				}
			}
			if (lastErr) {
				p.failed++;
				failures.push({ item: it, error: lastErr });
			}
			p.done++;
			report();
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
	report();
	return { ...p, failures, cancelled };
}

/** 人类可读体积 */
export function fmtBytes(n: number): string {
	if (!n) return "0 B";
	const u = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
	return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}
