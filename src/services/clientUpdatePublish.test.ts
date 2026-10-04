import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "../../server/node_modules/fastify/fastify";
import { CLIENT_UPDATE_FEED, parseClientRelease } from "../../server/src/clientUpdateManifest";
import { registerClientUpdateAdmin } from "../../server/src/routes/clientUpdate";

const signedText = "Qiji updater signature fixture";
const signature = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSUm5MenU2NWl3eXlIQ0gzbE5wRlBNdWQ3TE1NU2JQU1FmaE9qeThpRnFnZm9FWUIzbUFNaFB6UVd3WFN2K2lTaDI5VUtoZUUrTDlzdEY5VlhIaEdBRllsQUZxTzQ1YkFnPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzg5MzMzMTg3CWZpbGU6c2lnbmF0dXJlLWZpeHR1cmUudHh0Cnl5RmtsNVowYkVsdFpGVnVqMG9YRDR6SmllQXo1dTY4NGFGL3ZFTEhKWDg1b2NKV0wvTDBsSTJCSnpSK2xGMmxZT09NUzRqNU1IdTRsYjA3K29GWUFBPT0K";
const body = () => ({ version: "2.0.2", signature, url: "https://jianqiji.cn-sy1.rains3.com/site/pkg/123-Qiji_2.0.2_x64-setup.exe", notes: "测试更新" });
const mocks = vi.hoisted(() => ({ files: new Map<string, unknown>(), put: vi.fn() }));
vi.mock("../../server/src/store/db.ts", () => ({ loadJson: (name: string, fallback: unknown) => mocks.files.get(name) ?? fallback, saveJson: (name: string, value: unknown) => mocks.files.set(name, value) }));
vi.mock("../../server/src/store/storage.ts", () => ({ getProfiles: () => ({ sy1: { publicBase: "https://jianqiji.cn-sy1.rains3.com", writable: true } }) }));
vi.mock("../../server/src/store/oss.ts", () => ({ ossPut: (...args: unknown[]) => mocks.put(...args) }));

describe("客户端更新发布与签名校验", () => {
  beforeEach(() => {
    mocks.files.clear(); mocks.put.mockReset().mockResolvedValue(CLIENT_UPDATE_FEED);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(signedText)));
  });
  it("拒绝同版本、降级、无效版本及外部/HTTP/带鉴权的下载地址", () => {
    for (const version of ["2.0.2", "2.0.1", "1.9.9"]) expect(() => parseClientRelease({ ...body(), version }, "2.0.2")).toThrow();
    for (const version of ["latest", "02.0.2", "2.0.2-beta"]) expect(() => parseClientRelease({ ...body(), version })).toThrow();
    for (const url of ["http://jianqiji.cn-sy1.rains3.com/site/pkg/a.exe", "https://evil.example/a.exe", body().url + "?secret=x", body().url.replace("https://", "https://user:pass@")]) expect(() => parseClientRelease({ ...body(), url })).toThrow();
    expect(parseClientRelease(body(), "2.0.1").version).toBe("2.0.2");
  });
  it("拒绝缺签名、错误密钥和非安装包 URL", () => {
    for (const sig of ["", "garbage", Buffer.from("fake signature").toString("base64")]) expect(() => parseClientRelease({ ...body(), signature: sig })).toThrow();
    expect(() => parseClientRelease({ ...body(), url: body().url.replace(".exe", ".json") })).toThrow();
  });
  it("真实 Tauri 签名通过，先保存历史再原子切换 feed", async () => {
    const app = Fastify(); registerClientUpdateAdmin(app);
    try {
      const r = await app.inject({ method: "POST", url: "/admin-api/client-update", payload: body() });
      expect(r.statusCode, r.body).toBe(200);
      expect(mocks.put.mock.calls.map(c => c[0])).toEqual(["site/updates/history/2.0.2.json", "site/updates/stable.json"]);
      expect(mocks.put.mock.calls[1][4]).toBe("no-cache, max-age=0");
      expect(mocks.files.get("client-update.json")).toMatchObject({ version: "2.0.2" });
    } finally { await app.close(); }
  });
  it("安装包篡改拒绝发布、保留原 feed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("tampered")));
    const app = Fastify(); registerClientUpdateAdmin(app);
    try {
      const r = await app.inject({ method: "POST", url: "/admin-api/client-update", payload: body() });
      expect(r.statusCode).toBe(400); expect(r.body).toContain("签名校验失败"); expect(mocks.put).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it("上传对象不存在拒绝发布", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    const app = Fastify(); registerClientUpdateAdmin(app);
    try { expect((await app.inject({ method: "POST", url: "/admin-api/client-update", payload: body() })).statusCode).toBe(400); expect(mocks.put).not.toHaveBeenCalled(); }
    finally { await app.close(); }
  });
});
