import { describe, it, expect } from "vitest";
import {
	sanitizeLedger,
	upsertLedgerEntry,
	removeLedgerEntry,
	resolveDeliveryTarget,
	buildOrphanNoticeText,
	orphanReasonLabel,
	resultKindLabel,
	LEDGER_MAX_ENTRIES,
	LEDGER_PENDING_TTL_MS,
	LEDGER_DONE_TTL_MS,
	LEDGER_TEXT_CAP,
	type LedgerEntry,
	type DeliveryCtx,
} from "./requestLedgerCore";

const NOW = 1_800_000_000_000;

function entry(patch: Partial<LedgerEntry> = {}): LedgerEntry {
	return {
		taskId: "t1",
		adapterKey: "managed:m1",
		projectPath: "C:\\proj\\a\\project.Qiji",
		projectName: "项目A",
		canvasKey: "ep-1",
		nodeId: "node-1",
		nodeTitle: "分镜1视频",
		nodeType: "video.gen",
		displayKind: "video",
		submittedAt: NOW - 60_000,
		status: "pending",
		...patch,
	};
}

describe("sanitizeLedger（台账载入清洗）", () => {
	it("非数组/坏形状/缺关键字段一律丢弃，好条目保留", () => {
		expect(sanitizeLedger(null, NOW)).toEqual([]);
		expect(sanitizeLedger("x", NOW)).toEqual([]);
		const out = sanitizeLedger(
			[
				entry(),
				null,
				42,
				{ taskId: "", adapterKey: "a", nodeId: "n", status: "pending", submittedAt: NOW },
				{ taskId: "t2", adapterKey: "", nodeId: "n", status: "pending", submittedAt: NOW },
				{ taskId: "t3", adapterKey: "a", nodeId: "n", status: "weird", submittedAt: NOW },
				{ taskId: "t4", adapterKey: "a", nodeId: "n", status: "pending" }, // 缺 submittedAt
			],
			NOW,
		);
		expect(out.map((e) => e.taskId)).toEqual(["t1"]);
	});

	it("同 taskId 去重（首见者胜）", () => {
		const out = sanitizeLedger([entry({ nodeTitle: "甲" }), entry({ nodeTitle: "乙" })], NOW);
		expect(out).toHaveLength(1);
		expect(out[0].nodeTitle).toBe("甲");
	});

	it("pending 超过 72h 丢弃（服务端任务终态只留 48h，无从找回）；done/orphaned 按 30 天", () => {
		const out = sanitizeLedger(
			[
				entry({ taskId: "old-pending", submittedAt: NOW - LEDGER_PENDING_TTL_MS - 1 }),
				entry({ taskId: "fresh-pending", submittedAt: NOW - LEDGER_PENDING_TTL_MS + 60_000 }),
				entry({ taskId: "old-done", status: "done", result: { url: "https://x/1.mp4" }, submittedAt: NOW - LEDGER_DONE_TTL_MS - 1 }),
				entry({ taskId: "kept-done", status: "done", result: { url: "https://x/2.mp4" }, submittedAt: NOW - LEDGER_PENDING_TTL_MS - 1 }),
			],
			NOW,
		);
		expect(out.map((e) => e.taskId).sort()).toEqual(["fresh-pending", "kept-done"]);
	});

	it("done/orphaned 但无任何结果载荷=无从投递/通知，丢弃；超长文本截断", () => {
		const out = sanitizeLedger(
			[
				entry({ taskId: "empty-done", status: "done", result: {} }),
				entry({ taskId: "no-result-orphan", status: "orphaned" }),
				entry({ taskId: "long-text", status: "done", displayKind: "text", result: { text: "字".repeat(LEDGER_TEXT_CAP + 100) } }),
			],
			NOW,
		);
		expect(out.map((e) => e.taskId)).toEqual(["long-text"]);
		expect(out[0].result?.text).toHaveLength(LEDGER_TEXT_CAP);
	});

	it("容量上限：按提交时间保最新的 N 条", () => {
		const many = Array.from({ length: LEDGER_MAX_ENTRIES + 20 }, (_, i) =>
			entry({ taskId: `t${i}`, submittedAt: NOW - i * 1000 }),
		);
		const out = sanitizeLedger(many, NOW);
		expect(out).toHaveLength(LEDGER_MAX_ENTRIES);
		expect(out[0].taskId).toBe("t0"); // 最新在前
		expect(out.some((e) => e.taskId === `t${LEDGER_MAX_ENTRIES + 19}`)).toBe(false);
	});

	it("orphanReason 白名单：非法值剥除", () => {
		const out = sanitizeLedger(
			[{ ...entry({ status: "orphaned", result: { url: "https://x" } }), orphanReason: "bogus" }],
			NOW,
		);
		expect(out[0].orphanReason).toBeUndefined();
	});
});

describe("upsertLedgerEntry / removeLedgerEntry", () => {
	it("新条目插入队首；已存在则合并且保留原 submittedAt（重挂不刷新提交时间）", () => {
		const a = entry({ taskId: "a", submittedAt: 100 });
		let list = upsertLedgerEntry([], a);
		list = upsertLedgerEntry(list, entry({ taskId: "b" }));
		expect(list[0].taskId).toBe("b");
		list = upsertLedgerEntry(list, entry({ taskId: "a", submittedAt: 999, status: "done", result: { url: "https://x" } }));
		const merged = list.find((e) => e.taskId === "a")!;
		expect(merged.submittedAt).toBe(100);
		expect(merged.status).toBe("done");
		expect(removeLedgerEntry(list, "a").map((e) => e.taskId)).toEqual(["b"]);
	});
});

