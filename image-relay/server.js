import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import OSS from 'ali-oss';

// ---------- 配置（全部走环境变量，见 .env.example） ----------
function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`缺少环境变量 ${name}，退出`);
    process.exit(1);
  }
  return v;
}

const PORT = Number(process.env.PORT || 8787);
const TOKEN = required('RELAY_TOKEN');
const OSS_BUCKET = required('OSS_BUCKET');
const OSS_KEY_ID = required('OSS_ACCESS_KEY_ID');
const OSS_KEY_SECRET = required('OSS_ACCESS_KEY_SECRET');
// 传输加速端点：境外节点回传境内 bucket 走阿里云骨干网
const OSS_ENDPOINT = process.env.OSS_ENDPOINT || 'https://oss-accelerate.aliyuncs.com';
// 返回给主服务器的图片访问地址前缀（一般填你们的 CDN 域名）
const PUBLIC_BASE = (process.env.PUBLIC_BASE || '').replace(/\/+$/, '');
// 允许下载的来源域名后缀（逗号分隔）。不配则不限制——强烈建议配置，
// 否则 token 泄露时这个节点就是一台开放代理
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 4);
const MAX_BYTES = Number(process.env.MAX_BYTES || 100 * 1024 * 1024); // 单文件上限 100MB
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS || 30_000); // 空闲超时：30s 没收到新数据才算失败
const DOWNLOAD_ATTEMPTS = 3;

const oss = new OSS({
  accessKeyId: OSS_KEY_ID,
  accessKeySecret: OSS_KEY_SECRET,
  bucket: OSS_BUCKET,
  endpoint: OSS_ENDPOINT,
  secure: true,
  timeout: 120_000,
});

// ---------- 小工具 ----------
function checkToken(req) {
  const got = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function hostAllowed(url) {
  if (ALLOWED_HOSTS.length === 0) return true;
  const host = new URL(url).hostname.toLowerCase();
  return ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h));
}

// 并发闸门：避免同时下载太多大文件把内存打爆
let active = 0;
const waiters = [];
async function withSlot(fn) {
  if (active >= MAX_CONCURRENCY) await new Promise(r => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    const next = waiters.shift();
    if (next) next();
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 下载：空闲超时（只要还在收数据就不断开），限制体积
async function downloadOnce(url) {
  const ac = new AbortController();
  let timer = setTimeout(() => ac.abort(), IDLE_TIMEOUT_MS);
  const bump = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ac.abort(), IDLE_TIMEOUT_MS);
  };
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`来源返回 HTTP ${res.status}`);
    if (!res.body) throw new Error('来源响应无内容');
    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      bump();
      total += chunk.length;
      if (total > MAX_BYTES) {
        ac.abort();
        throw new Error(`文件超过上限 ${MAX_BYTES} 字节`);
      }
      chunks.push(Buffer.from(chunk));
    }
    return { buffer: Buffer.concat(chunks), contentType };
  } finally {
    clearTimeout(timer);
  }
}

async function downloadWithRetry(url) {
  let lastErr;
  for (let i = 1; i <= DOWNLOAD_ATTEMPTS; i++) {
    try {
      return await downloadOnce(url);
    } catch (err) {
      lastErr = err;
      console.warn(`下载失败（第 ${i}/${DOWNLOAD_ATTEMPTS} 次）: ${err.message}`);
      if (i < DOWNLOAD_ATTEMPTS) await sleep(i * 1500);
    }
  }
  throw lastErr;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 64 * 1024) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// ---------- HTTP 服务 ----------
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    return send(res, 200, { ok: true, active, ts: Date.now() });
  }

  if (req.method !== 'POST' || req.url !== '/fetch') {
    return send(res, 404, { ok: false, error: 'not found' });
  }
  if (!checkToken(req)) {
    return send(res, 401, { ok: false, error: 'unauthorized' });
  }

  const started = Date.now();
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (err) {
    return send(res, 400, { ok: false, error: err.message });
  }

  const { url, key } = payload || {};
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return send(res, 400, { ok: false, error: 'url 必须是 http(s) 地址' });
  }
  if (typeof key !== 'string' || !key || key.startsWith('/') || key.includes('..')) {
    return send(res, 400, { ok: false, error: 'key 非法' });
  }
  if (!hostAllowed(url)) {
    return send(res, 403, { ok: false, error: '来源域名不在允许列表' });
  }

  try {
    const result = await withSlot(async () => {
      const { buffer, contentType } = await downloadWithRetry(url);
      await oss.put(key, buffer, { mime: contentType });
      return { bytes: buffer.length, contentType };
    });
    const publicUrl = PUBLIC_BASE
      ? `${PUBLIC_BASE}/${key}`
      : `https://${OSS_BUCKET}.${new URL(OSS_ENDPOINT).host}/${key}`;
    const ms = Date.now() - started;
    console.log(`OK ${key} ${result.bytes}B ${ms}ms <- ${new URL(url).hostname}`);
    return send(res, 200, { ok: true, key, url: publicUrl, ...result, ms });
  } catch (err) {
    const ms = Date.now() - started;
    console.error(`FAIL ${key} ${ms}ms: ${err.message}`);
    return send(res, 502, { ok: false, error: err.message, ms });
  }
});

server.listen(PORT, () => {
  console.log(`image-relay 已启动，端口 ${PORT}，并发上限 ${MAX_CONCURRENCY}`);
  if (ALLOWED_HOSTS.length === 0) {
    console.warn('警告：未配置 ALLOWED_HOSTS，任何域名都可被下载，建议尽快配置');
  }
});
