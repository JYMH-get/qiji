import { describe, it, expect } from "vitest";
import { formatBuildTime, versionLabel } from "./appVersion";

describe("appVersion 版本标识", () => {
	it("构建时间格式化为本地「YYYY-MM-DD HH:mm」", () => {
		const iso = new Date(2026, 6, 20, 22, 14, 5).toISOString(); // 本地时区构造再转 ISO，回读稳定
		expect(formatBuildTime(iso)).toBe("2026-07-20 22:14");
	});

	it("非法/空时间戳返回空串", () => {
		expect(formatBuildTime("")).toBe("");
		expect(formatBuildTime("not-a-date")).toBe("");
	});

	it("完整标识：版本 + 构建时间 + 开发版标记", () => {
		const iso = new Date(2026, 6, 20, 8, 5, 0).toISOString();
		expect(versionLabel("0.2.0", iso, false)).toBe("v0.2.0 · 构建 2026-07-20 08:05");
		expect(versionLabel("0.2.0", iso, true)).toBe("v0.2.0 · 构建 2026-07-20 08:05 · 开发版");
	});

	it("无构建时间（vitest 未注入）只显示版本号", () => {
		expect(versionLabel("0.2.0", "", false)).toBe("v0.2.0");
	});
});
