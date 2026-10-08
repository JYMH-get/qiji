import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "@/store/projectStore";
import { useCanvasStore } from "@/store/canvasStore";
import { applyFileToUploadNode, uploadMediaToCanvasAsset } from "./nodeUpload";

const { saveLocal } = vi.hoisted(() => ({ saveLocal: vi.fn() }));
vi.mock("@/services/assetPersist", () => ({ saveUploadedLocal: saveLocal }));

describe("本地导入底层归属", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		useProjectStore.setState({ projectInstanceId: "project-a", isProjectLoading: false, assetBlobs: {} });
	});
	afterEach(() => vi.unstubAllGlobals());

	it("计算摘要期间切项目不落盘也不登记", async () => {
		const file = { name: "a.png", arrayBuffer: async () => {
			useProjectStore.setState({ projectInstanceId: "project-b" });
			return new ArrayBuffer(1);
		} } as File;
		await expect(uploadMediaToCanvasAsset(file)).rejects.toThrow("导入已取消");
		expect(saveLocal).not.toHaveBeenCalled();
		expect(useProjectStore.getState().assetBlobs).toEqual({});
	});

	it("落盘期间目标失效时禁止 objectURL 回退和二次登记", async () => {
		let valid = true;
		saveLocal.mockImplementationOnce(async (_file, _id, _url, _name, opts) => {
			expect(opts.shouldContinue()).toBe(true);
			valid = false;
			expect(opts.shouldContinue()).toBe(false);
			return null;
		});
		const file = { name: "a.png", arrayBuffer: async () => new ArrayBuffer(1) } as File;
		await expect(uploadMediaToCanvasAsset(file, "TP", { shouldContinue: () => valid })).rejects.toThrow("导入已取消");
		expect(useProjectStore.getState().assetBlobs).toEqual({});
	});

	it("画布调用方收到过期取消后，不修改新项目同名节点或弹出旧错误", async () => {
		const node = { id: "same-node", data: {} } as unknown as ReturnType<typeof useCanvasStore.getState>["nodes"][string];
		useCanvasStore.setState({ nodes: { [node.id]: node }, runtime: {} });
		const alert = vi.fn();
		vi.stubGlobal("alert", alert);
		saveLocal.mockImplementationOnce(async () => {
			useProjectStore.setState({ projectInstanceId: "project-b" });
			useCanvasStore.setState({ nodes: { [node.id]: node }, runtime: {} });
			return null;
		});
		const file = { name: "a.png", type: "image/png", arrayBuffer: async () => new ArrayBuffer(1) } as File;
		await applyFileToUploadNode(node.id, file);
		expect(useCanvasStore.getState().runtime).toEqual({});
		expect(alert).not.toHaveBeenCalled();
	});
});
