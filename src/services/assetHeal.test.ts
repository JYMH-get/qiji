import { describe, it, expect, beforeEach, vi } from "vitest";
import { healPublicUrlIfDead, _resetAliveCache, type HealDeps } from "@/services/assetHeal";
import type { RecoverResult } from "@/services/assetRecover";

/** 恢复例程本身的语义在 assetRecover.test.ts；这里只测「uri → 该用哪个链接」这层薄封装 */
function mkDeps(over: Partial<HealDeps> & { blobId?: string } = {}): HealDeps {
	const { blobId, ...rest } = over;
	return {
		blobByUri: () => (blobId === undefined ? undefined : { id: blobId }),
		recover: async () => ({ status: "ok" }) as RecoverResult,
		...rest,
	};
}

describe("assetHeal 提交前死链自愈", () => {
	beforeEach(() => _resetAliveCache());

	it("空 uri / 反查不到 blob：原样返回，不进恢复例程", async () => {
		const recover = vi.fn(async () => ({ status: "ok" }) as RecoverResult);
		expect(await healPublicUrlIfDead("", mkDeps({ recover }))).toBe("");
		expect(await healPublicUrlIfDead("https://oss/x.png", mkDeps({ blobId: undefined, recover }))).toBe("https://oss/x.png");
		expect(recover).not.toHaveBeenCalled();
	});

	it("客户端派生 id（disp/bk/LC-）：跳过，不进恢复例程", async () => {
		const recover = vi.fn(async () => ({ status: "ok" }) as RecoverResult);
		for (const id of ["disp123", "bk1a2b", "LC-9"]) {
			expect(await healPublicUrlIfDead("https://oss/x.png", mkDeps({ blobId: id, recover }))).toBe("https://oss/x.png");
		}
		expect(recover).not.toHaveBeenCalled();
	});

	it("存活（url 未变）：原样返回", async () => {
		const deps = mkDeps({ blobId: "C00000001", recover: async () => ({ status: "ok", url: "https://oss/x.png" }) });
		expect(await healPublicUrlIfDead("https://oss/x.png", deps)).toBe("https://oss/x.png");
	});

	it("⚠ 服务端 url 已变 → 换用新链接（提交发出去的必须是新链，治「检查完仍然使用过期链接」）", async () => {
		const NEW = "https://jianqiji.cn-sy1.rains3.com/jianyi/image/2026/08/C00000001.png";
		const deps = mkDeps({ blobId: "C00000001", recover: async () => ({ status: "adopted", url: NEW }) });
		expect(await healPublicUrlIfDead("https://old/x.png", deps)).toBe(NEW);
	});

	it("死链已用本地副本修复 → 返回修复后的链接", async () => {
		const deps = mkDeps({ blobId: "video00000007", recover: async () => ({ status: "healed", url: "https://oss/healed.mp4" }) });
		expect(await healPublicUrlIfDead("https://oss/dead.mp4", deps)).toBe("https://oss/healed.mp4");
	});

	it("无从恢复（dead/failed/missing）：回退原 uri，交由上游明确报错", async () => {
		for (const status of ["dead", "failed", "missing"] as const) {
			const deps = mkDeps({ blobId: "C00000001", recover: async () => ({ status }) });
			expect(await healPublicUrlIfDead("https://oss/dead.png", deps)).toBe("https://oss/dead.png");
		}
	});
});
