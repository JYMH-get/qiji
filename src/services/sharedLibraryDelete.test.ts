import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { managedClient } from "./managedClient";
import { useConnectionStore } from "@/store/connectionStore";

const initial = useConnectionStore.getState();
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockReset();
	useConnectionStore.setState({ serverUrl: "http://shared-delete.invalid", accessKey: "fixture-key" });
});
afterEach(() => { vi.unstubAllGlobals(); useConnectionStore.setState(initial); });

describe.each([
	["文件夹", managedClient.sharedDeleteFolder, "/v1/team/lib/folders/shared-record"],
	["素材", managedClient.sharedDeleteAsset, "/v1/team/lib/assets/shared-record"],
] as const)("删除共享%s", (_label, remove, path) => {
	it("以共享记录 id 调用团长接口，空 DELETE 不发送 JSON Content-Type", async () => {
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
		await remove("shared-record");
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, options] = fetchMock.mock.calls[0];
		expect(url).toBe(`http://shared-delete.invalid${path}`);
		expect(options?.method).toBe("DELETE");
		expect(options?.body).toBeUndefined();
		expect(options?.headers).not.toHaveProperty("Content-Type");
		expect(options?.headers).toHaveProperty("Authorization", "Bearer fixture-key");
	});
	it("无权限时保留服务端原因并拒绝成功回调", async () => {
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: "不存在或无权限" } }), { status: 404 }));
		await expect(remove("shared-record")).rejects.toThrow("不存在或无权限");
	});
});
