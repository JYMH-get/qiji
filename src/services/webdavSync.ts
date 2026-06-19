/**
 * webdavSync.ts — WebDAV 云端同步服务
 *
 * 提供：连接测试 / 远程文件上传下载 / 目录自动创建 / 超时保护。
 * Qiji 项目文件（.Qiji）+ assets/ 媒体文件通过此模块同步到 WebDAV 服务器。
 */

/* ------------------------------------------------------------------ */
/*  配置类型                                                            */
/* ------------------------------------------------------------------ */

export interface WebdavConfig {
  /** WebDAV 服务器根地址，如 https://dav.jianguoyun.com/ */
  url: string;
  /** 远程目录，如 /qiji-projects */
  directory: string;
  username: string;
  password: string;
}

export interface WebdavSyncStatus {
  ok: boolean;
  message: string;
  /** 上次同步时间 */
  lastSyncAt?: string;
}

/* ------------------------------------------------------------------ */
/*  常量                                                                */
/* ------------------------------------------------------------------ */

const REQUEST_TIMEOUT_MS = 120_000;
const ensuredDirectories = new Set<string>();

/* ------------------------------------------------------------------ */
/*  公共 API                                                           */
/* ------------------------------------------------------------------ */

/** 测试 WebDAV 连接（PROPFIND Depth:0） */
export async function testConnection(config: WebdavConfig): Promise<void> {
  assertConfig(config);
  await ensureDirectory(config, config.directory);
  const res = await webdavFetch(config, "", { method: "PROPFIND", headers: { Depth: "0" } });
  if (res.ok || res.status === 207) return;
  await throwError(res, "WebDAV 连接测试失败");
}

/** 上传项目文件（project.Qiji JSON） */
export async function uploadProjectFile(
  config: WebdavConfig,
  projectFileName: string,
  content: string,
): Promise<void> {
  assertConfig(config);
  const blob = new Blob([content], { type: "application/json" });
  await uploadFile(config, projectFileName, blob, "application/json");
}

/** 下载项目文件，不存在返回 null */
export async function downloadProjectFile(
  config: WebdavConfig,
  projectFileName: string,
): Promise<string | null> {
  assertConfig(config);
  const res = await webdavFetch(config, projectFileName, { method: "GET" });
  if (res.status === 404) return null;
  if (!res.ok) await throwError(res, "下载项目文件失败");
  const text = await withTimeout(res.text(), "下载项目文件超时");
  return text || null;
}

/** 上传媒体资产文件 */
export async function uploadAssetFile(
  config: WebdavConfig,
  assetPath: string,
  blob: Blob,
  contentType = "application/octet-stream",
): Promise<void> {
  assertConfig(config);
  if (!blob.size) return;
  await ensureSubdirectory(config, assetPath);
  await uploadFile(config, assetPath, blob, contentType);
}

/** 下载媒体资产文件，不存在返回 null */
export async function downloadAssetFile(
  config: WebdavConfig,
  assetPath: string,
): Promise<Blob | null> {
  assertConfig(config);
  const res = await webdavFetch(config, assetPath, { method: "GET" });
  if (res.status === 404) return null;
  if (!res.ok) await throwError(res, "下载资产文件失败");
  const blob = await withTimeout(res.blob(), "下载资产文件超时");
  return blob.size ? blob : null;
}

/** 列出远程目录下的文件名列表 */
export async function listRemoteFiles(
  config: WebdavConfig,
  directory?: string,
): Promise<string[]> {
  assertConfig(config);
  const dir = directory ?? config.directory;
  await ensureDirectory(config, dir);
  const res = await webdavFetch(config, dir, {
    method: "PROPFIND",
    headers: { Depth: "1" },
  });
  if (!res.ok && res.status !== 207) await throwError(res, "列出远程文件失败");
  const xml = await withTimeout(res.text(), "读取目录响应超时");
  return parseFileNames(xml);
}

/** 删除远程文件 */
export async function deleteRemoteFile(
  config: WebdavConfig,
  path: string,
): Promise<void> {
  assertConfig(config);
  const res = await webdavFetch(config, path, { method: "DELETE" });
  if (!res.ok && res.status !== 204 && res.status !== 404) {
    await throwError(res, "删除远程文件失败");
  }
}

