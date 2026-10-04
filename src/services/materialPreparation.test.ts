import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMaterialPreparationController } from "./materialPreparation";
import type { MaterialPrepareResponse } from "@/contract";

const result = (status: MaterialPrepareResponse["status"]): MaterialPrepareResponse => ({ status, checkedAt: Date.now(), scopeKey: "sd-account" });
const asset = { id: "TP-image", usage: "identity" as const };

describe("official material preparation lifecycle", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());
	it("waits 3 seconds, merges simultaneous cards and polls Processing until Active", async () => {
		const prepare = vi.fn().mockResolvedValueOnce(result("Processing")).mockResolvedValue(result("Active"));
		const controller = createMaterialPreparationController(prepare);
		const a = vi.fn(), b = vi.fn();
		const offA = controller.subscribe("same", "route:sd", asset, "sd-account", a);
		const offB = controller.subscribe("same", "route:sd", asset, "sd-account", b);
		await vi.advanceTimersByTimeAsync(2999);
		expect(prepare).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(prepare).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(3000);
		expect(prepare).toHaveBeenCalledTimes(2);
		expect(a).toHaveBeenLastCalledWith(expect.objectContaining({ status: "Active" }));
		expect(b).toHaveBeenLastCalledWith(expect.objectContaining({ status: "Active" }));
		await vi.advanceTimersByTimeAsync(9000);
		expect(prepare).toHaveBeenCalledTimes(2);
		offA(); offB();
	});
	it("removal before debounce cancels upload; same-day reuse keeps Active", async () => {
		const prepare = vi.fn().mockResolvedValue(result("Active"));
		const controller = createMaterialPreparationController(prepare);
		controller.subscribe("same", "route:sd", asset, "sd-account", vi.fn())();
		await vi.advanceTimersByTimeAsync(5000);
		expect(prepare).not.toHaveBeenCalled();
		const off = controller.subscribe("same", "route:sd", asset, "sd-account", vi.fn());
		await vi.advanceTimersByTimeAsync(3000); off();
		controller.subscribe("same", "route:sd", asset, "sd-account", vi.fn());
		await vi.advanceTimersByTimeAsync(3000);
		expect(prepare).toHaveBeenCalledTimes(1);
	});
	it("changing line detaches old responses and cannot paint a different library green", async () => {
		let complete!: (value: MaterialPrepareResponse) => void;
		const prepare = vi.fn().mockImplementationOnce(() => new Promise<MaterialPrepareResponse>(r => { complete = r; })).mockResolvedValue({ ...result("Failed"), scopeKey: "we-account", error: "expired" });
		const controller = createMaterialPreparationController(prepare);
		const old = vi.fn(), current = vi.fn();
		const off = controller.subscribe("sd-key", "route:sd", asset, "sd-account", old);
		await vi.advanceTimersByTimeAsync(3000); off(); old.mockClear();
		controller.subscribe("we-key", "route:we", asset, "we-account", current);
		await vi.advanceTimersByTimeAsync(3000);
		complete(result("Active")); await vi.advanceTimersByTimeAsync(0);
		expect(old).not.toHaveBeenCalled();
		expect(current).toHaveBeenLastCalledWith(expect.objectContaining({ status: "Failed", error: "expired" }));
	});
	it("retries Failed only explicitly, and rejects changed server scope", async () => {
		const prepare = vi.fn().mockResolvedValueOnce(result("Failed")).mockResolvedValue({ ...result("Active"), scopeKey: "another-account" });
		const controller = createMaterialPreparationController(prepare);
		const listener = vi.fn();
		controller.subscribe("key", "route:sd", asset, "sd-account", listener);
		await vi.advanceTimersByTimeAsync(9000);
		expect(prepare).toHaveBeenCalledTimes(1);
		controller.retry("key"); await vi.advanceTimersByTimeAsync(0);
		expect(prepare).toHaveBeenLastCalledWith("route:sd", asset, true, expect.any(Object));
		expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: "Failed", error: "线路配置已更新，请刷新模型后重试" }));
	});
	it("submission reuses Active; next-day placement refreshes the status", async () => {
		const prepare = vi.fn().mockResolvedValueOnce(result("Active")).mockResolvedValue({ ...result("Failed"), error: "expired asset" });
		const controller = createMaterialPreparationController(prepare);
		const listener = vi.fn();
		controller.subscribe("key", "route:sd", asset, "sd-account", listener);
		await vi.advanceTimersByTimeAsync(3000);
		const state = await controller.check("key", "route:sd", asset, "sd-account");
		expect(prepare).toHaveBeenCalledTimes(1);
  expect(state.status).toBe('Active');
  vi.setSystemTime(Date.now() + 86400000);
  const nextDay = controller.subscribe('key', 'route:sd', asset, 'sd-account', listener);
  await vi.advanceTimersByTimeAsync(3000);
  expect(prepare).toHaveBeenCalledTimes(2);
  nextDay();
		expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: "Failed", error: "expired asset" }));
	});
	it('retains the prepared asset ID for green-card submission reuse without another prepare call', async () => {
		const prepare = vi.fn().mockResolvedValue({ ...result('Active'), assetId: 'asset-official-ready' });
		const controller = createMaterialPreparationController(prepare);
		const state = vi.fn();
		controller.subscribe('key', 'route:sd', asset, 'sd-account', state);
		await vi.advanceTimersByTimeAsync(3000);
		expect(state).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'Active', assetId: 'asset-official-ready' }));
		expect(await controller.check('key', 'route:sd', asset, 'sd-account')).toMatchObject({ status: 'Active', assetId: 'asset-official-ready' });
		expect(controller.peek('key')?.assetId).toBe('asset-official-ready');
		expect(prepare).toHaveBeenCalledOnce();
	});
});

