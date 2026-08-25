/**
 * 会员体系（第246轮）——单档会员：会员卡兑换码开通（仅源站签发，渠道商不参与）。
 *
 * 权益（用户定稿）：
 *  - 开通即到账算力（积分）：核销会员卡当场 grantCredits；
 *  - 生成计费折扣：会员期内 planBilling 按 discountPercent 折扣实扣（挂在付款人身上——
 *    团队共享模式=团长的会员生效，钱是谁的折扣就是谁的）。
 *
 * 与扩容卡（storageCodes.ts）同构：JSON 存储（量小、低频、要人读要导出）；
 * ⚠ 卡上冻结的是**签发当时的规格**（days/credits/discountPercent）——
 *   管理端事后调方案不应改变用户已经买到手的东西。
 *
 * 真实支付（微信/支付宝）本轮不接：客户端「充值中心」的支付位仅作预留展示。
 */
import { loadJson, saveJson } from "./db.ts";
import { randomBytes } from "node:crypto";

/** 会员方案（单档；管理端「会员」页可调，对新签发的卡生效） */
export interface MembershipPlan {
	/** 档位名（客户端会员卡片标题），默认「会员」 */
	name: string;
	/** 有效期天数（1..3650） */
	days: number;
	/** 开通即到账算力（积分，≥0） */
	credits: number;
	/** 生成计费折扣百分比（50..100）：95=9.5折；100=无折扣 */
	discountPercent: number;
	/** 展示价格标签（如「¥99/月」）——纯展示，无真实支付 */
	priceLabel: string;
	/** 权益说明（客户端会员卡片逐行显示，\n 分行） */
	benefitsNote: string;
	/** 关=客户端充值中心隐藏会员套餐、会员卡不可核销（已生效的会员不受影响） */
	enabled: boolean;
	/**
	 * 按模型单独调控的会员折扣（第247轮；第248轮加限免）：modelId → percent。
	 * 取值：**0=限免（会员免费，扣 0 积分）**；10..100=折扣（95=9.5折）；100=该模型对会员不打折。
	 * 设了即**覆盖**会员自身的基础折扣（卡上冻结的 discountPercent）。
	 * ⚠ 刻意**不冻结进卡、实时生效**——这是「服务端可单独调控」的语义本体：
	 *   运营随时改、对全体生效中会员即时生效；基础折扣仍按卡冻结不变。
	 *   限免的上下线同理=运营手动设置/移除（无自动到期）。
	 */
	modelDiscounts: Record<string, number>;
}

export interface MembershipCard {
	code: string; // mc-xxxxxxxxxxxxxxxx
	/** 签发时冻结的规格 */
	planName: string;
	days: number;
	credits: number;
	discountPercent: number;
	note?: string;
	/** 核销记录 */
	usedBy?: string;
	usedByName?: string;
	usedAt?: string;
	createdAt: string;
}

interface Db {
	plan: MembershipPlan;
	cards: MembershipCard[];
}

const DEFAULT_PLAN: MembershipPlan = {
	name: "会员",
	days: 30,
	credits: 100000,
	discountPercent: 95,
	priceLabel: "¥99/月",
	benefitsNote: "一次性到账算力 100,000\n会员期内生成享 9.5 折\n更多权益敬请期待",
	enabled: true,
	modelDiscounts: {},
};

const FILE = "membership.json";
const loaded = loadJson<Partial<Db>>(FILE, {});
const db: Db = {
	plan: normPlan({ ...DEFAULT_PLAN, ...(loaded.plan ?? {}) }),
	cards: Array.isArray(loaded.cards) ? (loaded.cards as MembershipCard[]) : [],
};

function persist(): void {
	saveJson(FILE, db);
}

/** 按模型折扣表收敛：键 trim 且 ≤64 字符、坏值丢弃、上限 200 条。
 *  值：**0 原样保留=限免（会员免费）**；其余取整夹 10..100（1..9 抬到 10，防手滑近乎免费——真要免费明确填 0） */
