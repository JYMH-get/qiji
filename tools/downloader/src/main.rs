//! Qiji 批量下载器（第232轮）
//!
//! 吃管理端「批量下载」页导出的 JSON 清单，把产物并发抓到本地。
//!
//! 为什么需要它：服务端转存 OSS 失败时会回退**上游原链**完成任务（绝不整单报废，第158轮），
//! 那些产物没有永久直链、也不在资产台账里——只能从请求记录里捞出来批量抓。
//!
//! ⚠ 原链有时效（各家 2~24 小时不等），清单按时间倒序、本工具按清单顺序下载：**新的先抓**。
//! ⚠ 标了 `authRequired` 的条目下载须带上游密钥（密钥绝不外发），直连必然失败 →
//!   默认跳过并如实计入，不做无谓重试。真要试可加 `--include-blocked`。
//!
//! 用法：
//!   qiji-downloader --manifest <清单.json> --out <目标目录> [选项]
//!
//! 选项：
//!   --concurrency N     并发数（默认 4，上限 16）
//!   --retries N         每个文件重试次数（默认 2）
//!   --timeout N         单文件超时秒数（默认 600）
//!   --overwrite         覆盖已存在的文件（默认跳过——重跑只补没下到的）
//!   --include-blocked   连需服务端代下的条目也试一下（默认跳过；基本会 401/403）
//!   --只下原链 / --raw-only   只下 storage=raw 的条目
//!   --dry-run           只列要做什么，不下载
//!
//! 失败清单会写到 `<目标目录>/_failed.json`，格式与输入清单相同——
//! **直接拿它当 --manifest 再跑一次即可只重试失败项**。

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Item {
    #[serde(default)]
    #[serde(rename = "logId")]
    log_id: String,
    #[serde(default)]
    user: String,
    #[serde(default)]
    #[serde(rename = "startedAt")]
    started_at: String,
    #[serde(default)]
    #[serde(rename = "purposeLabel")]
    purpose_label: String,
    #[serde(default)]
    model: String,
    url: String,
    #[serde(default)]
    storage: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    #[serde(rename = "authRequired")]
    auth_required: bool,
    #[serde(default)]
    #[serde(rename = "expiryRisk")]
    expiry_risk: String,
    #[serde(rename = "suggestedPath")]
    suggested_path: String,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    #[serde(default)]
    total: usize,
    #[serde(default)]
    truncated: bool,
    #[serde(default)]
    matched: usize,
    #[serde(default)]
    #[serde(rename = "authRequired")]
    #[allow(dead_code)] // 只为完整承接清单形状，实际按 item.auth_required 逐条判定
    auth_required: usize,
    items: Vec<Item>,
}

/// 与输入同形状，便于「失败清单直接当输入重跑」
#[derive(Serialize)]
struct FailedManifest<'a> {
    generated_at: String,
    total: usize,
    truncated: bool,
    matched: usize,
    #[serde(rename = "authRequired")]
    auth_required: usize,
    items: Vec<&'a Item>,
    /// 每项的失败原因（与 items 同序），仅供人看
    errors: Vec<String>,
}

struct Opts {
    manifest: PathBuf,
    out: PathBuf,
    concurrency: usize,
    retries: usize,
    timeout: u64,
    overwrite: bool,
    include_blocked: bool,
    raw_only: bool,
    dry_run: bool,
}

fn usage() -> ! {
    eprintln!(
        r#"Qiji 批量下载器

用法：
  qiji-downloader --manifest <清单.json> --out <目标目录> [选项]

选项：
  --concurrency N     并发数（默认 4，上限 16）
  --retries N         每个文件重试次数（默认 2）
  --timeout N         单文件超时秒数（默认 600）
  --overwrite         覆盖已存在的文件（默认跳过，重跑只补没下到的）
  --include-blocked   连「需服务端代下」的条目也试（默认跳过，基本会 401/403）
  --raw-only          只下上游原链（storage=raw）——它们才是会过期、要抢救的
  --dry-run           只列要做什么，不真的下载

失败清单写在 <目标目录>/_failed.json，可直接当 --manifest 再跑一次只重试失败项。"#
    );
    std::process::exit(2)
}

