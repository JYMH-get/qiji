/**
 * 积分兑换码存储（文件持久化）。
 *
 * 管理端批量生成「一次性码」（固定面额 + 可选有效期）；用户端个人中心兑换。
 * 一次性：兑换成功即标记 used，记录兑换用户/时间。
 */
import { randomBytes } from "node:crypto";
import { loadJson, saveJson } from "./db.ts";

export interface RedeemCode {
	/** 兑换码字符串（全大写，形如 QJ-XXXX-XXXX-XXXX） */
	code: string;
	/** 面额（积分） */
	credits: number;
	/** 批次 id（同一次生成共享，便于管理端按批次查看） */
	batchId: string;
	/** 过期时间 ISO（空=永不过期） */
	expiresAt?: string;
	/** 备注 */
	note?: string;
	/** 归属渠道商 id（渠道商门户签发时写入；空=平台直发） */
	agentId?: string;
	/** 是否已被兑换 */
	used: boolean;
	usedBy?: string;
	usedByName?: string;
	usedAt?: string;
	createdAt: string;
}

const FILE = "redeem-codes.json";
let codes: RedeemCode[] = loadJson<RedeemCode[]>(FILE, []);

function persist(): void {
	saveJson(FILE, codes);
}

/** 生成一个 QJ-XXXX-XXXX-XXXX 形式的码（去掉易混字符无关，纯十六进制大写） */
function genCode(): string {
	const raw = randomBytes(6).toString("hex").toUpperCase(); // 12 hex chars
	return `QJ-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

export function listCodes(): RedeemCode[] {
	return [...codes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 批量生成兑换码（count 1-500，credits>0；expiresAt 可空；agentId 归属渠道商） */
export function createCodes(input: { count?: number; credits: number; expiresAt?: string; note?: string; agentId?: string }): RedeemCode[] {
	const count = Math.max(1, Math.min(500, Math.floor(Number(input.count) || 1)));
	const credits = Math.max(1, Math.floor(Number(input.credits) || 0));
	const now = new Date().toISOString();
	const batchId = "rb" + randomBytes(4).toString("hex");
	const made: RedeemCode[] = [];
	const taken = new Set(codes.map((c) => c.code));
	for (let i = 0; i < count; i++) {
		let code = genCode();
		while (taken.has(code)) code = genCode();
		taken.add(code);
		made.push({
			code,
			credits,
			batchId,
			expiresAt: input.expiresAt || undefined,
			note: input.note || undefined,
			agentId: input.agentId || undefined,
			used: false,
			createdAt: now,
		});
	}
	codes.push(...made);
	persist();
	return made;
}

/** 某渠道商签发的兑换码（新→旧） */
export function codesByAgent(agentId: string): RedeemCode[] {
	return listCodes().filter((c) => c.agentId === agentId);
}

/** 平台直发的兑换码（无归属渠道商——对**所有**用户可用） */
export function platformCodes(): RedeemCode[] {
	return listCodes().filter((c) => !c.agentId);
}

/**
 * 兑换码可用性（归属闸，⚠ 勿放宽）：
 *  - 平台直发（无 agentId）→ 所有用户可兑换；
 *  - 渠道商签发 → **仅其直属名下用户**可兑换（别家渠道商的用户、平台直属用户一律不可）。
 * 不放宽到「上级渠道商的码给下游用户用」：兑换=凭空发积分，用户消耗时按归属链**逐级**扣各商积分池
 *（第112轮双扣费）——上级给下游的用户发码等于消耗下游的池子，是经济漏洞。
 */
export function codeUsableBy(rec: RedeemCode, userAgentId?: string): boolean {
	return !rec.agentId || rec.agentId === userAgentId;
}

/** 取单个码（供渠道商作废前校验归属/状态） */
export function getCode(code: string): RedeemCode | undefined {
	return codes.find((c) => c.code === (code || "").trim().toUpperCase());
}

export function deleteCode(code: string): boolean {
	const before = codes.length;
	codes = codes.filter((c) => c.code !== code.trim().toUpperCase());
	if (codes.length !== before) {
		persist();
		return true;
	}
	return false;
}

export interface PruneCodesResult {
	removed: number;
	usedRemoved: number;
	expiredRemoved: number;
	/** 已过期且未使用的**渠道商码**：按商聚合的应退面额（路由层负责真退+记账——与门户「作废退回」同语义） */
	agentRefunds: { agentId: string; credits: number; count: number }[];
}

/**
 * 清除失效兑换码（第225轮）：已使用的 + 已过期的一次清掉。
 * ⚠ 已过期且未使用的渠道商码要把面额退回其积分池（签发时是真金划转，过期=永远兑不了，
 *   直接删=白吞商的钱）——本函数只聚合应退清单，真退款在路由层做（store 不依赖 agents）。
 */
export function pruneInvalidCodes(now = Date.now()): PruneCodesResult {
	const keep: RedeemCode[] = [];
	let usedRemoved = 0;
	let expiredRemoved = 0;
	const refunds = new Map<string, { credits: number; count: number }>();
	for (const c of codes) {
		if (c.used) { usedRemoved += 1; continue; }
		if (c.expiresAt && now > Date.parse(c.expiresAt)) {
			expiredRemoved += 1;
			if (c.agentId) {
				const r = refunds.get(c.agentId) ?? { credits: 0, count: 0 };
				r.credits += Math.max(0, Math.floor(c.credits || 0));
				r.count += 1;
				refunds.set(c.agentId, r);
			}
			continue;
		}
		keep.push(c);
	}
	const removed = codes.length - keep.length;
	if (removed) {
		codes = keep;
		persist();
	}
	return { removed, usedRemoved, expiredRemoved, agentRefunds: [...refunds].map(([agentId, r]) => ({ agentId, ...r })) };
}

export type RedeemResult = { ok: true; credits: number } | { ok: false; error: string };

/** 兑换（用户端调用）：校验存在/未用/未过期/**归属** → 标记 used，返回面额 */
export function redeemCode(rawCode: string, userId: string, userName: string, userAgentId?: string): RedeemResult {
	const code = (rawCode || "").trim().toUpperCase();
	if (!code) return { ok: false, error: "请输入兑换码" };
	const rec = codes.find((c) => c.code === code);
	if (!rec) return { ok: false, error: "兑换码不存在" };
	if (rec.used) return { ok: false, error: "兑换码已被使用" };
	if (rec.expiresAt && Date.now() > Date.parse(rec.expiresAt)) return { ok: false, error: "兑换码已过期" };
	// 归属闸：别家渠道商签发的码不可跨用（不暴露它属于哪家，只说不适用）
	if (!codeUsableBy(rec, userAgentId)) return { ok: false, error: "该兑换码不适用于当前账号，请使用你的服务商发放的兑换码" };
	rec.used = true;
	rec.usedBy = userId;
	rec.usedByName = userName;
	rec.usedAt = new Date().toISOString();
	persist();
	return { ok: true, credits: rec.credits };
}
