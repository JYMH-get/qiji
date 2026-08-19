/**
 * runPurpose 断连找回路径（resumeTask）语义锁定：
 * - 完全不碰模型解析/适配器注册表、不发起提交——只凭 taskId+adapterKey 重挂集中轮询；
 * - success/failed/lost 与流式 partialText 原样透传（与提交路径同形状的返回值）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
	trackTask: vi.fn(),
	getAdapter: vi.fn(),
	resolveAssetModelKey: vi.fn(() => ""),
}));
vi.mock("./taskCenter", () => ({ trackTask: mocks.trackTask }));
vi.mock("./adapters/registry", () => ({ getAdapter: mocks.getAdapter }));
vi.mock("./adapters/channelAdapter", () => ({ resolveAssetModelKey: mocks.resolveAssetModelKey }));

import { runPurpose } from "./purposeRunner";

describe("runPurpose resumeTask（断连找回：只挂轮询、不提交）", () => {
	beforeEach(() => {
		mocks.trackTask.mockReset();
		mocks.getAdapter.mockReset();
		mocks.resolveAssetModelKey.mockClear();
	});

	it("success：按 taskId+adapterKey 挂轮询并透传结果，全程不碰注册表/不解析模型", async () => {
		mocks.trackTask.mockImplementation((o: { onUpdate: (...a: unknown[]) => void }) => {
			o.onUpdate(100, "success", "https://oss.example/a.png", undefined, "TP00000001");
		});
		const r = await runPurpose("video.generate", {
			resumeTask: { taskId: "t-9", adapterKey: "managed:seedance-2.0" },
		});
		expect(r).toEqual({
			status: "success",
			resultUri: "https://oss.example/a.png",
			assetId: "TP00000001",
			taskId: "t-9",
			modelKey: "",
			adapterKey: "managed:seedance-2.0",
		});
		expect(mocks.trackTask).toHaveBeenCalledTimes(1);
		expect(mocks.trackTask.mock.calls[0][0]).toMatchObject({ taskId: "t-9", adapterKey: "managed:seedance-2.0" });
		// 找回不是提交：不解析模型、不查适配器注册表（注册表查了会因 mock 返回 undefined 走 no_model）
		expect(mocks.getAdapter).not.toHaveBeenCalled();
		expect(mocks.resolveAssetModelKey).not.toHaveBeenCalled();
	});

	it("lost：作为失败返回并带 lost 标记与原 taskId", async () => {
		mocks.trackTask.mockImplementation((o: { onUpdate: (...a: unknown[]) => void }) => {
			o.onUpdate(100, "lost", undefined, "服务端异常：未找到原任务");
		});
		const r = await runPurpose("video.generate", {
			resumeTask: { taskId: "t-10", adapterKey: "managed:m" },
		});
		expect(r).toMatchObject({ status: "failed", lost: true, taskId: "t-10", error: "服务端异常：未找到原任务" });
	});

	it("流式 partialText 经 onProgress 透传（文本推理找回续流）", async () => {
		mocks.trackTask.mockImplementation((o: { onUpdate: (...a: unknown[]) => void }) => {
			o.onUpdate(40, "running", undefined, undefined, undefined, "部分正文…");
			o.onUpdate(100, "success", "全文结果");
		});
		const seen: [number, string, string | undefined][] = [];
		const r = await runPurpose("storyboard.toVideoPrompt", {
			resumeTask: { taskId: "t-11", adapterKey: "managed:gpt" },
			onProgress: (p, s, t) => seen.push([p, s, t]),
		});
		expect(r).toMatchObject({ status: "success", resultUri: "全文结果" });
		expect(seen).toEqual([
			[40, "running", "部分正文…"],
			[100, "success", undefined],
		]);
	});
});
