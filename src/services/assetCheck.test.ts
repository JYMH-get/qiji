import { describe, it, expect, beforeEach, vi } from "vitest";
import { useProjectStore } from "@/store/projectStore";
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import {
	checkOne,
	summarize,
	checkAssetTargets,
	dedupById,
	assetEntityTargets,
	allProjectAssetTargets,
	nodeCheckTargets,
	type CheckDeps,
} from "@/services/assetCheck";

function mkDeps(over: Partial<CheckDeps> = {}): CheckDeps {
	return {
		isTauri: () => true,
		blobById: () => undefined,
		findLocalById: async () => null,
		readLocal: async () => new Uint8Array([1]),
		alive: async () => ({ alive: false }),
		reput: async () => ({ url: "https://oss/healed.png" }),
		adoptUrl: () => {},
		...over,
	};
}

describe("assetCheck 检查素材", () => {
	beforeEach(() => {
		useProjectStore.setState({ assetBlobs: {}, characters: [], scenes: [], items: [], organisms: [], crowds: [] } as any);
	});

	it("checkOne：非台账 id / noLedger 标记 → missing（无 OSS 记录=异常，不探测、不跳过）", async () => {
		const alive = vi.fn(async () => ({ alive: false }));
		expect(await checkOne({ id: "disp123" }, mkDeps({ alive }))).toBe("missing");
		expect(await checkOne({ id: "asset://x.png", noLedger: true }, mkDeps({ alive }))).toBe("missing");
		expect(alive).not.toHaveBeenCalled();
	});

	it("checkOne：直链存活 → ok，并把服务端 url 回写映射（别人桥接恢复过=直接换链接）", async () => {
		const adoptUrl = vi.fn();
		const NEW = "https://jianqiji.cn-sy1.rains3.com/jianyi/image/2026/08/C00000001.png";
		expect(await checkOne({ id: "C00000001" }, mkDeps({ alive: async () => ({ alive: true, url: NEW }), adoptUrl }))).toBe("ok");
		expect(adoptUrl).toHaveBeenCalledWith("C00000001", NEW);
	});

	it("checkOne：死链 + 本地副本（映射表）→ healed，恢复后 url 回写映射", async () => {
		const reput = vi.fn(async () => ({ url: "https://oss/h.png" }));
		const adoptUrl = vi.fn();
		expect(await checkOne({ id: "S00000002" }, mkDeps({
			alive: async () => ({ alive: false }),
			blobById: () => ({ localPath: "/x.png", mime: "image/png", ext: "png" }),
			reput, adoptUrl,
		}))).toBe("healed");
		expect(reput).toHaveBeenCalledTimes(1);
		expect(adoptUrl).toHaveBeenCalledWith("S00000002", "https://oss/h.png");
	});

	it("checkOne：死链 + 映射表缺记录 + findLocalById 扫到磁盘文件 → healed，修复后登记进映射", async () => {
		const adoptUrl = vi.fn();
		// spy registerAssetBlob（merge 模式：只覆盖 assetBlobs，保留 store 既有函数）
		useProjectStore.setState({ assetBlobs: {}, registerAssetBlob: vi.fn() } as any);
		expect(await checkOne({ id: "C00000003" }, mkDeps({
			alive: async () => ({ alive: false }),
			findLocalById: async () => ({ localPath: "/proj/assets/C00000003.png", ext: "png", mime: "image/png" }),
			adoptUrl,
		}))).toBe("healed");
		expect((useProjectStore.getState() as any).registerAssetBlob).toHaveBeenCalledWith(
			expect.objectContaining({ id: "C00000003", localPath: "/proj/assets/C00000003.png" }),
		);
	});

	it("checkOne：死链 + 映射表缺记录 + findLocalById 也未找到 → dead", async () => {
		expect(await checkOne({ id: "C00000004" }, mkDeps({
			alive: async () => ({ alive: false }),
			blobById: () => undefined,
			findLocalById: async () => null,
		}))).toBe("dead");
	});

	it("checkOne：死链 + 无本地副本（映射+磁盘均无） → dead", async () => {
		expect(await checkOne({ id: "C00000001" }, mkDeps({ alive: async () => ({ alive: false }) }))).toBe("dead");
	});

	it("checkOne：死链 + reput 失败 → dead；非 Tauri + 死链 → dead", async () => {
		expect(await checkOne({ id: "C00000001" }, mkDeps({ alive: async () => ({ alive: false }), reput: async () => null }))).toBe("dead");
		expect(await checkOne({ id: "C00000001" }, mkDeps({ alive: async () => ({ alive: false }), isTauri: () => false }))).toBe("dead");
	});

	it("summarize：分类计数", () => {
		const r = summarize([
			{ id: "a", status: "ok" }, { id: "b", status: "ok" },
			{ id: "c", status: "healed" }, { id: "d", status: "dead" }, { id: "e", status: "missing" },
		]);
		expect(r).toMatchObject({ total: 5, ok: 2, healed: 1, dead: 1, missing: 1 });
	});

	it("checkAssetTargets：去重 + 汇总 + 进度回调", async () => {
		const seen: number[] = [];
		const r = await checkAssetTargets(
			[{ id: "C00000001" }, { id: "C00000001" }, { id: "S00000002" }],
			(done) => seen.push(done),
			mkDeps({
				alive: async (id) => ({ alive: id === "C00000001" }),
				blobById: () => ({ localPath: "/x.png", mime: "image/png", ext: "png" }),
			}),
		);
		expect(r.total).toBe(2); // 去重
		expect(r.ok).toBe(1);
		expect(r.healed).toBe(1);
		expect(seen[seen.length - 1]).toBe(2);
	});

	it("dedupById：按 id 去重保留首个", () => {
		expect(dedupById([{ id: "x", name: "a" }, { id: "x", name: "b" }, { id: "y" }])).toEqual([{ id: "x", name: "a" }, { id: "y" }]);
	});

	it("assetEntityTargets：主图/历史/造型 uri → 台账 id；反查不到=noLedger 异常项保留（不丢弃），无图不产出", () => {
		useProjectStore.setState({
			assetBlobs: {
				C00000001: { id: "C00000001", localUri: "u1" },
				S00000002: { id: "S00000002", url: "u2" },
				disp9: { id: "disp9", localUri: "u3" },
				audio01: { id: "audio01", localUri: "u4" },
			},
		} as any);
		const t = assetEntityTargets({ name: "张三", image: "u1", images: ["u2"], variants: [{ image: "u3", label: "战损" }, {}], voiceAssetId: "audio01", voiceUri: "u4" });
		expect(t).toEqual([
			{ id: "C00000001", name: "张三" },
			{ id: "S00000002", name: "张三" },
			{ id: "u3", name: "战损", noLedger: true }, // blob id 非台账 → 异常项进报告
			{ id: "audio01", name: "张三（音色）" },
		]);
	});

	it("assetEntityTargets：voiceUri 无 voiceAssetId 时走 uri 反查", () => {
		useProjectStore.setState({
			assetBlobs: { audio00000099: { id: "audio00000099", localUri: "voice_u1" } },
		} as any);
		const t = assetEntityTargets({ name: "李四", voiceUri: "voice_u1" });
		expect(t).toEqual([{ id: "audio00000099", name: "李四（音色）" }]);
	});

	it("assetEntityTargets：无音色时不产出额外项", () => {
		useProjectStore.setState({ assetBlobs: {} } as any);
		const t = assetEntityTargets({ name: "王五", image: undefined });
		expect(t).toEqual([]);
	});

	it("nodeCheckTargets：节点结果的库资产派生 id 解析出真台账 id（serverAssetId → uri 反查 → 兜底 noLedger）", () => {
		useProjectStore.setState({ assetBlobs: { S00000007: { id: "S00000007", localUri: "loc7" } } } as any);
		useLibraryStore.setState({
			assets: {
				"asset-t1": { id: "asset-t1", kind: "image", name: "图一", uri: "u1", serverAssetId: "C00000009" }, // serverAssetId 直取
				"asset-t2": { id: "asset-t2", kind: "image", name: "图二", uri: "loc7", serverAssetId: null },       // uri 反查三元映射
				"asset-t3": { id: "asset-t3", kind: "image", name: "图三", uri: "u3", serverAssetId: null },         // 无任何 OSS 线索 → noLedger
			},
		} as any);
		useCanvasStore.setState({
			nodes: {
				n1: { id: "n1", type: "image.gen", x: 0, y: 0, w: 240, h: 200, data: { title: "分镜1图片", resultAssetId: "asset-t1", resultHistory: ["asset-t2", "asset-t3"], input: {}, params: {} } },
			},
			edges: {},
		} as any);
		const t = nodeCheckTargets("n1");
		expect(t).toEqual([
			{ id: "C00000009", name: "分镜1图片" },
			{ id: "S00000007", name: "分镜1图片" },
			{ id: "u3", name: "分镜1图片", noLedger: true },
		]);
	});

	it("allProjectAssetTargets：汇总五类资产的图", () => {
		useProjectStore.setState({
			assetBlobs: { C00000001: { id: "C00000001", localUri: "u1" }, S00000002: { id: "S00000002", localUri: "u2" } },
			characters: [{ name: "角", image: "u1" }],
			scenes: [{ name: "景", image: "u2" }],
			items: [], organisms: [], crowds: [],
		} as any);
		const t = allProjectAssetTargets();
		expect(t.map((x) => x.id).sort()).toEqual(["C00000001", "S00000002"]);
	});
});
