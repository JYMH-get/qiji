import { describe, expect, it } from "vitest";
import { selectRouteSuccessRate } from "./RouteSuccessRate";

const window = (hours: 1 | 5 | 10 | 24, success: number, failed: number) => ({ hours, success, failed, successRate: success + failed ? success / (success + failed) : null, insufficientSamples: success + failed < 10 });
const row = (rateWindows: ReturnType<typeof window>[]) => ({ success: 0, failed: 0, successRate: null, rateWindows });

describe("route selector success rates", () => {
    it("prefers the first complete window, not the highest success rate", () => {
        expect(selectRouteSuccessRate(row([window(24, 100, 0), window(5, 20, 0), window(1, 9, 1)])))
            .toMatchObject({ compact: "90.00%", expanded: "近1小时成功率：90.00%", hours: 1, status: "ready" });
    });
    it.each([5, 10, 24] as const)("falls back to %sh only after shorter windows have insufficient completed samples", hours => {
        const windows = ([1, 5, 10, 24] as const).map(h => window(h, h < hours ? 9 : 99, h < hours ? 0 : 1));
        expect(selectRouteSuccessRate(row(windows))).toMatchObject({ expanded: `近${hours}小时成功率：99.00%`, hours });
    });
    it("shows 0 percent once ten failed requests have completed", () => {
        expect(selectRouteSuccessRate(row([window(1, 0, 10)]))).toMatchObject({ compact: "0.00%", percent: 0, status: "ready" });
    });
    it("does not substitute an 80 percent insufficient-sample placeholder", () => {
        const stats = row([{ ...window(1, 0, 0), successRate: .8 }, window(24, 8, 1)]);
        expect(selectRouteSuccessRate(stats)).toMatchObject({ compact: "—", expanded: "样本不足", percent: null });
    });
    it("keeps old-server one-hour statistics without inventing wider history", () => {
        expect(selectRouteSuccessRate({ success: 9999, failed: 1, successRate: .9999 })).toMatchObject({ expanded: "近1小时成功率：99.99%" });
        expect(selectRouteSuccessRate({ success: 1, failed: 0, successRate: 1 })).toMatchObject({ status: "insufficient" });
        expect(selectRouteSuccessRate(undefined)).toMatchObject({ expanded: "暂无统计", status: "unavailable" });
    });
});
