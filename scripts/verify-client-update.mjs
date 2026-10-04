import { createReadStream, readFileSync } from "node:fs";
import { createHash, createPublicKey, verify } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const config = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
const args = process.argv.slice(2);
if (!args.length) throw new Error("请指定需要验证的安装包路径");
const keyLines = Buffer.from(config.plugins.updater.pubkey, "base64").toString().trim().split(/\r?\n/);
const pub = Buffer.from(keyLines[1], "base64");
const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub.subarray(10)]), format: "der", type: "spki" });
for (const path of args) {
  const lines = Buffer.from(readFileSync(`${path}.sig`, "utf8").trim(), "base64").toString().trim().split(/\r?\n/);
  const signature = Buffer.from(lines[1] || "", "base64");
  if (signature.length !== 74 || signature.subarray(0, 2).toString() !== "ED" || !signature.subarray(2, 10).equals(pub.subarray(2, 10))) throw new Error(`签名密钥不匹配：${path}`);
  const hash = createHash("blake2b512");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  if (!bytes || !verify(null, hash.digest(), key, signature.subarray(10))
    || !verify(null, Buffer.concat([signature.subarray(10), Buffer.from(lines[2].slice("trusted comment: ".length))]), key, Buffer.from(lines[3], "base64"))) throw new Error(`签名验证失败：${path}`);
  console.log(`签名通过：${path} (${bytes} bytes)`);
}