function ctx(patch: Partial<DeliveryCtx> = {}): DeliveryCtx {
	return {
		loadedProjectPath: "C:\\proj\\a\\project.Qiji",
		activeCanvasKey: "ep-1",
		activeNodeIds: new Set(["node-1"]),
		canvasNodeIds: { "ep-2": new Set(["node-2"]) },
		projectMissing: false,
		...patch,
	};
}

describe("resolveDeliveryTarget（投递目标判定）", () => {
	it("节点在激活画布 → active-node", () => {
		expect(resolveDeliveryTarget(entry(), ctx())).toEqual({ kind: "active-node" });
	});

	it("激活画布上节点已删 → 孤儿（node）", () => {
		expect(resolveDeliveryTarget(entry(), ctx({ activeNodeIds: new Set() }))).toEqual({ kind: "orphan", reason: "node" });
	});

	it("节点在同项目非激活画布快照 → inactive-node（带实际画布 key）；快照里没有该节点 → 孤儿（node）", () => {
		expect(resolveDeliveryTarget(entry({ canvasKey: "ep-2", nodeId: "node-2" }), ctx())).toEqual({ kind: "inactive-node", canvasKey: "ep-2" });
		expect(resolveDeliveryTarget(entry({ canvasKey: "ep-2", nodeId: "gone" }), ctx())).toEqual({ kind: "orphan", reason: "node" });
	});

	it("⚠ 自愈搜索：登记的画布 key 因切换竞态记错位时，按 nodeId 全画布找到真实位置，绝不误判删除", () => {
		// 登记成激活画布 ep-1，节点实际在 ep-2 快照（用户提交瞬间切了画布）→ 纠正为 inactive-node/ep-2
		expect(resolveDeliveryTarget(entry({ canvasKey: "ep-1", nodeId: "node-2" }), ctx())).toEqual({ kind: "inactive-node", canvasKey: "ep-2" });
		// 登记成 ep-2，节点实际在激活画布 → 纠正为 active-node
		expect(resolveDeliveryTarget(entry({ canvasKey: "ep-2", nodeId: "node-1" }), ctx())).toEqual({ kind: "active-node" });
		// 登记的画布整个不存在，但节点在别的画布快照里 → 仍能投递（不报「画布已删」）
		expect(resolveDeliveryTarget(entry({ canvasKey: "ep-ghost", nodeId: "node-2" }), ctx())).toEqual({ kind: "inactive-node", canvasKey: "ep-2" });
	});

	it("画布（分集）整个不存在 → 孤儿（canvas）", () => {
		expect(resolveDeliveryTarget(entry({ canvasKey: "ep-deleted", nodeId: "node-9" }), ctx())).toEqual({ kind: "orphan", reason: "canvas" });
	});

	it("项目未打开 → defer（不能证实删除绝不误判孤儿）；证实项目文件已删 → 孤儿（project）", () => {
		expect(resolveDeliveryTarget(entry(), ctx({ loadedProjectPath: "C:\\other\\p.Qiji" }))).toEqual({ kind: "defer", reason: "project-not-open" });
		expect(resolveDeliveryTarget(entry(), ctx({ loadedProjectPath: null }))).toEqual({ kind: "defer", reason: "project-not-open" });
		expect(resolveDeliveryTarget(entry(), ctx({ projectMissing: true }))).toEqual({ kind: "orphan", reason: "project" });
	});

	it("提交时项目未落盘（projectPath 空）：按节点 id 搜当前项目（激活+快照），搜不到 defer 不判死", () => {
		const e = entry({ projectPath: "" });
		expect(resolveDeliveryTarget(e, ctx())).toEqual({ kind: "active-node" });
		expect(resolveDeliveryTarget(entry({ projectPath: "", nodeId: "node-2" }), ctx({ activeNodeIds: new Set() }))).toEqual({ kind: "inactive-node", canvasKey: "ep-2" });
		expect(resolveDeliveryTarget(entry({ projectPath: "", nodeId: "nowhere" }), ctx({ activeNodeIds: new Set() }))).toEqual({ kind: "defer", reason: "unsaved-project" });
	});
});

describe("孤儿通知文案", () => {
	it("按删除对象与结果种类措辞，含用户定稿关键句与结果链接", () => {
		const e = entry({ status: "orphaned", orphanReason: "node", result: { url: "https://oss.example/v.mp4" } });
		const text = buildOrphanNoticeText(e);
		expect(text).toContain("您的任务已完成");
		expect(text).toContain("节点已被您删除");
		expect(text).toContain("无法找到落盘位置");
		expect(text).toContain("以下是找回的任务/视频链接：https://oss.example/v.mp4");
	});

	it("项目/画布原因与文本结果的措辞", () => {
		expect(orphanReasonLabel("project")).toBe("项目");
		expect(orphanReasonLabel("canvas")).toBe("画布");
		expect(orphanReasonLabel(undefined)).toBe("节点");
		expect(resultKindLabel("image")).toBe("图片");
		expect(resultKindLabel("text")).toBe("文本内容");
		const e = entry({ status: "orphaned", orphanReason: "canvas", displayKind: "text", result: { text: "推理结果……" } });
		expect(buildOrphanNoticeText(e)).toContain("画布已被您删除");
		expect(buildOrphanNoticeText(e)).toContain("文本内容");
	});
});
