import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Catalog } from "@/contract";

const { fetchCatalog, syncManagedAdapters } = vi.hoisted(() => ({
    fetchCatalog: vi.fn(), syncManagedAdapters: vi.fn(),
}));
vi.mock("@/services/managedClient", () => ({ managedClient: { fetchCatalog } }));
vi.mock("@/services/adapters/managedAdapter", () => ({ syncManagedAdapters }));

import { useCatalogStore } from "./catalogStore";

function catalog(version: string): Catalog {
    return { version, models: [], templates: [], nodes: [], imageTemplates: [], variantPrefixes: [], schemas: {} };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

beforeEach(() => {
    vi.clearAllMocks();
    useCatalogStore.setState({ catalog: catalog("platform-before"), loading: false, error: null });
});

describe("目录刷新并发", () => {
    it("迁移后新归属目录先返回，迟到的源站目录不会覆盖它", async () => {
        const oldRequest = deferred<Catalog>();
        const newRequest = deferred<Catalog>();
        fetchCatalog.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
        const oldSync = useCatalogStore.getState().syncCatalog();
        const newSync = useCatalogStore.getState().syncCatalog();
        newRequest.resolve(catalog("agent-after"));
        await newSync;
        oldRequest.resolve(catalog("platform-stale"));
        await oldSync;
        expect(useCatalogStore.getState().catalog?.version).toBe("agent-after");
        expect(syncManagedAdapters).toHaveBeenCalledTimes(1);
        expect(useCatalogStore.getState().loading).toBe(false);
    });

    it("旧请求失败不报错或提前结束新请求的加载态", async () => {
        const oldRequest = deferred<Catalog>();
        const newRequest = deferred<Catalog>();
        fetchCatalog.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
        const oldSync = useCatalogStore.getState().syncCatalog();
        const newSync = useCatalogStore.getState().syncCatalog();
        oldRequest.reject(new Error("旧归属请求已失效"));
        await oldSync;
        expect(useCatalogStore.getState().loading).toBe(true);
        expect(useCatalogStore.getState().error).toBeNull();
        newRequest.resolve(catalog("agent-after"));
        await newSync;
        expect(useCatalogStore.getState().catalog?.version).toBe("agent-after");
        expect(useCatalogStore.getState().loading).toBe(false);
    });

    it("最新请求失败仍可见错误，后续增量 304 保留已验证目录", async () => {
        fetchCatalog.mockRejectedValueOnce(new Error("网络错误"));
        await useCatalogStore.getState().syncCatalog();
        expect(useCatalogStore.getState().error).toBe("网络错误");
        fetchCatalog.mockResolvedValueOnce({});
        await useCatalogStore.getState().syncCatalog();
        expect(useCatalogStore.getState().catalog?.version).toBe("platform-before");
        expect(useCatalogStore.getState().error).toBeNull();
        expect(syncManagedAdapters).toHaveBeenCalledTimes(1);
    });
});