fn parse_args() -> Opts {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut manifest = None;
    let mut out = None;
    let mut concurrency = 4usize;
    let mut retries = 2usize;
    let mut timeout = 600u64;
    let mut overwrite = false;
    let mut include_blocked = false;
    let mut raw_only = false;
    let mut dry_run = false;
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        let next = |i: &mut usize| -> String {
            *i += 1;
            args.get(*i).cloned().unwrap_or_else(|| usage())
        };
        match a {
            "--manifest" | "-m" => manifest = Some(PathBuf::from(next(&mut i))),
            "--out" | "-o" => out = Some(PathBuf::from(next(&mut i))),
            "--concurrency" | "-c" => concurrency = next(&mut i).parse().unwrap_or(4),
            "--retries" => retries = next(&mut i).parse().unwrap_or(2),
            "--timeout" => timeout = next(&mut i).parse().unwrap_or(600),
            "--overwrite" => overwrite = true,
            "--include-blocked" => include_blocked = true,
            "--raw-only" => raw_only = true,
            "--dry-run" => dry_run = true,
            "--help" | "-h" => usage(),
            _ => {
                eprintln!("未知参数：{a}");
                usage()
            }
        }
        i += 1;
    }
    Opts {
        manifest: manifest.unwrap_or_else(|| usage()),
        out: out.unwrap_or_else(|| usage()),
        concurrency: concurrency.clamp(1, 16),
        retries,
        timeout: timeout.clamp(5, 3600),
        overwrite,
        include_blocked,
        raw_only,
        dry_run,
    }
}

/// 清单里的相对路径拼到目标根下。
/// ⚠ 防目录穿越：清单是服务端生成的，但它毕竟是一份可被手改的文件——
///   `..` 段一律剔除，绝不让下载写到目标目录之外。
fn dest_of(root: &Path, rel: &str) -> PathBuf {
    let mut p = root.to_path_buf();
    for seg in rel.split(['/', '\\']) {
        if seg.is_empty() || seg == "." || seg == ".." {
            continue;
        }
        p.push(seg);
    }
    p
}

fn fmt_bytes(n: u64) -> String {
    const U: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    if n == 0 {
        return "0 B".into();
    }
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < U.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{} {}", n, U[0])
    } else {
        format!("{v:.1} {}", U[i])
    }
}

async fn download_one(client: &reqwest::Client, it: &Item, dest: &Path, timeout: u64) -> Result<u64, String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("建目录失败：{e}"))?;
    }
    let resp = client
        .get(&it.url)
        .timeout(std::time::Duration::from_secs(timeout))
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    // 先写 .part，完成才 rename：中断不会留下半截文件冒充成品（下次 --skip 才判得准）
    let part = PathBuf::from(format!("{}.part", dest.display()));
    let mut f = std::fs::File::create(&part).map_err(|e| format!("创建文件失败：{e}"))?;
    let mut written = 0u64;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&part);
                return Err(format!("读取字节失败：{e}"));
            }
        };
        if let Err(e) = f.write_all(&chunk) {
            let _ = std::fs::remove_file(&part);
            return Err(format!("写入失败：{e}"));
        }
        written += chunk.len() as u64;
    }
    f.flush().map_err(|e| format!("落盘失败：{e}"))?;
    drop(f);
    let _ = std::fs::remove_file(dest); // Windows 上 rename 到已存在的路径会失败
    std::fs::rename(&part, dest).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        format!("重命名失败：{e}")
    })?;
    Ok(written)
}

