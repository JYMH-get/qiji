import { describe, expect, it } from "vitest";
import { chooseWorkbenchSegment } from "./rtcWorkbenchTargetCore";

const editable = (id: string) => ({ id, kind: "media", shotRef: { episodeId: "ep1", shotId: id } });

describe("chooseWorkbenchSegment", () => {
	it("播放头跨到下一分镜时覆盖仍停留在上一分镜的旧选中", () => {
		expect(chooseWorkbenchSegment(editable("shot-1"), editable("shot-2"))?.id).toBe("shot-2");
	});

	it("播放头没有可编辑分镜时仍可用显式选中目标", () => {
		expect(chooseWorkbenchSegment(editable("shot-1"), null)?.id).toBe("shot-1");
	});

	it("占位符也属于可编辑工作台目标", () => {
		const placeholder = { id: "slot-1", kind: "placeholder" };
		expect(chooseWorkbenchSegment(null, placeholder)?.id).toBe("slot-1");
	});
});
