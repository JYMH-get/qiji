#!/usr/bin/env node
/** 独立官网 CLI：显式配置输入，全新输出目录，不读取业务 store，不覆盖已有文件。 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import { buildWebsiteFiles } from "../website/render.ts";

const HELP = `用法：node scripts/build-website.mjs --config <公开配置.json> [--out <全新输出目录>]

需要 Node.js 24 或更新版本。配置可为网页管理导出的公开配置或原始 site.json。
输出目录中 public/ 可直接部署到静态站；qiji-website.zip 解压后内容相同。
默认输出到 outputs/website-<时间>-<随机标识>。已有目录一律拒绝覆盖。`;

async function main() {
	const options = {};
	const args = process.argv.slice(2);
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
		console.log(HELP);
		return;
	}
	for (let i = 0; i < args.length; i++) {
		const key = args[i];
		if ((key !== "--config" && key !== "--out") || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith("--")) {
			throw new Error(`参数无效：${key}\n${HELP}`);
		}
		options[key] = args[++i];
	}
	if (!options["--config"]) throw new Error(`必须显式提供 --config，避免误用本机业务配置。\n${HELP}`);
	const configPath = resolve(options["--config"]);
	const config = JSON.parse(await readFile(configPath, "utf8"));
	if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("配置文件顶层必须是 JSON 对象。");
	const root = fileURLToPath(new URL("../", import.meta.url));
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const output = options["--out"] ? resolve(options["--out"]) : join(root, "outputs", `website-${stamp}-${randomUUID().slice(0, 8)}`);
	const dataRelative = relative(join(root, "server", "data"), output);
	if (dataRelative === "" || (!dataRelative.startsWith("..") && !isAbsolute(dataRelative))) {
		throw new Error("输出目录不能位于 server/data 内。");
	}
	const files = await buildWebsiteFiles(config);
	const zip = new JSZip();
	for (const file of files) zip.file(file.path, file.data);
	const zipData = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
	await mkdir(dirname(output), { recursive: true });
	try {
		await mkdir(output); // 不使用 recursive：包括空目录在内的已有目标都拒绝覆盖。
	} catch (error) {
		if (error.code === "EEXIST") throw new Error(`输出目录已存在，未写入：${output}`);
		throw error;
	}
	const publicDir = join(output, "public");
	await mkdir(join(publicDir, "site-assets"), { recursive: true });
	for (const file of files) await writeFile(join(publicDir, file.path), file.data, { flag: "wx" });
	const archive = join(output, "qiji-website.zip");
	await writeFile(archive, zipData, { flag: "wx" });
	console.log(JSON.stringify({ output, publicDir, archive, files: files.length }, null, 2));
}

main().catch((error) => {
	console.error(`官网构建失败：${error.message}`);
	process.exitCode = 1;
});
