import { describe, expect, it, vi } from "vitest";
import type { AssetBlob } from "@/services/projectFile";
import { buildRecoveredRefRewrites, restoreAssetBlob } from "@/services/projectAssetHeal";

const blob = (patch: Partial<AssetBlob> = {}): AssetBlob => ({
	id: "C00000001",
	url: "https://oss.example/C00000001.png",
	localPath: "D:/old/assets/C00000001.png",
	localUri: "http://asset.localhost/D%3A/old/assets/C00000001.png",
	ext: "png",
	...patch,
});

describe("restoreAssetBlob — 本地缺失时按 id + OSS 映射恢复", () => {
	it("本地原件仍在时只刷新显示 uri，不重复下载", async () => {
		const register = vi.fn();
		const download = vi.fn();
		const out = await restoreAssetBlob(blob(), {
			fileExists: vi.fn().mockResolvedValue(true),
			toDisplayUri: vi.fn().mockResolvedValue("asset://current/C00000001.png"),
			download,
			resolveUrl: vi.fn(),
			register,
		});
		expect(out?.localUri).toBe("asset://current/C00000001.png");
		expect(download).not.toHaveBeenCalled();
		expect(register).toHaveBeenCalledWith({
			id: "C00000001",
			localPath: "D:/old/assets/C00000001.png",
			localUri: "asset://current/C00000001.png",
		});
	});

	it("本地原件缺失时用同一台账 id 从现有 OSS url 下载并登记", async () => {
		const saved = blob({ localPath: "D:/new/assets/C00000001.png", localUri: "asset://new/C00000001.png" });
		const register = vi.fn();
		const download = vi.fn().mockResolvedValue(saved);
		const out = await restoreAssetBlob(blob(), {
			fileExists: vi.fn().mockResolvedValue(false),
			toDisplayUri: vi.fn(),
			download,
			resolveUrl: vi.fn(),
			register,
		});
		expect(download).toHaveBeenCalledWith("C00000001", "https://oss.example/C00000001.png");
		expect(out).toEqual(saved);
		expect(register).toHaveBeenCalledWith(saved);
	});

	it("缓存 url 下载失败时凭 id 解析最新链接后再恢复", async () => {
		const fresh = "https://new-oss.example/C00000001.png";
		const saved = blob({ url: fresh, localPath: "D:/new/C00000001.png", localUri: "asset://new/C00000001.png" });
		const download = vi.fn()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(saved);
		const register = vi.fn();
		const out = await restoreAssetBlob(blob(), {
			fileExists: vi.fn().mockResolvedValue(false),
			toDisplayUri: vi.fn(),
			download,
			resolveUrl: vi.fn().mockResolvedValue(fresh),
			register,
		});
		expect(download.mock.calls).toEqual([
			["C00000001", "https://oss.example/C00000001.png"],
			["C00000001", fresh],
		]);
		expect(out).toEqual(saved);
		expect(register).toHaveBeenCalledWith(saved);
	});
});

describe("buildRecoveredRefRewrites — 导入项目死引用改写", () => {
	it("旧路径改到新路径；旧显示 uri/公网别名都改到新本地显示 uri", () => {
		const before = blob({ srcUri: "blob:old", pastUrls: ["https://old.example/C00000001.png"] });
		const after = blob({
			url: "https://new.example/C00000001.png",
			localPath: "D:/new/assets/C00000001.png",
			localUri: "asset://new/C00000001.png",
		});
		const rewrites = buildRecoveredRefRewrites(before, after);
		expect(rewrites.get(before.localPath!)).toBe(after.localPath);
		expect(rewrites.get(before.localUri!)).toBe(after.localUri);
		expect(rewrites.get(before.url!)).toBe(after.localUri);
		expect(rewrites.get("blob:old")).toBe(after.localUri);
		expect(rewrites.get("https://old.example/C00000001.png")).toBe(after.localUri);
		expect(rewrites.get(after.url!)).toBe(after.localUri);
	});

	it("本地原件本就有效时只刷新旧本地 uri，不改写请求用公网 url", () => {
		const before = blob();
		const after = blob({ localUri: "asset://current/C00000001.png" });
		const rewrites = buildRecoveredRefRewrites(before, after, { includeRemoteAliases: false });
		expect(rewrites.get(before.localUri!)).toBe(after.localUri);
		expect(rewrites.has(before.url!)).toBe(false);
	});
});
