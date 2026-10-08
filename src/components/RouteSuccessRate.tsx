import { useCallback, useEffect, useMemo, type CSSProperties } from "react";
import type { RoutePriceAvailabilityRow, RouteSuccessRateWindow } from "@/contract";
import { useConnectionStore } from "@/store/connectionStore";
import { useCatalogStore } from "@/store/catalogStore";
import { retainRouteAvailability, routeAvailabilityConnectionScope, routeAvailabilityScope, useRouteAvailabilityStore } from "@/store/routeAvailabilityStore";

type RateHours = RouteSuccessRateWindow["hours"];
type RateWindow = Pick<RouteSuccessRateWindow, "hours" | "success" | "failed" | "successRate" | "insufficientSamples">;
type RateRow = Pick<RoutePriceAvailabilityRow, "success" | "failed" | "successRate"> & { rateWindows?: readonly RateWindow[] };

export interface RouteSuccessRateValue {
    compact: string;
    expanded: string;
    percent: number | null;
    hours?: RateHours;
    status: "ready" | "insufficient" | "unavailable" | "loading";
}

const unavailable: RouteSuccessRateValue = { compact: "—", expanded: "暂无统计", percent: null, status: "unavailable" };
const loading: RouteSuccessRateValue = { compact: "—", expanded: "正在读取成功率", percent: null, status: "loading" };
const insufficient: RouteSuccessRateValue = { compact: "—", expanded: "样本不足", percent: null, status: "insufficient" };

/** Real request counts only. Ten-minute history points are never averaged into a fallback rate. */
export function selectRouteSuccessRate(row: RateRow | undefined): RouteSuccessRateValue {
    if (!row) return unavailable;
    const windows = row.rateWindows ?? [{ hours: 1 as const, success: row.success, failed: row.failed, successRate: row.successRate, insufficientSamples: row.success + row.failed < 10 }];
    for (const hours of [1, 5, 10, 24] as const) {
        const window = windows.find(item => item.hours === hours);
        if (!window || window.insufficientSamples || window.success + window.failed < 10
            || typeof window.successRate !== "number" || !Number.isFinite(window.successRate) || window.successRate < 0 || window.successRate > 1) continue;
        const percent = window.successRate * 100;
        const compact = `${percent.toFixed(2)}%`;
        return { compact, expanded: `近${hours}小时成功率：${compact}`, percent, hours, status: "ready" };
    }
    return insufficient;
}

/** Call once per selector, then use the returned formatter freely inside option maps. */
export function useRouteSuccessRates(): (modelKey?: string) => RouteSuccessRateValue {
    const connection = useConnectionStore(routeAvailabilityConnectionScope);
    const version = useCatalogStore(s => s.catalog?.version);
    const scope = routeAvailabilityScope(connection, version);
    const state = useRouteAvailabilityStore();
    const rows = state.scope === scope && scope ? state.data?.rows : undefined;
    const rowsById = useMemo(() => new Map(rows?.map(row => [row.id, row]) ?? []), [rows]);
    useEffect(() => retainRouteAvailability(), []);
    return useCallback((modelKey?: string) => {
        const row = modelKey ? rowsById.get(modelKey) : undefined;
        if (row) return selectRouteSuccessRate(row);
        if (modelKey?.startsWith("route:") && scope && (state.scope !== scope || (!state.data && !state.failed))) return loading;
        return unavailable;
    }, [rowsById, scope, state.scope, state.data, state.failed]);
}

export function RouteSuccessRate({ modelKey, compact = false, style, className }: {
    modelKey?: string;
    compact?: boolean;
    style?: CSSProperties;
    className?: string;
}) {
    const rate = useRouteSuccessRates()(modelKey);
    return <span data-route-success-rate={rate.status} className={className} title={rate.expanded}
        style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", ...style }}>{compact ? rate.compact : rate.expanded}</span>;
}
