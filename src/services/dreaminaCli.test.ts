import { describe, it, expect } from "vitest";
import { pickDeviceFlow } from "@/services/dreaminaCli";
import { clampDreaminaRatio, clampDreaminaResolution, DREAMINA_MODEL_CHOICES } from "@/services/adapters/dreaminaAdapter";

/**
 * 即梦 CLI 集成的纯函数语义锁定：
 *  - 设备码材料容错抽取（JSON / 裸文本 key: value 两种形态；复用态中文文本 → null）；
 *  - 参数收敛：分辨率仅 seedance2.0_vip 放行 1080p/4k，其余一律 720p；比例白名单。
 */

describe("pickDeviceFlow（OAuth 设备码材料容错抽取）", () => {
	it("JSON 输出：三键齐全", () => {
		const out = JSON.stringify({
			verification_uri: "https://jimeng.jianying.com/activate",
			user_code: "ABCD-1234",
			device_code: "dc-xyz",
		});
		expect(pickDeviceFlow(out)).toEqual({
			verificationUri: "https://jimeng.jianying.com/activate",
			userCode: "ABCD-1234",
			deviceCode: "dc-xyz",
		});
	});

	it("裸文本输出：key: value 行（CLI 文案形态防御）", () => {
		const out = [
			"请在浏览器中完成授权：",
			"verification_uri: https://jimeng.jianying.com/activate",
			"user_code: WXYZ-5678",
			"device_code: dc-abc123",
		].join("\n");
		const r = pickDeviceFlow(out);
		expect(r?.verificationUri).toBe("https://jimeng.jianying.com/activate");
		expect(r?.userCode).toBe("WXYZ-5678");
		expect(r?.deviceCode).toBe("dc-abc123");
	});

	it("已登录复用态（中文纯文本，无设备码材料）→ null", () => {
		expect(pickDeviceFlow("已复用当前本地 OAuth 登录态。\n当前登录账户信息：\nuser_id: 123")).toBeNull();
	});
});

describe("即梦参数收敛", () => {
	it("分辨率：仅 seedance2.0_vip 放行 1080p/4k，其余版本一律 720p", () => {
		expect(clampDreaminaResolution("1080p", "seedance2.0_vip")).toBe("1080p");
		expect(clampDreaminaResolution("4k", "seedance2.0_vip")).toBe("4k");
		expect(clampDreaminaResolution("480p", "seedance2.0_vip")).toBe("720p"); // 非法档收敛
		expect(clampDreaminaResolution("1080p", "seedance2.0")).toBe("720p"); // 非 vip 强制 720p
		expect(clampDreaminaResolution(undefined, "seedance2.0fast")).toBe("720p");
	});

	it("比例：白名单外（含 LibTV 的 adaptive）回退 16:9", () => {
		expect(clampDreaminaRatio("9:16")).toBe("9:16");
		expect(clampDreaminaRatio("21:9")).toBe("21:9");
		expect(clampDreaminaRatio("adaptive")).toBe("16:9");
		expect(clampDreaminaRatio(undefined)).toBe("16:9");
	});
});

describe("即梦模型清单（第203轮：CLI 1.4.15 加 Seedance 2.5）", () => {
	it("Seedance 2.5 在列且 model_version 精确匹配 CLI flag 值", () => {
		const sd25 = DREAMINA_MODEL_CHOICES.find((c) => c.id === "dreamina-seedance-2-5");
		expect(sd25?.modelVersion).toBe("seedance2.5");
		expect(sd25?.variantLabel).toBe("Seedance 2.5");
	});

	it("存量四款 model_version 不变（历史行为锁定）+ Mini/2.5 追加在后", () => {
		expect(DREAMINA_MODEL_CHOICES.map((c) => c.modelVersion)).toEqual([
			"seedance2.0", "seedance2.0fast", "seedance2.0_vip", "seedance2.0fast_vip", "seedance2.0mini", "seedance2.5",
		]);
	});

	it("Seedance 2.0 Mini：走 2.0 家族默认档（非 VIP 非 2.5——720p、时长 4-15、需图或视频）", () => {
		const mini = DREAMINA_MODEL_CHOICES.find((c) => c.id === "dreamina-seedance-2-mini");
		expect(mini?.modelVersion).toBe("seedance2.0mini");
		expect(clampDreaminaResolution("1080p", "seedance2.0mini")).toBe("720p"); // 非 vip 强制 720p
	});
});
