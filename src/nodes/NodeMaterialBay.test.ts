import { describe, expect, it, vi } from "vitest";
import { removeMaterialOnContextMenu } from "./NodeMaterialBay";

describe("NodeMaterialBay 右键取消垫图", () => {
	it("阻止右键菜单并立即移除，不等待确认", () => {
		const preventDefault = vi.fn();
		const stopPropagation = vi.fn();
		const remove = vi.fn();

		removeMaterialOnContextMenu({ preventDefault, stopPropagation }, remove);

		expect(preventDefault).toHaveBeenCalledOnce();
		expect(stopPropagation).toHaveBeenCalledOnce();
		expect(remove).toHaveBeenCalledOnce();
	});
});
