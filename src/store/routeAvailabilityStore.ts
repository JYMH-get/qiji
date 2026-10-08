import { create } from "zustand";
import type { RoutePriceAvailability } from "@/contract";
import { managedClient } from "@/services/managedClient";
import { useConnectionStore } from "./connectionStore";
import { useCatalogStore } from "./catalogStore";

const REFRESH_MS = 60_000;

/** Keep account, server, payer and catalogue boundaries in memory only. */
export function routeAvailabilityConnectionScope(state: ReturnType<typeof useConnectionStore.getState>): string {
    if (!state.loggedIn || !state.accessKey || !state.serverUrl) return "";
    const team = state.user?.team;
    const payer = team ? [team.id, team.role, team.creditMode, team.paymentSource] : null;
    const modes = Object.entries(state.user?.features?.modes ?? {}).sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify([state.serverUrl, state.accessKey, state.user?.id, state.user?.catalogAudience, payer, modes]);
}

export function routeAvailabilityScope(connection: string, version: string | undefined): string {
    return connection ? JSON.stringify([connection, version]) : "";
}

function currentScope(): string {
    return routeAvailabilityScope(routeAvailabilityConnectionScope(useConnectionStore.getState()), useCatalogStore.getState().catalog?.version);
}

interface RouteAvailabilityState {
    scope: string;
    data: RoutePriceAvailability | null;
    loading: boolean;
    failed: boolean;
    lastAttemptAt: number | null;
}

export const useRouteAvailabilityStore = create<RouteAvailabilityState>(() => ({ scope: "", data: null, loading: false, failed: false, lastAttemptAt: null }));

let revision = 0;
let pending: { scope: string; revision: number; promise: Promise<void> } | null = null;

/** One shared request per minute. Late replies cannot cross an account/catalogue change. */
export function refreshRouteAvailability(force = false): Promise<void> {
    const scope = currentScope();
    let state = useRouteAvailabilityStore.getState();
    if (scope !== state.scope) {
        revision++;
        useRouteAvailabilityStore.setState({ scope, data: null, loading: false, failed: false, lastAttemptAt: null });
        state = useRouteAvailabilityStore.getState();
    }
    if (!scope || (typeof document !== "undefined" && document.hidden)) return Promise.resolve();
    if (pending?.scope === scope && pending.revision === revision) return pending.promise;
    if (!force && state.lastAttemptAt !== null && Date.now() - state.lastAttemptAt < REFRESH_MS) return Promise.resolve();

    const requestRevision = ++revision;
    useRouteAvailabilityStore.setState({ loading: true, failed: false, lastAttemptAt: Date.now() });
    const current = () => requestRevision === revision && currentScope() === scope;
    const promise = managedClient.routeAvailability().then(data => {
        if (current()) useRouteAvailabilityStore.setState({ data, loading: false, failed: false });
    }).catch(() => {
        if (current()) useRouteAvailabilityStore.setState({ data: null, loading: false, failed: true });
    }).finally(() => {
        if (pending?.promise === promise) pending = null;
    });
    pending = { scope, revision: requestRevision, promise };
    return promise;
}

let consumers = 0;
let stopWatching: (() => void) | undefined;

/** All selectors share one timer; no persistence and no per-option polling. */
export function retainRouteAvailability(): () => void {
    consumers++;
    if (consumers === 1) {
        const onScopeChange = () => {
            if (currentScope() !== useRouteAvailabilityStore.getState().scope) void refreshRouteAvailability();
        };
        const offConnection = useConnectionStore.subscribe(onScopeChange);
        const offCatalog = useCatalogStore.subscribe(onScopeChange);
        const timer = setInterval(() => { void refreshRouteAvailability(); }, REFRESH_MS);
        const onVisible = () => { if (!document.hidden) void refreshRouteAvailability(); };
        if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
        stopWatching = () => {
            offConnection(); offCatalog(); clearInterval(timer);
            if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
        };
    }
    void refreshRouteAvailability();
    let released = false;
    return () => {
        if (released) return;
        released = true;
        if (--consumers === 0) { stopWatching?.(); stopWatching = undefined; }
    };
}