/* ------------------------------------------------------------------ */
/*  内部实现                                                            */
/* ------------------------------------------------------------------ */

async function uploadFile(
  config: WebdavConfig,
  path: string,
  body: Blob,
  contentType: string,
): Promise<void> {
  await ensureSubdirectory(config, path);
  const res = await webdavFetch(config, path, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body,
  });
  if (!res.ok) await throwError(res, "上传文件失败");
}

async function ensureDirectory(config: WebdavConfig, directory: string): Promise<void> {
  const parts = normalizePath(directory).split("/").filter(Boolean);
  const cacheKey = `${config.url}:${parts.join("/")}`;
  if (ensuredDirectories.has(cacheKey)) return;

  let path = "";
  for (const part of parts) {
    path = path ? `${path}/${part}` : part;
    const res = await webdavFetch({ ...config, directory: "" }, path, { method: "MKCOL" });
    if (res.ok || ((res.status === 405 || res.status === 423) && (await directoryExists(config, path)))) {
      continue;
    }
    await throwError(res, "创建远程目录失败");
  }
  ensuredDirectories.add(cacheKey);
}

async function ensureSubdirectory(config: WebdavConfig, filePath: string): Promise<void> {
  const dir = normalizePath(filePath)
    .split("/")
    .slice(0, -1)
    .join("/");
  if (!dir) return;
  await ensureDirectory(config, [config.directory, dir].filter(Boolean).join("/"));
}

async function directoryExists(config: WebdavConfig, path: string): Promise<boolean> {
  const res = await webdavFetch({ ...config, directory: "" }, path, {
    method: "PROPFIND",
    headers: { Depth: "0" },
  });
  return res.ok || res.status === 207;
}

async function webdavFetch(
  config: WebdavConfig,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (config.username || config.password) {
    headers.set("Authorization", `Basic ${encodeBasicAuth(`${config.username}:${config.password}`)}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const url = buildUrl(config, path);
    return await fetch(url, { ...init, headers, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("WebDAV 请求超时（120s），请检查网络或服务器状态");
    }
    if (error instanceof TypeError) {
      throw new Error("无法连接 WebDAV 服务器，请检查地址、HTTPS 证书或 CORS 配置");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function buildUrl(config: WebdavConfig, path: string): string {
  const baseUrl = config.url.trim().replace(/\/+$/, "");
  const remotePath = [normalizePath(config.directory), normalizePath(path)]
    .filter(Boolean)
    .join("/");
  if (!remotePath) return baseUrl;
  return `${baseUrl}/${remotePath.split("/").map(encodeURIComponent).join("/")}`;
}

function normalizePath(path: string): string {
  return path.trim().replace(/^\/+|\/+$/g, "");
}

function assertConfig(config: WebdavConfig): void {
  if (!config.url.trim()) throw new Error("请先填写 WebDAV 服务器地址");
}

async function throwError(response: Response, fallback: string): Promise<never> {
  const detail = await response.text().catch(() => "");
  if (response.status === 401 || response.status === 403) {
    throw new Error("WebDAV 认证失败，请检查用户名和密码");
  }
  if (response.status === 404) {
    throw new Error("WebDAV 路径不存在，请检查服务器地址和远程目录");
  }
  throw new Error(`${fallback}：${response.status}${detail ? ` ${detail.slice(0, 120)}` : ""}`);
}

function encodeBasicAuth(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), REQUEST_TIMEOUT_MS);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** 简易 XML 解析：提取 <d:href> 中的文件名 */
function parseFileNames(xml: string): string[] {
  const names: string[] = [];
  const regex = /<d:href>([^<]+)<\/d:href>/gi;
  let match;
  while ((match = regex.exec(xml))) {
    const href = decodeURIComponent(match[1]);
    const parts = href.split("/").filter(Boolean);
    if (parts.length > 0) {
      names.push(parts[parts.length - 1]);
    }
  }
  return names;
}