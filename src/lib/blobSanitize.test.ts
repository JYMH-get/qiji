import { describe, it, expect } from "vitest";
import { sanitizeAssetBlobs } from "./blobSanitize";
import type { AssetBlob } from "@/services/projectFile";

// 第145轮：blob: objectURL 是会话级——持久化后重开必死，加载时一律剥除（「本地素材丢失」根因之一）

describe("sanitizeAssetBlobs", () => {
	it("剥除 blob: localUri，其余字段原样保留", () => {
		const src: Record<string, AssetBlob> = {
			a: { id: "a", url: "https://oss/x.png", localUri: "blob:http://tauri.localhost/dead-uuid", localPath: "E:/p/assets/a.png" },
		};
		const out = sanitizeAssetBlobs(src);
		expect(out.a.localUri).toBeUndefined();
		expect(out.a.url).toBe("https://oss/x.png");
		expect(out.a.localPath).toBe("E:/p/assets/a.png");
	});

	it("asset.localhost / asset:// 等真本地显示态不动", () => {
		const src: Record<string, AssetBlob> = {
			a: { id: "a", localUri: "http://asset.localhost/E:/p/assets/a.png" },
			b: { id: "b", localUri: "asset://localhost/E:/p/assets/b.png" },
		};
		const out = sanitizeAssetBlobs(src);
		expect(out.a.localUri).toBe("http://asset.localhost/E:/p/assets/a.png");
		expect(out.b.localUri).toBe("asset://localhost/E:/p/assets/b.png");
	});

	it("无需改动时返回原对象引用（省一次替换）", () => {
		const src: Record<string, AssetBlob> = { a: { id: "a", url: "https://oss/x.png" } };
		expect(sanitizeAssetBlobs(src)).toBe(src);
	});
});
