/**
 * thirdPartyFee —— 第三方本地渠道（LibTV / 即梦）的 Qiji 手续费。
 *
 * 规则（用户定，第107轮补）：每次调用第三方渠道收取手续费 5 积分——实现方式为
 * 「请求一个虚假模型」：管理端种子里有隐藏的 echo 模型 `fee-thirdparty`（cost=5，
 * 不进 catalog 下拉，管理端「模型」页可调价），客户端在**第三方调用成功后**按 id
 * 请求一次 /v1/generate，echo 同步成功即完成扣费（额度不足服务端回 402）。
 *
 * 时序：
 *  - 提交前 `precheckThirdPartyFee()` 软校验余额（不足直接拒单，不去打第三方）；
 *  - 第三方调用成功后 `chargeThirdPartyFee()` 真扣费（即梦=拿到 submit_id 时；
 *    LibTV=--run 同步跑完成功时——CLI 无受理中间态）。扣费失败重试一次，仍失败
 *    只告警不回滚第三方结果（余额由心跳 ≤30s 校准，下次提交的前置校验会拦住欠费用户）。
 */
import { managedClient } from "@/services/managedClient";
import { useConnectionStore } from "@/store/connectionStore";
import { useCatalogStore } from "@/store/catalogStore";

/** 手续费兜底价（catalog 未下发实价时用；服务端权威价=模型 fee-thirdparty 的 cost，管理端可调） */
export const THIRD_PARTY_FEE_CREDITS = 5;

/**
 * 手续费实价（第121轮）：catalog.fees.thirdParty = 本用户实付价（渠道商售价覆盖 > 平台价，
 * 服务端按用户归属投影下发、改价随 catalog 热更）；未下发（旧服务端）回退兜底常量 5。
 * 前置校验 / UI 预估 / 本地余额减扣 一律用它，保证与服务端实扣一致。
 */
export function thirdPartyFeeCredits(): number {
	const v = useCatalogStore.getState().catalog?.fees?.thirdParty;
	return typeof v === "number" && v >= 0 ? v : THIRD_PARTY_FEE_CREDITS;
}
const FEE_MODEL_ID = "fee-thirdparty";

/** 提交第三方前的余额软校验（登录态才有余额可查；不足抛错拒单） */
export function precheckThirdPartyFee(): void {
	const u = useConnectionStore.getState().user;
	const fee = thirdPartyFeeCredits();
	if (u && u.credits < fee) {
		throw new Error(`Qiji 积分不足：调用第三方渠道需 ${fee} 积分手续费（当前余额 ${u.credits}）`);
	}
}

/** 第三方调用成功后扣手续费（best-effort：重试一次，失败只告警不影响已产出的结果） */
export async function chargeThirdPartyFee(channel: string): Promise<void> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await managedClient.generate({
				purpose: "chat.reply",
				model: FEE_MODEL_ID,
				variables: { prompt: `third-party-fee:${channel}` },
				params: {},
				output: { format: "text" },
				clientTaskId: `fee-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
				projectId: "",
			});
			// 本地余额同步减扣（展示即时性；权威值随心跳 ≤30s 校准）
			const s = useConnectionStore.getState();
			if (s.user) s.setCredits(Math.max(0, s.user.credits - thirdPartyFeeCredits()));
			return;
		} catch (e) {
			if (attempt === 1) console.warn(`[thirdPartyFee] ${channel} 手续费扣费失败（结果已产出，余额将由心跳校准）：`, e);
		}
	}
}
