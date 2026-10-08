import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/managedClient", () => ({ managedClient: { routeAvailability: vi.fn() } }));
vi.mock("./connectionStore", async () => {
    const { create } = await import("zustand");
    return { useConnectionStore: create(() => ({ loggedIn: true, accessKey: "key", serverUrl: "https://test.invalid", user: { id: "user" } })) };
});
vi.mock("./catalogStore", async () => {
    const { create } = await import("zustand");
    return { useCatalogStore: create(() => ({ catalog: { version: "v1" } })) };
});

import type { RoutePriceAvailability } from "@/contract";
import { managedClient } from "@/services/managedClient";
import { useConnectionStore } from "./connectionStore";
import { useCatalogStore } from "./catalogStore";
import { refreshRouteAvailability, retainRouteAvailability, useRouteAvailabilityStore } from "./routeAvailabilityStore";

const data = (until: number): RoutePriceAvailability => ({ since: 0, until, historyWindowMs: 36_000_000, rows: [] });
const deferred = () => {
    let resolve!: (value: RoutePriceAvailability) => void;
    const promise = new Promise<RoutePriceAvailability>(done => { resolve = done; });
    return { promise, resolve };
};
let sequence = 0;
beforeEach(() => {
    vi.mocked(managedClient.routeAvailability).mockReset();
    useConnectionStore.setState({ loggedIn: true, accessKey: `key-${++sequence}`, user: { id: "user", name: "测试", credits: 100 } });
    useCatalogStore.setState({ catalog: { version: "v1" } as any });
});

describe("shared route-availability cache", () => {
    it("deduplicates concurrent selectors and reuses the one-minute cache", async () => {
        const response = deferred();
        vi.mocked(managedClient.routeAvailability).mockReturnValue(response.promise);
        const first = refreshRouteAvailability(), second = refreshRouteAvailability();
        expect(first).toBe(second);
        response.resolve(data(10)); await first; await refreshRouteAvailability();
        expect(managedClient.routeAvailability).toHaveBeenCalledTimes(1);
        expect(useRouteAvailabilityStore.getState().data?.until).toBe(10);
    });
    it("drops late previous-account responses and clears their visible data immediately", async () => {
        const old = deferred(), next = deferred();
        vi.mocked(managedClient.routeAvailability).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
        const first = refreshRouteAvailability();
        useConnectionStore.setState({ accessKey: "different-account" });
        const second = refreshRouteAvailability();
        expect(useRouteAvailabilityStore.getState().data).toBeNull();
        next.resolve(data(20)); await second;
        old.resolve(data(10)); await first;
        expect(useRouteAvailabilityStore.getState().data?.until).toBe(20);
    });
    it("does not reuse a stale promise after logout and login with the same key", async () => {
        const old = deferred(), next = deferred();
        vi.mocked(managedClient.routeAvailability).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
        const first = refreshRouteAvailability();
        useConnectionStore.setState({ loggedIn: false }); await refreshRouteAvailability();
        useConnectionStore.setState({ loggedIn: true }); const second = refreshRouteAvailability();
        expect(managedClient.routeAvailability).toHaveBeenCalledTimes(2);
        old.resolve(data(10)); await first;
        expect(useRouteAvailabilityStore.getState().data).toBeNull();
        next.resolve(data(20)); await second;
        expect(useRouteAvailabilityStore.getState().data?.until).toBe(20);
    });
    it("shares its timer and refreshes a new catalog scope without showing the old data", async () => {
        vi.mocked(managedClient.routeAvailability).mockResolvedValue(data(1));
        const release1 = retainRouteAvailability(), release2 = retainRouteAvailability();
        try {
            await refreshRouteAvailability();
            expect(managedClient.routeAvailability).toHaveBeenCalledTimes(1);
            const next = deferred(); vi.mocked(managedClient.routeAvailability).mockReturnValue(next.promise);
            useCatalogStore.setState({ catalog: { version: "v2" } as any });
            expect(useRouteAvailabilityStore.getState().data).toBeNull();
            const pending = refreshRouteAvailability(); next.resolve(data(2)); await pending;
            expect(managedClient.routeAvailability).toHaveBeenCalledTimes(2);
        } finally { release1(); release2(); }
    });
    it("does not retain an old live percentage after a failed refresh", async () => {
        vi.mocked(managedClient.routeAvailability).mockResolvedValueOnce(data(1)).mockRejectedValueOnce(new Error("offline"));
        await refreshRouteAvailability(); await refreshRouteAvailability(true);
        expect(useRouteAvailabilityStore.getState()).toMatchObject({ data: null, loading: false, failed: true });
    });
    it("keeps the cache through balance heartbeats but refreshes when the payment source changes", async () => {
        useConnectionStore.setState({ user: { id: "user", name: "测试", credits: 100, team: { id: "team", name: "团队", role: "member", creditMode: "shared", paymentSource: "team", memberCount: 2, poolCredits: 100 } } });
        vi.mocked(managedClient.routeAvailability).mockResolvedValue(data(1));
        const release = retainRouteAvailability();
        try {
            await refreshRouteAvailability();
            const previous = useConnectionStore.getState().user!;
            useConnectionStore.setState({ user: { ...previous, credits: 80, team: { ...previous.team!, poolCredits: 80, personalCredits: 30, teamCredits: 10, memberCount: 3 } } });
            await refreshRouteAvailability();
            expect(managedClient.routeAvailability).toHaveBeenCalledTimes(1);
            expect(useRouteAvailabilityStore.getState().data?.until).toBe(1);
            useConnectionStore.setState({ user: { ...previous, team: { ...previous.team!, paymentSource: "personal" } } });
            await refreshRouteAvailability();
            expect(managedClient.routeAvailability).toHaveBeenCalledTimes(2);
        } finally { release(); }
    });
});
