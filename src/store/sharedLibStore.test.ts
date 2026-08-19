import { describe, it, expect } from "vitest";
import { mergeSharedAssets, type CachedSharedAsset } from "@/store/sharedLibStore";

const rec = (id: string, url = `https://oss/${id}.png`): CachedSharedAsset => ({ id, url, name: id });

describe("mergeSharedAssets 服务端记录 ⊕ 本地缓存", () => {
	it("保留已下载的 localUri（按记录 id 对齐），新记录无 localUri", () => {
		const cached = [{ ...rec("a"), localUri: "asset://a", localPath: "/a.png" }];
		const merged = mergeSharedAssets(cached, [rec("a"), rec("b")]);
		expect(merged).toHaveLength(2);
		expect(merged[0].localUri).toBe("asset://a");
		expect(merged[0].localPath).toBe("/a.png");
		expect(merged[1].localUri).toBeUndefined();
	});

	it("以服务端为准：服务端删掉的记录从缓存消失", () => {
		const cached = [{ ...rec("a"), localUri: "asset://a" }, { ...rec("gone"), localUri: "asset://gone" }];
		const merged = mergeSharedAssets(cached, [rec("a")]);
		expect(merged.map((m) => m.id)).toEqual(["a"]);
	});

	it("服务端字段更新（url 刷新/改名）以服务端为准，localUri 不丢", () => {
		const cached = [{ ...rec("a", "https://old/a.png"), name: "旧名", localUri: "asset://a" }];
		const merged = mergeSharedAssets(cached, [{ id: "a", url: "https://new/a.png", name: "新名" }]);
		expect(merged[0].url).toBe("https://new/a.png");
		expect(merged[0].name).toBe("新名");
		expect(merged[0].localUri).toBe("asset://a");
	});

	it("空缓存/空服务端均正常", () => {
		expect(mergeSharedAssets([], [rec("a")])).toHaveLength(1);
		expect(mergeSharedAssets([rec("a")], [])).toEqual([]);
	});
});
