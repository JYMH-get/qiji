import { describe, it, expect } from "vitest";
import {
	SHARED_PROJECT_FIELDS,
	diffByRef,
	pickLeader,
	prunePeers,
	pruneCanvasesToEpisodes,
	msgMatchesProject,
	mergeLedgerForPersist,
	PEER_TTL_MS,
	type PeerInfo,
} from "./projectSyncCore";

describe("diffByRef（共享字段引用级 diff）", () => {
	it("引用变了才算变；未列出的键不参与", () => {
		const a = { x: [1], y: { v: 1 }, z: "s", other: 1 };
		const b = { x: a.x, y: { v: 1 }, z: "s", other: 2 };
		expect(diffByRef(a, b, ["x", "y", "z"])).toEqual(["y"]);
	});

	it("共享字段清单不含窗口本地态（savePath/canvasEpisodeId/canvases/uiSnapshot）", () => {
		for (const k of ["savePath", "canvasEpisodeId", "canvases", "uiSnapshot", "isDirty", "isSaving"]) {
			expect(SHARED_PROJECT_FIELDS as readonly string[]).not.toContain(k);
		}
		expect(SHARED_PROJECT_FIELDS).toContain("episodes");
		expect(SHARED_PROJECT_FIELDS).toContain("assetBlobs");
	});
});

describe("pickLeader（写者/主窗口选举：确定性无协商）", () => {
	it("openedAt 最小者当选；并列按 windowId 字典序；空集 null", () => {
		expect(pickLeader([])).toBeNull();
		expect(pickLeader([
			{ windowId: "b", openedAt: 200 },
			{ windowId: "a", openedAt: 100 },
			{ windowId: "c", openedAt: 300 },
		])).toBe("a");
		expect(pickLeader([
			{ windowId: "b", openedAt: 100 },
			{ windowId: "a", openedAt: 100 },
		])).toBe("a");
	});

	it("先开的窗口关掉后自动顺延（从候选集剔除即换届）", () => {
		const all = [
			{ windowId: "w1", openedAt: 1 },
			{ windowId: "w2", openedAt: 2 },
		];
		expect(pickLeader(all)).toBe("w1");
		expect(pickLeader(all.filter((p) => p.windowId !== "w1"))).toBe("w2");
	});
});

describe("prunePeers（在场清理）", () => {
	it("超过 3 个心跳周期没消息的窗口剔除", () => {
		const now = 1_000_000;
		const peers: PeerInfo[] = [
			{ windowId: "alive", openedAt: 1, projectPath: "p", activeCanvasKey: "e1", lastSeen: now - PEER_TTL_MS + 1 },
			{ windowId: "dead", openedAt: 2, projectPath: "p", activeCanvasKey: "e2", lastSeen: now - PEER_TTL_MS - 1 },
		];
		expect(prunePeers(peers, now).map((p) => p.windowId)).toEqual(["alive"]);
	});
});

describe("pruneCanvasesToEpisodes（分集删除后画布快照清理）", () => {
	it("剔除不在分集清单里的画布 key；激活画布恒保留；无变化时返回原引用", () => {
		const canvases = { "ep-1": { n: 1 }, "ep-2": { n: 2 }, "ep-deleted": { n: 3 } };
		const out = pruneCanvasesToEpisodes(canvases, ["ep-1", "ep-2"], "ep-1");
		expect(Object.keys(out).sort()).toEqual(["ep-1", "ep-2"]);
		// 激活画布即便不在分集清单也保留（正在看的画布不许被清）
		const out2 = pruneCanvasesToEpisodes(canvases, ["ep-1"], "ep-deleted");
		expect(Object.keys(out2).sort()).toEqual(["ep-1", "ep-deleted"]);
		// 无需清理 → 原引用（不触发下游多余更新）
		const same = pruneCanvasesToEpisodes(canvases, ["ep-1", "ep-2", "ep-deleted"], "ep-1");
		expect(same).toBe(canvases);
	});
});

describe("msgMatchesProject（消息按项目过滤）", () => {
	it("路径一致才相关；未落盘项目（空路径）不参与跨窗口同步", () => {
		expect(msgMatchesProject({ senderId: "w", projectPath: "C:\\p\\a.Qiji" }, "C:\\p\\a.Qiji")).toBe(true);
		expect(msgMatchesProject({ senderId: "w", projectPath: "C:\\p\\a.Qiji" }, "C:\\p\\b.Qiji")).toBe(false);
		expect(msgMatchesProject({ senderId: "w", projectPath: "" }, "")).toBe(false);
		expect(msgMatchesProject({ senderId: "w", projectPath: "C:\\p\\a.Qiji" }, null)).toBe(false);
	});
});

describe("mergeLedgerForPersist（台账多窗口合并写盘）", () => {
	const e = (id: string) => ({ taskId: id });
	it("内存条目为准；存储里没见过的外来条目保留；见过且已删的不复活", () => {
		const memory = [e("mine-1"), e("mine-2")];
		const stored = [e("mine-1"), e("foreign-1"), e("removed-by-me")];
		const known = new Set(["mine-1", "mine-2", "removed-by-me"]);
		const out = mergeLedgerForPersist(memory, stored, known);
		expect(out.map((x) => x.taskId).sort()).toEqual(["foreign-1", "mine-1", "mine-2"]);
	});

	it("单窗口（存储与内存一致）＝原样写回", () => {
		const memory = [e("a")];
		expect(mergeLedgerForPersist(memory, [e("a")], new Set(["a"])).map((x) => x.taskId)).toEqual(["a"]);
	});
});
