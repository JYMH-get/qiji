import type { FastifyInstance } from "fastify";
import { createHash, createPublicKey, verify } from "node:crypto";
import { CLIENT_UPDATE_FEED, CLIENT_UPDATE_KEY, CLIENT_UPDATE_PUBKEY, parseClientRelease, type ClientUpdateManifest } from "../clientUpdateManifest.ts";
import { loadJson, saveJson } from "../store/db.ts";
import { getProfiles } from "../store/storage.ts";
import { ossPut } from "../store/oss.ts";

export function clientUpdateProfile() {
  const base = CLIENT_UPDATE_FEED.slice(0, -(`/` + CLIENT_UPDATE_KEY).length);
  const profile = Object.values(getProfiles()).find(p => p.publicBase.replace(/\/+$/, "") === base && p.writable);
  if (!profile) throw new Error("更新存储桶未配置或不可写；必须保留客户端内置更新地址对应的存储档");
  return profile;
}

/** 挂在源站已有管理员鉴权作用域内，渠道商/公共接口不可发布更新。 */
export function registerClientUpdateAdmin(api: FastifyInstance) {
  let publishing = false;
  api.get("/admin-api/client-update", async () => ({
    feedUrl: CLIENT_UPDATE_FEED, release: loadJson<ClientUpdateManifest | null>("client-update.json", null),
  }));
  api.post("/admin-api/client-update", async (req, reply) => {
    if (publishing) return reply.code(409).send({ error: { message: "另一个更新正在发布，请稍后再试" } });
    publishing = true;
    try {
      const previous = loadJson<ClientUpdateManifest | null>("client-update.json", null);
      const manifest = parseClientRelease(req.body, previous?.version);
      const profile = clientUpdateProfile();
      const artifact = manifest.platforms["windows-x86_64"];
      // 发布前流式校验安装包签名，避免错选 .sig 后向全部客户端推送无效包。
      const res = await fetch(artifact.url, { redirect: "error", signal: AbortSignal.timeout(30 * 60_000) });
      if (!res.ok || !res.body) throw new Error("无法读取刚上传的安装包，请确认上传已完成");
      const hash = createHash("blake2b512");
      let size = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > 2 * 1024 ** 3) throw new Error("更新安装包超过 2 GB");
        hash.update(chunk);
      }
      if (!size) throw new Error("安装包为空");
      const lines = Buffer.from(artifact.signature, "base64").toString("utf8").trim().split(/\r?\n/);
      const sig = Buffer.from(lines[1], "base64");
      const pub = Buffer.from(Buffer.from(CLIENT_UPDATE_PUBKEY, "base64").toString("utf8").trim().split(/\r?\n/)[1], "base64");
      const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub.subarray(10)]), format: "der", type: "spki" });
      if (sig.subarray(0, 2).toString() !== "ED" || !verify(null, hash.digest(), key, sig.subarray(10))
        || !verify(null, Buffer.concat([sig.subarray(10), Buffer.from(lines[2].slice("trusted comment: ".length))]), key, Buffer.from(lines[3], "base64"))) {
        throw new Error("安装包签名校验失败，请选择同一次打包生成的 .exe 和 .sig");
      }
      // 历史不可变副本先写，最后覆盖 stable 原子切换；源站保留上一份供运维回溯。
      await ossPut(`site/updates/history/${manifest.version}.json`, Buffer.from(JSON.stringify(manifest)), "application/json", profile);
      if (previous) saveJson("client-update.previous.json", previous);
      await ossPut(CLIENT_UPDATE_KEY, Buffer.from(JSON.stringify(manifest)), "application/json", profile, "no-cache, max-age=0");
      saveJson("client-update.json", manifest);
      return { ok: true, feedUrl: CLIENT_UPDATE_FEED, release: manifest };
    } catch (e) {
      return reply.code(400).send({ error: { message: e instanceof Error ? e.message : "发布失败" } });
    } finally { publishing = false; }
  });
}
