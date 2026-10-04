/** 发布地址是客户端内置契约，换资产桶时仍须保留此 feed。 */
export const CLIENT_UPDATE_FEED = "https://jianqiji.cn-sy1.rains3.com/site/updates/stable.json";
export const CLIENT_UPDATE_KEY = "site/updates/stable.json";
export const CLIENT_UPDATE_PUBKEY = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IENCQjA5OEVCRUVCQzlDNTEKUldSUm5MenU2NWl3eTN5VVFNeWhndTJ3dDZoUEhGN08xSE5OM29TWXFsYkM1ZDRmMHlFRFNFaTEK";
export interface ClientUpdateManifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { url: string; signature: string }>;
}
export function parseClientRelease(value: unknown, currentVersion?: string): ClientUpdateManifest {
  const b = value as Record<string, unknown> | null;
  if (!b || typeof b !== "object") throw new Error("更新信息不能为空");
  const version = typeof b.version === "string" ? b.version.trim() : "";
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("正式版本号须为 x.y.z，例如 2.0.2");
  if (version.split(".").some(n => !Number.isSafeInteger(Number(n)))) throw new Error("版本号过大");
  if (currentVersion) {
    const previous = currentVersion.split(".").map(Number);
    const next = version.split(".").map(Number);
    const delta = next.map((n,i) => n - previous[i]).find(n => n !== 0) ?? 0;
    if (delta <= 0) throw new Error("新版本必须高于已发布版本；同版本重打包不会触发更新");
  }
  const rawUrl = typeof b.url === "string" ? b.url : "";
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("安装包地址无效"); }
  const feed = new URL(CLIENT_UPDATE_FEED);
  if (url.origin !== feed.origin || !/^\/site\/pkg\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.exe$/.test(url.pathname)
    || url.username || url.password || url.search || url.hash) throw new Error("请选择直传到更新存储桶的 Windows 安装包（.exe）");
  const signature = typeof b.signature === "string" ? b.signature.trim() : "";
  if (!signature || signature.length > 4096 || !/^[A-Za-z0-9+/=]+$/.test(signature)) throw new Error("请导入安装包对应的 .sig 签名文件");
  const lines = Buffer.from(signature, "base64").toString("utf8").trim().split(/\r?\n/);
  const sig = Buffer.from(lines[1] || "", "base64");
  const pub = Buffer.from(Buffer.from(CLIENT_UPDATE_PUBKEY, "base64").toString("utf8").trim().split(/\r?\n/)[1], "base64");
  if (lines.length !== 4 || !lines[0].startsWith("untrusted comment:") || !lines[2].startsWith("trusted comment:")
    || sig.length !== 74 || !sig.subarray(2, 10).equals(pub.subarray(2, 10)) || Buffer.from(lines[3], "base64").length !== 64) {
    throw new Error("签名格式或签名密钥不匹配，请使用正式打包脚本生成的签名");
  }
  return { version, notes: typeof b.notes === "string" ? b.notes.slice(0, 10_000) : "",
    pub_date: new Date().toISOString(), platforms: { "windows-x86_64": { url: url.href, signature } } };
}
