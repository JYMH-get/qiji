import { describe, it, expect, beforeEach, vi } from "vitest";
import { recoverAsset, recoveredUrlOf, _resetAliveCache, type RecoverDeps } from "@/services/assetRecover";

type Blob0 = { url?: string; localPath?: string; mime?: string; ext?: string };

function mkDeps(over: Partial<RecoverDeps> & { blob?: Blob0 } = {}): RecoverDeps {
	const { blob, ...rest } = over;
	return {
		isTauri: () => true,
		blobById: () => blob,
		findLocalById: async () => null,
		fileExists: async () => true,
		readLocal: async () => new Uint8Array([1, 2, 3]),
		alive: async () => ({ alive: false }),
		reput: async () => ({ ok: true, id: "x", url: "https://oss/healed.png" }),
		adoptUrl: () => {},
		registerLocal: () => {},
		...rest,
	};
}

const NO_CACHE = { cache: "none" as const, retryDelayMs: 0 };

describe("assetRecover 单资产恢复", () => {
	beforeEach(() => _resetAliveCache());

	it("非台账 id（disp/bk/LC-）：missing，不发任何请求", async () => {
		const alive = vi.fn(async () => ({ alive: false }));
		for (const id of ["disp123", "bk1a2b", "LC-9", ""]) {
			expect((await recoverAsset(id, { ...NO_CACHE, deps: mkDeps({ alive }) })).status).toBe("missing");
		}
		expect(alive).not.toHaveBeenCalled();
	});

	it("直链存活且 url 未变 → ok，不回写映射、不重传", async () => {
		const adoptUrl = vi.fn();
		const reput = vi.fn(async () => ({ ok: true as const, id: "x", url: "u" }));
		const deps = mkDeps({ blob: { url: "https://oss/x.png" }, alive: async () => ({ alive: true, url: "https://oss/x.png" }), adoptUrl, reput });
		const r = await recoverAsset("C00000001", { ...NO_CACHE, deps });
		expect(r.status).toBe("ok");
		expect(r.url).toBe("https://oss/x.png");
		expect(adoptUrl).not.toHaveBeenCalled();
		expect(reput).not.toHaveBeenCalled();
	});

	it("⚠ 存活但服务端 url 已变（别人先桥接恢复过）→ adopted 换新链，**不需要本地副本**", async () => {
		const NEW = "https://jianqiji.cn-sy1.rains3.com/jianyi/image/2026/08/C00000001.png";
		const adoptUrl = vi.fn();
		const reput = vi.fn(async () => ({ ok: true as const, id: "x", url: "u" }));
		// blob 只有旧 url、没有 localPath —— 旧实现会被 localPath 门槛整个挡掉
		const deps = mkDeps({ blob: { url: "https://old/x.png" }, alive: async () => ({ alive: true, url: NEW }), adoptUrl, reput });
		const r = await recoverAsset("C00000001", { ...NO_CACHE, deps });
		expect(r.status).toBe("adopted");
		expect(r.url).toBe(NEW);
		expect(adoptUrl).toHaveBeenCalledWith("C00000001", NEW);
		expect(reput).not.toHaveBeenCalled(); // 不重复上传
	});

	it("⚠ 服务端台账无此资产（404）→ missing，不尝试重传（重传也无处可写）", async () => {
		const reput = vi.fn(async () => ({ ok: true as const, id: "x", url: "u" }));
		const deps = mkDeps({ blob: { localPath: "/a.png" }, alive: async () => ({ alive: false, missing: true }), reput });
		expect((await recoverAsset("C00000001", { ...NO_CACHE, deps })).status).toBe("missing");
		expect(reput).not.toHaveBeenCalled();
	});

	it("死链 + 映射有本地副本 → healed，回写新 url", async () => {
		const reput = vi.fn(async (_id: string, _blob: Blob, _name: string) => ({ ok: true as const, id: "video00000007", url: "https://oss/healed.mp4" }));
		const readLocal = vi.fn(async () => new Uint8Array([9, 9]));
		const adoptUrl = vi.fn();
		const deps = mkDeps({ blob: { localPath: "/v.mp4", mime: "video/mp4", ext: "mp4" }, reput, readLocal, adoptUrl });
		const r = await recoverAsset("video00000007", { ...NO_CACHE, deps });
		expect(r.status).toBe("healed");
		expect(r.url).toBe("https://oss/healed.mp4");
		expect(readLocal).toHaveBeenCalledWith("/v.mp4");
		expect(reput.mock.calls[0][0]).toBe("video00000007");
		expect(reput.mock.calls[0][2]).toBe("video00000007.mp4");
		expect(adoptUrl).toHaveBeenCalledWith("video00000007", "https://oss/healed.mp4");
	});

	it("⚠ 映射里的 localPath 文件已被删 → 回退磁盘扫描，扫到即登记进映射并修复", async () => {
		const findLocalById = vi.fn(async () => ({ localPath: "/assets/C00000002.png", ext: "png", mime: "image/png" }));
		const registerLocal = vi.fn();
		const deps = mkDeps({
			blob: { localPath: "/已被删.png" },
			fileExists: async (p) => p !== "/已被删.png",
			findLocalById,
			registerLocal,
		});
		const r = await recoverAsset("C00000002", { ...NO_CACHE, deps });
		expect(r.status).toBe("healed");
		expect(findLocalById).toHaveBeenCalledWith("C00000002");
		expect(registerLocal).toHaveBeenCalledWith("C00000002", { localPath: "/assets/C00000002.png", ext: "png", mime: "image/png" });
	});

	it("死链 + 映射与磁盘都没有副本 → dead", async () => {
		const deps = mkDeps({ blob: undefined, findLocalById: async () => null });
		expect((await recoverAsset("C00000003", { ...NO_CACHE, deps })).status).toBe("dead");
	});

	it("非 Tauri（浏览器）+ 死链 → dead，不碰文件系统", async () => {
		const findLocalById = vi.fn(async () => null);
		const deps = mkDeps({ isTauri: () => false, blob: { localPath: "/a.png" }, findLocalById });
		expect((await recoverAsset("C00000004", { ...NO_CACHE, deps })).status).toBe("dead");
		expect(findLocalById).not.toHaveBeenCalled();
	});

	it("⚠ 重传首次失败、退避重试成功 → healed（治对象存储 PUT 抖动）", async () => {
		let n = 0;
		const reput = vi.fn(async () => {
			n += 1;
			return n === 1 ? { ok: false as const, error: "HTTP 500：socket hang up" } : { ok: true as const, id: "x", url: "https://oss/ok.png" };
		});
		const deps = mkDeps({ blob: { localPath: "/a.png" }, reput });
		const r = await recoverAsset("C00000005", { ...NO_CACHE, deps });
		expect(r.status).toBe("healed");
		expect(reput).toHaveBeenCalledTimes(2);
	});

	it("⚠ 有本地副本但重传两次都失败 → failed（不是 dead）且带失败原因", async () => {
		const deps = mkDeps({ blob: { localPath: "/a.png" }, reput: async () => ({ ok: false as const, error: "HTTP 500：转存失败" }) });
		const r = await recoverAsset("C00000006", { ...NO_CACHE, deps });
		expect(r.status).toBe("failed");
		expect(r.reason).toContain("HTTP 500");
	});

	it("读取本地副本失败 → failed 带原因（本机确实有文件，不能报成无副本）", async () => {
		const deps = mkDeps({ blob: { localPath: "/a.png" }, readLocal: async () => { throw new Error("EACCES"); } });
		const r = await recoverAsset("C00000007", { ...NO_CACHE, deps });
		expect(r.status).toBe("failed");
		expect(r.reason).toContain("EACCES");
	});

	it("cache:\"session\" 只探一次；cache:\"none\" 每次都真探", async () => {
		const alive = vi.fn(async () => ({ alive: true, url: "https://oss/x.png" }));
		const deps = mkDeps({ blob: { url: "https://oss/x.png" }, alive });
		await recoverAsset("C00000008", { cache: "session", deps });
		await recoverAsset("C00000008", { cache: "session", deps });
		expect(alive).toHaveBeenCalledTimes(1);

		_resetAliveCache();
		const alive2 = vi.fn(async () => ({ alive: true, url: "https://oss/y.png" }));
		const deps2 = mkDeps({ blob: { url: "https://oss/y.png" }, alive: alive2 });
		await recoverAsset("C00000009", { ...NO_CACHE, deps: deps2 });
		await recoverAsset("C00000009", { ...NO_CACHE, deps: deps2 });
		expect(alive2).toHaveBeenCalledTimes(2);
	});

	it("recoveredUrlOf：只有 ok/adopted/healed 给出可用链接", () => {
		expect(recoveredUrlOf({ status: "ok", url: "a" })).toBe("a");
		expect(recoveredUrlOf({ status: "adopted", url: "b" })).toBe("b");
		expect(recoveredUrlOf({ status: "healed", url: "c" })).toBe("c");
		expect(recoveredUrlOf({ status: "dead" })).toBeUndefined();
		expect(recoveredUrlOf({ status: "failed", reason: "x" })).toBeUndefined();
		expect(recoveredUrlOf({ status: "missing" })).toBeUndefined();
	});
});
