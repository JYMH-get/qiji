/** 官网构建边界验证；合成配置、临时输出，零远程请求。 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Script } from "node:vm";
import JSZip from "jszip";
import { buildWebsiteFiles, renderWebsitePreview, builtinWebsiteImages, WEBSITE_IMAGE_FILES } from "./render.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const config = {
	enabled: true,
	version: "2.0.23", sizeNote: "Windows", downloadUrl: "https://example.com/Qiji.exe", backupUrl: "javascript:alert(1)",
	contacts: { bd: "合作 $& $' $` $$ </script><script>bad()</script>\u2028\u2029", support: "客服", wechat: "", qq: "", secret: "NESTED_PRIVATE" },
	icp: "测试 ICP 备 00000000 号", showStats: false, showChannels: true,
	images: { "logo-full": "https://example.com/brand.svg", "app-icon": "javascript:alert(1)", "unknown": "https://example.com/PRIVATE_IMAGE" },
	announcements: [
		{ id: "off", title: "PRIVATE_DISABLED", body: "HIDDEN_BODY", date: "", enabled: false },
		{ id: "on", title: "公开公告", body: '字面量 "__WEBSITE_BUILTIN_URLS__"', date: "2026-10-07", enabled: true, secret: "PRIVATE_ANNOUNCEMENT" },
	],
	releases: [{ version: "2.0.23", date: "2026-10-07", title: "更新", items: ["变更"], secret: "PRIVATE_RELEASE" }],
	secret: "TOP_LEVEL_PRIVATE",
};

function injected(html, name) {
	const match = html.match(new RegExp(`var ${name} = (.+);`));
	assert.ok(match, `${name} must be embedded`);
	return JSON.parse(match[1]);
}

const original = JSON.stringify(config);
const files = await buildWebsiteFiles(config);
const names = ["index.html", ...Object.values(WEBSITE_IMAGE_FILES).map((name) => `site-assets/${name}`)];
assert.deepEqual(files.map((file) => file.path), names);
assert.equal(JSON.stringify(config), original, "must not mutate input config");
const html = files[0].data.toString("utf8");
const published = injected(html, "SITE");
assert.equal(published.contacts.bd, config.contacts.bd, "special replacement characters remain literal");
assert.equal(published.announcements[0].body, config.announcements[1].body, "injected text cannot replace the next template placeholder");
assert.equal(published.announcements.length, 1);
assert.equal(published.backupUrl, "");
assert.equal(published.images["app-icon"], undefined);
for (const marker of ["PRIVATE", "HIDDEN_BODY", "bad()</script>", "javascript:"]) assert.equal(html.includes(marker), false, marker);
assert.equal(html.includes("\u2028"), false);
assert.equal(html.includes("\u2029"), false);
assert.ok(html.includes("\\u003c/script>"));
assert.equal(published.announcements[0].enabled, undefined);
assert.deepEqual(Object.keys(published.contacts), ["bd", "support", "wechat", "qq"]);
assert.deepEqual(injected(html, "BUILTIN"), Object.fromEntries(Object.entries(WEBSITE_IMAGE_FILES).map(([slot, file]) => [slot, `site-assets/${file}`])));
assert.equal(/fetch\(|XMLHttpRequest|\/admin-api\/|\/v1\//.test(html), false);
assert.equal(/fonts\.google/.test(html), false);
for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(script[1]);

const preview = await renderWebsitePreview(config);
const previewImages = injected(preview, "BUILTIN");
const imageTable = await builtinWebsiteImages();
assert.equal(Object.keys(imageTable).length, 11);
for (const [slot, name] of Object.entries(WEBSITE_IMAGE_FILES)) {
	assert.match(previewImages[slot], /^data:image\//);
	assert.equal(previewImages[slot], imageTable[name]);
	const bytes = Buffer.from(imageTable[name].split(",")[1], "base64");
	assert.deepEqual(bytes, files.find((file) => file.path === `site-assets/${name}`).data);
}
assert.equal(preview.includes("site-assets/"), false, "standalone preview cannot request server assets");

// Run the real routing block with a small DOM boundary. about:srcdoc anchors normally
// resolve against the embedding /admin URL; preview clicks must cancel that navigation.
const routing = html.match(/\/\* ── hash 路由[^\n]*\*\/([\s\S]*?)\/\* ── 界面图/);
assert.ok(routing, "website route script exists");
function routeHarness(href, hash = "") {
	const pages = [...html.matchAll(/<main\b[^>]*data-page="([^"]+)"/g)].map((match) => ({
		dataset: { page: match[1] }, hidden: false,
		classList: { toggle(_name, hidden) { this.owner.hidden = hidden; } },
	}));
	for (const page of pages) page.classList.owner = page;
	const links = [...html.matchAll(/<a\b[^>]*href="(#[^"]+)"[^>]*>/g)].map((match) => ({
		href: match[1], dataset: { nav: match[0].match(/data-nav="([^"]+)"/)?.[1] }, style: {},
		getAttribute(name) { return name === "href" ? this.href : null; },
		addEventListener(name, callback) { this[name] = callback; },
	}));
	const location = { href, hash };
	const events = {};
	new Script(routing[1]).runInNewContext({
		location,
		document: { querySelectorAll(selector) {
			if (selector === "main.page") return pages;
			if (selector === "a[data-nav]") return links.filter((link) => link.dataset.nav);
			if (selector === 'a[href^="#"]') return links;
			throw new Error(`Unexpected route selector: ${selector}`);
		} },
		window: { scrollTo() {}, addEventListener(name, callback) { events[name] = callback; } },
	});
	return { pages, links, location, events, visible: () => pages.filter((page) => !page.hidden).map((page) => page.dataset.page) };
}
const srcdoc = routeHarness("about:srcdoc");
assert.deepEqual(srcdoc.visible(), ["home"]);
assert.deepEqual(srcdoc.links.filter((link) => link.dataset.nav).map((link) => link.dataset.nav), ["home", "features", "download", "join", "changelog"]);
for (const link of srcdoc.links) {
	let prevented = false;
	assert.equal(typeof link.click, "function", `srcdoc route click registered: ${link.href}`);
	link.click({ preventDefault() { prevented = true; } });
	assert.equal(prevented, true, `srcdoc route cannot navigate into parent /admin: ${link.href}`);
	assert.deepEqual(srcdoc.visible(), [link.href.slice(1)]);
	assert.equal(srcdoc.location.href, "about:srcdoc");
	assert.equal(srcdoc.location.hash, "");
}
const staticRoutes = routeHarness("https://website.example/index.html#join", "#join");
assert.deepEqual(staticRoutes.visible(), ["join"], "static deep links still open the selected page");
for (const link of staticRoutes.links) {
	assert.equal(link.click, undefined, "static anchors keep normal browser navigation");
	staticRoutes.location.hash = link.href;
	staticRoutes.events.hashchange();
	assert.deepEqual(staticRoutes.visible(), [link.href.slice(1)]);
}

const closed = (await buildWebsiteFiles({ ...config, enabled: false, icp: '<img src=x onerror=bad()> $&' }))[0].data.toString();
assert.ok(closed.includes("官网维护中"));
assert.ok(closed.includes('href="https://beian.miit.gov.cn/"'));
assert.ok(closed.includes("&lt;img src=x onerror=bad()&gt; $&"));
assert.equal(closed.includes(config.downloadUrl), false);
const closedWithoutIcp = await renderWebsitePreview({ ...config, enabled: false, icp: " " });
assert.equal(closedWithoutIcp.includes("beian.miit.gov.cn"), false);

const temporary = await mkdtemp(join(tmpdir(), "qiji-website-verify-"));
try {
	const configPath = join(temporary, "site.json");
	const output = join(temporary, "release");
	await writeFile(configPath, JSON.stringify(config));
	const run = (args) => spawnSync(process.execPath, [join(root, "scripts", "build-website.mjs"), ...args], { cwd: root, encoding: "utf8" });
	const missing = run([]);
	assert.equal(missing.status, 1);
	assert.ok(missing.stderr.includes("--config"));
	const success = run(["--config", configPath, "--out", output]);
	assert.equal(success.status, 0, success.stderr);
	const receipt = JSON.parse(success.stdout);
	assert.equal(receipt.files, 12);
	assert.deepEqual(await readFile(configPath, "utf8"), JSON.stringify(config));
	const zip = await JSZip.loadAsync(await readFile(receipt.archive));
	assert.deepEqual(Object.values(zip.files).filter((file) => !file.dir).map((file) => file.name).sort(), names.slice().sort());
	for (const file of files) {
		assert.deepEqual(await readFile(join(receipt.publicDir, file.path)), file.data);
		assert.deepEqual(await zip.file(file.path).async("nodebuffer"), file.data);
	}
	const existing = run(["--config", configPath, "--out", output]);
	assert.equal(existing.status, 1);
	assert.ok(existing.stderr.includes("输出目录已存在"));
	const empty = join(temporary, "existing-empty");
	await mkdir(empty);
	assert.equal(run(["--config", configPath, "--out", empty]).status, 1);
	assert.deepEqual(await readdir(empty), []);
	const protectedOutput = run(["--config", configPath, "--out", join(root, "server", "data", "website-verify-must-not-create")]);
	assert.equal(protectedOutput.status, 1);
	assert.ok(protectedOutput.stderr.includes("server/data"));
	console.log("PASS: fixed public files, config allowlist, disabled announcements, URL safety, script escaping, literal replacements, inline previews, srcdoc navigation isolation, static hash routes, maintenance ICP, CLI zip equivalence, no input writes, no overwrite, protected server/data");
} finally {
	// mkdtemp 返回的绝对目录必须在系统临时目录下的固定前缀内，才允许清理本次测试输出。
	assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + "/") || resolve(temporary).startsWith(resolve(tmpdir()) + "\\"));
	assert.ok(temporary.slice(temporary.lastIndexOf("\\") + 1).includes("qiji-website-verify-"));
	await rm(temporary, { recursive: true, force: true });
}