#[tokio::main]
async fn main() {
    let o = parse_args();

    let raw = match std::fs::read_to_string(&o.manifest) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("读不到清单 {}：{e}", o.manifest.display());
            std::process::exit(1);
        }
    };
    let manifest: Manifest = match serde_json::from_str(&raw) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("清单不是有效的 JSON（应为管理端「导出清单 JSON」的产物）：{e}");
            std::process::exit(1);
        }
    };

    // ⚠ 服务端命中上限截断时如实告知——不提醒的话用户会以为已经全下了
    if manifest.truncated {
        eprintln!(
            "⚠ 这份清单是被截断的：服务端匹配到 {} 个，清单里只有 {} 个。\n  请回管理端缩小时间范围分批导出，否则会漏掉一部分。\n",
            manifest.matched, manifest.total
        );
    }

    let mut items: Vec<Item> = manifest.items;
    if o.raw_only {
        items.retain(|i| i.storage == "raw");
    }
    let total_all = items.len();
    let blocked: Vec<Item> = if o.include_blocked {
        Vec::new()
    } else {
        let (b, keep): (Vec<Item>, Vec<Item>) = items.into_iter().partition(|i| i.auth_required);
        items = keep;
        b
    };

    println!("清单 {} 个待处理{}", total_all, if o.raw_only { "（已按 --raw-only 只保留上游原链）" } else { "" });
    if !blocked.is_empty() {
        println!(
            "  其中 {} 个需服务端代下（下载须带上游密钥，直连必然失败）→ 已跳过。要强行试加 --include-blocked",
            blocked.len()
        );
    }
    let expired = items.iter().filter(|i| i.expiry_risk == "expired").count();
    if expired > 0 {
        println!("  其中 {expired} 个原链已超 24 小时，大概率已失效——失败属预期，会列在 _failed.json 里");
    }
    println!("目标目录：{}", o.out.display());
    println!("并发 {} · 重试 {} · 超时 {}s · {}\n", o.concurrency, o.retries, o.timeout,
        if o.overwrite { "覆盖已存在" } else { "跳过已存在" });

    if o.dry_run {
        for it in items.iter().take(20) {
            println!("  [dry] {} → {}", it.url, dest_of(&o.out, &it.suggested_path).display());
        }
        if items.len() > 20 {
            println!("  …另有 {} 个", items.len() - 20);
        }
        println!("\n--dry-run：未下载任何文件");
        return;
    }

    if let Err(e) = std::fs::create_dir_all(&o.out) {
        eprintln!("建目标目录失败：{e}");
        std::process::exit(1);
    }

    let client = reqwest::Client::new();
    let total = items.len();
    let items = Arc::new(items);
    let cursor = Arc::new(AtomicUsize::new(0));
    let ok = Arc::new(AtomicUsize::new(0));
    let skipped = Arc::new(AtomicUsize::new(0));
    let bytes = Arc::new(AtomicU64::new(0));
    let failures = Arc::new(tokio::sync::Mutex::new(Vec::<(usize, String)>::new()));

    let mut handles = Vec::new();
    for _ in 0..o.concurrency.min(total.max(1)) {
        let (client, items, cursor, ok, skipped, bytes, failures) = (
            client.clone(), items.clone(), cursor.clone(), ok.clone(),
            skipped.clone(), bytes.clone(), failures.clone(),
        );
        let out = o.out.clone();
        let (retries, timeout, overwrite) = (o.retries, o.timeout, o.overwrite);
        handles.push(tokio::spawn(async move {
            loop {
                let i = cursor.fetch_add(1, Ordering::SeqCst);
                if i >= items.len() {
                    return;
                }
                let it = &items[i];
                let dest = dest_of(&out, &it.suggested_path);
                if !overwrite {
                    if let Ok(md) = std::fs::metadata(&dest) {
                        if md.len() > 0 {
                            skipped.fetch_add(1, Ordering::Relaxed);
                            println!("[{}/{}] 跳过（已存在） {}", i + 1, items.len(), it.suggested_path);
                            continue;
                        }
                    }
                }
                let mut last_err = String::new();
                for attempt in 0..=retries {
                    match download_one(&client, it, &dest, timeout).await {
                        Ok(n) => {
                            ok.fetch_add(1, Ordering::Relaxed);
                            bytes.fetch_add(n, Ordering::Relaxed);
                            println!("[{}/{}] ✓ {} ({})", i + 1, items.len(), it.suggested_path, fmt_bytes(n));
                            last_err.clear();
                            break;
                        }
                        Err(e) => {
                            last_err = e;
                            if attempt < retries {
                                tokio::time::sleep(std::time::Duration::from_millis(800 * (attempt as u64 + 1))).await;
                            }
                        }
                    }
                }
                if !last_err.is_empty() {
                    println!("[{}/{}] ✗ {} — {}", i + 1, items.len(), it.suggested_path, last_err);
                    failures.lock().await.push((i, last_err));
                }
            }
        }));
    }
    for h in handles {
        let _ = h.await;
    }

    let fails = failures.lock().await;
    let ok_n = ok.load(Ordering::Relaxed);
    let skip_n = skipped.load(Ordering::Relaxed);
    let bytes_n = bytes.load(Ordering::Relaxed);
    println!(
        "\n完成：成功 {} 个（{}）· 跳过已存在 {} · 需代下跳过 {} · 失败 {}",
        ok_n, fmt_bytes(bytes_n), skip_n, blocked.len(), fails.len()
    );

    // 失败清单（含被跳过的「需代下」项）——如实列出，且格式与输入相同可直接重跑
    if !fails.is_empty() || !blocked.is_empty() {
        let mut failed_items: Vec<&Item> = Vec::new();
        let mut errors: Vec<String> = Vec::new();
        let mut sorted: Vec<_> = fails.iter().collect();
        sorted.sort_by_key(|(i, _)| *i);
        for (i, e) in sorted {
            failed_items.push(&items[*i]);
            errors.push(e.clone());
        }
        for b in &blocked {
            failed_items.push(b);
            errors.push("需服务端代下（下载须带上游密钥，直连无法获取）".into());
        }
        let fm = FailedManifest {
            generated_at: String::new(),
            total: failed_items.len(),
            truncated: false,
            matched: failed_items.len(),
            auth_required: blocked.len(),
            items: failed_items,
            errors,
        };
        let path = o.out.join("_failed.json");
        match serde_json::to_string_pretty(&fm).and_then(|s| Ok(std::fs::write(&path, s))) {
            Ok(Ok(())) => println!("失败清单已写入 {}（可直接当 --manifest 再跑一次只重试失败项）", path.display()),
            _ => eprintln!("失败清单写入失败：{}", path.display()),
        }
    }

    if !fails.is_empty() {
        std::process::exit(1);
    }
}
