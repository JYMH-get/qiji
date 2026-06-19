import { describe, it, expect } from "vitest";
import { genId } from "./id";

describe("genId", () => {
	it("包含前缀", () => {
		const id = genId("node");
		expect(id.startsWith("node-")).toBe(true);
	});

	it("每次调用返回唯一值", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 100; i++) {
			ids.add(genId("test"));
		}
		expect(ids.size).toBe(100);
	});

	it("不同前缀产生不同 ID", () => {
		const a = genId("node");
		const b = genId("edge");
		expect(a).not.toBe(b);
		expect(a.startsWith("node-")).toBe(true);
		expect(b.startsWith("edge-")).toBe(true);
	});
});