function normModelDiscounts(v: unknown): Record<string, number> {
	const out: Record<string, number> = {};
	if (v && typeof v === "object" && !Array.isArray(v)) {
		for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
			const id = String(k).trim();
			if (!id || id.length > 64) continue;
			const n = Math.floor(Number(raw));
			if (!Number.isFinite(n) || n < 0) continue; // 负数=坏值丢弃（限免必须明确填 0，防手滑）
			out[id] = n === 0 ? 0 : Math.min(100, Math.max(10, n));
			if (Object.keys(out).length >= 200) break;
		}
	}
	return out;
}

/** 字段收敛（管理端保存/读盘共用）：坏值回默认、越界夹取 */
function normPlan(p: Partial<MembershipPlan>): MembershipPlan {
	const days = Math.floor(Number(p.days));
	const credits = Math.floor(Number(p.credits));
	const disc = Math.floor(Number(p.discountPercent));
	return {
		name: String(p.name ?? "").trim().slice(0, 20) || DEFAULT_PLAN.name,
		days: Number.isFinite(days) ? Math.min(3650, Math.max(1, days)) : DEFAULT_PLAN.days,
		credits: Number.isFinite(credits) ? Math.min(100_000_000, Math.max(0, credits)) : DEFAULT_PLAN.credits,
		discountPercent: Number.isFinite(disc) ? Math.min(100, Math.max(50, disc)) : DEFAULT_PLAN.discountPercent,
		priceLabel: String(p.priceLabel ?? "").trim().slice(0, 40),
		benefitsNote: String(p.benefitsNote ?? "").slice(0, 800),
		enabled: p.enabled !== false,
		modelDiscounts: normModelDiscounts(p.modelDiscounts),
	};
}

/** 某模型的会员折扣覆盖（planBilling 用）：未单独设置返回 undefined=按会员基础折扣 */
export function membershipModelDiscountOf(modelId: string): number | undefined {
	const n = db.plan.modelDiscounts[modelId];
	return typeof n === "number" ? n : undefined;
}

export function getMembershipPlan(): MembershipPlan {
	return { ...db.plan, modelDiscounts: { ...db.plan.modelDiscounts } };
}

export function setMembershipPlan(patch: Partial<MembershipPlan>): MembershipPlan {
	db.plan = normPlan({ ...db.plan, ...patch });
	persist();
	return getMembershipPlan();
}

export function listMembershipCards(): MembershipCard[] {
	return [...db.cards].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getMembershipCard(code: string): MembershipCard | undefined {
	return db.cards.find((c) => c.code === code.trim());
}

/** 批量签发（上限 200/次，与团队码/扩容卡同尺）。规格从当前方案冻结进卡 */
export function createMembershipCards(count: number, note?: string): MembershipCard[] {
	const n = Math.max(1, Math.min(200, Math.floor(count) || 1));
	const now = new Date().toISOString();
	const p = db.plan;
	const made: MembershipCard[] = [];
	for (let i = 0; i < n; i++) {
		made.push({
			code: "mc-" + randomBytes(8).toString("hex"),
			planName: p.name,
			days: p.days,
			credits: p.credits,
			discountPercent: p.discountPercent,
			note: note?.trim() || undefined,
			createdAt: now,
		});
	}
	db.cards.push(...made);
	persist();
	return made;
}

/** 核销。幂等性：已核销的卡再次核销明确报错（不重复授予） */
export function useMembershipCard(code: string, userId: string, userName: string): { ok: true; card: MembershipCard } | { ok: false; error: string } {
	const c = db.cards.find((x) => x.code === code.trim());
	if (!c) return { ok: false, error: "会员卡不存在" };
	if (c.usedBy) return { ok: false, error: "该会员卡已被使用" };
	c.usedBy = userId;
	c.usedByName = userName || undefined;
	c.usedAt = new Date().toISOString();
	persist();
	return { ok: true, card: c };
}

/** 作废：未核销的可删（无退回，与激活码/扩容卡同规则）；已核销的留档不可删 */
export function deleteMembershipCard(code: string): { ok: boolean; error?: string } {
	const c = db.cards.find((x) => x.code === code);
	if (!c) return { ok: false, error: "会员卡不存在" };
	if (c.usedBy) return { ok: false, error: "该卡已被使用，留档不可删除" };
	db.cards = db.cards.filter((x) => x.code !== code);
	persist();
	return { ok: true };
}
