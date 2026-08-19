import { describe, it, expect, beforeEach, vi } from "vitest";
import { healPublicUrlIfDead, _resetAliveCache, type HealDeps } from "@/services/assetHeal";

function mkDeps(over: Partial<HealDeps> & { blob?: { id?: string; url?: string; localPath?: string; mime?: string; ext?: string } }): HealDeps {
	const { blob, ...rest } = over;
	return {
		isTauri: () => true,
		blobByUri: () => blob,
		readLocal: async () => new Uint8Array([1, 2, 3]),
		alive: async () => ({ alive: false }),
		reput: async () => ({ url: "https://oss.example.com/assets/C00000001.png" }),
		adoptUrl: () => {},
		...rest,
	};
}

describe("assetHeal 死链自愈", () => {
	beforeEach(() => _resetAliveCache());

	it("非 Tauri：原样返回，不探测不重传", async () => {
		const alive = vi.fn(async () => ({ alive: false }));
		const reput = vi.fn(async () => ({ url: "x" }));
		const deps = mkDeps({ isTauri: () => false, blob: { id: "C00000001", localPath: "/a.png" }, alive, reput });
		expect(await healPublicUrlIfDead("https://oss/x.png", deps)).toBe("https://oss/x.png");
		expect(alive).not.toHaveBeenCalled();
		expect(reput).not.toHaveBeenCalled();
	});

	it("无本地副本 / 无 blob：原样返回", async () => {
		const alive = vi.fn(async () => ({ alive: false }));
		expect(await healPublicUrlIfDead("https://oss/x.png", mkDeps({ blob: undefined, alive }))).toBe("https://oss/x.png");
		expect(await healPublicUrlIfDead("https://oss/x.png", mkDeps({ blob: { id: "C00000001" }, alive }))).toBe("https://oss/x.png"); // 无 localPath
		expect(alive).not.toHaveBeenCalled();
	});

	it("客户端派生 id（disp/bk）：跳过，不探测", async () => {
		const alive = vi.fn(async () => ({ alive: false }));
		const deps = mkDeps({ blob: { id: "disp123", localPath: "/a.png" }, alive });
		expect(await healPublicUrlIfDead("https://oss/x.png", deps)).toBe("https://oss/x.png");
		expect(alive).not.toHaveBeenCalled();
	});

	it("直链存活（url 相同）：原样返回；同一资产第二次不再探测（会话缓存）", async () => {
		const alive = vi.fn(async () => ({ alive: true, url: "https://oss/x.png" }));
		const adoptUrl = vi.fn();
		const deps = mkDeps({ blob: { id: "C00000001", localPath: "/a.png" }, alive, adoptUrl });
		expect(await healPublicUrlIfDead("https://oss/x.png", deps)).toBe("https://oss/x.png");
		expect(await healPublicUrlIfDead("https://oss/x.png", deps)).toBe("https://oss/x.png");
		expect(alive).toHaveBeenCalledTimes(1);
		expect(adoptUrl).not.toHaveBeenCalled(); // url 未变不回写
	});

	it("存活但服务端 url 已变（别人桥接恢复过）：换用新链接并回写映射", async () => {
		const NEW = "https://jianqiji.cn-sy1.rains3.com/jianyi/image/2026/08/C00000001.png";
		const alive = vi.fn(async () => ({ alive: true, url: NEW }));
		const reput = vi.fn(async () => ({ url: "x" }));
		const adoptUrl = vi.fn();
		const deps = mkDeps({ blob: { id: "C00000001", localPath: "/a.png", url: "https://old/x.png" }, alive, reput, adoptUrl });
		expect(await healPublicUrlIfDead("https://old/x.png", deps)).toBe(NEW);
		expect(adoptUrl).toHaveBeenCalledWith("C00000001", NEW);
		expect(reput).not.toHaveBeenCalled(); // 不重复上传
	});

	it("死链 + 本地副本：重传修复，返回修复后 url 并回写映射", async () => {
		const reput = vi.fn(async (_id: string, _blob: Blob, _name: string) => ({ url: "https://oss/healed.png" }));
		const readLocal = vi.fn(async () => new Uint8Array([9, 9]));
		const adoptUrl = vi.fn();
		const deps = mkDeps({ blob: { id: "video00000007", localPath: "/v.mp4", mime: "video/mp4", ext: "mp4" }, alive: async () => ({ alive: false }), reput, readLocal, adoptUrl });
		expect(await healPublicUrlIfDead("https://oss/dead.mp4", deps)).toBe("https://oss/healed.png");
		expect(readLocal).toHaveBeenCalledWith("/v.mp4");
		expect(reput).toHaveBeenCalledTimes(1);
		expect(reput.mock.calls[0][0]).toBe("video00000007");
		expect(reput.mock.calls[0][2]).toBe("video00000007.mp4");
		expect(adoptUrl).toHaveBeenCalledWith("video00000007", "https://oss/healed.png");
	});

	it("重传失败（返回 null）：回退原 uri", async () => {
		const deps = mkDeps({ blob: { id: "C00000001", localPath: "/a.png" }, alive: async () => ({ alive: false }), reput: async () => null });
		expect(await healPublicUrlIfDead("https://oss/dead.png", deps)).toBe("https://oss/dead.png");
	});
});
