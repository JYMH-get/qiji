import { describe, it, expect } from "vitest";
import { sanitizeAssetBlobs, mergeAssetBlob, blobMatchesUri, PAST_URLS_MAX } from "./blobSanitize";
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

// 第254轮：url 换过之后旧 url 必须仍能反查回本 blob，否则项目里散落的历史 url 字符串
// 与三元映射失联 → 提交前自愈永远命中不了 → 「检查完仍然使用过期链接」（用户实报）
describe("mergeAssetBlob 历史 url 别名表", () => {
	const OLD = "https://jianqiji-qiji.cn-nb1.rains3.com/assets/C00000001.png";
	const NEW = "https://jianqiji.cn-sy1.rains3.com/jianyi/assets/C00000001.png";

	it("⚠ 换 url 时把旧 url 归档进 pastUrls，旧 uri 仍能反查命中", () => {
		const prev: AssetBlob = { id: "C00000001", url: OLD, localPath: "E:/p/assets/C00000001.png" };
		const out = mergeAssetBlob(prev, { id: "C00000001", url: NEW });
		expect(out.url).toBe(NEW);
		expect(out.pastUrls).toEqual([OLD]);
		expect(blobMatchesUri(out, OLD)).toBe(true);  // ← 治「仍然使用过期链接」的核心
		expect(blobMatchesUri(out, NEW)).toBe(true);
		expect(out.localPath).toBe("E:/p/assets/C00000001.png"); // 其余字段照常合并
	});

	it("url 未变 / 本来没有 url / 只补别的字段：不产生 pastUrls", () => {
		expect(mergeAssetBlob({ id: "a", url: OLD }, { id: "a", url: OLD }).pastUrls).toBeUndefined();
		expect(mergeAssetBlob(undefined, { id: "a", url: NEW }).pastUrls).toBeUndefined();
		expect(mergeAssetBlob({ id: "a", url: OLD }, { id: "a", localPath: "/x.png" }).pastUrls).toBeUndefined();
	});

	it("多跳换链：最新的旧 url 排最前、去重、绝不含当前 url", () => {
		let b = mergeAssetBlob({ id: "a", url: "u1" }, { id: "a", url: "u2" });
		b = mergeAssetBlob(b, { id: "a", url: "u3" });
		b = mergeAssetBlob(b, { id: "a", url: "u1" }); // 绕回 u1：u1 应从别名表移出（它成了当前 url）
		expect(b.url).toBe("u1");
		expect(b.pastUrls).toEqual(["u3", "u2"]);
	});

	it(`别名表上限 ${PAST_URLS_MAX} 条，超出丢最旧的`, () => {
		let b: AssetBlob = { id: "a", url: "u0" };
		for (let i = 1; i <= PAST_URLS_MAX + 3; i++) b = mergeAssetBlob(b, { id: "a", url: `u${i}` });
		expect(b.pastUrls).toHaveLength(PAST_URLS_MAX);
		expect(b.pastUrls?.[0]).toBe(`u${PAST_URLS_MAX + 2}`); // 最近换掉的排最前
		expect(b.pastUrls).not.toContain("u0"); // 最旧的被挤掉
	});

	it("blobMatchesUri：当前 url / 本地显示 uri / 原始来源 uri / 历史别名 四路都认", () => {
		const b: AssetBlob = { id: "a", url: NEW, localUri: "http://asset.localhost/E:/p/a.png", srcUri: "data:image/png;base64,xx", pastUrls: [OLD] };
		for (const u of [NEW, "http://asset.localhost/E:/p/a.png", "data:image/png;base64,xx", OLD]) {
			expect(blobMatchesUri(b, u)).toBe(true);
		}
		expect(blobMatchesUri(b, "https://别的/x.png")).toBe(false);
	});
});
