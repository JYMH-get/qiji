/**
 * 扩容卡（P1）——给「收藏配额 / 团队共享库配额」加容量的卡。
 *
 * 与团队码（teams.ts TeamCode）完全同构，故沿用 JSON 存储（量小、低频、要人读要导出）：
 *  - 渠道商在门户签发（P1 商业化改造起**免费**——开码积分退役；规格仍由源站 settings 统一配置）
 *  - 用户/团长在客户端核销 → 写入 quota_grants（favorites.ts）
 *  - 未核销可作废（与激活码/团队码同规则）
 *
 * ⚠ 卡上冻结的是**签发当时的规格**（bytes/days），不是核销时的：
 *   管理端事后调档不应改变用户已经买到手的东西。
 */
import { loadJson, saveJson } from "./db.ts";
import { randomBytes } from "node:crypto";

export interface StorageCode {
	code: string; // sc-xxxxxxxxxxxxxxxx
	/** 给谁用：user=个人收藏配额 / team=团队共享库配额 */
	target: "user" | "team";
	/** 签发时冻结的规格 */
	bytes: number;
	days: number;
	note?: string;
	/** 签发渠道商 id（空=源站签发）——开码积分实扣归属，仅作留档，不限制使用者 */
	agentId?: string;
	/** 核销记录 */
	usedBy?: { type: "user" | "team"; id: string };
	usedAt?: string;
	createdAt: string;
}

interface Db {
	codes: StorageCode[];
}

const FILE = "storage-codes.json";
const db: Db = { codes: [], ...loadJson<Partial<Db>>(FILE, {}) };

function persist(): void {
	saveJson(FILE, db);
}

export function listStorageCodes(): StorageCode[] {
	return [...db.codes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 某渠道商签发的卡（门户「扩容卡」页） */
export function listStorageCodesByAgent(agentId: string): StorageCode[] {
	return listStorageCodes().filter((c) => c.agentId === agentId);
}

export function getStorageCode(code: string): StorageCode | undefined {
	return db.codes.find((c) => c.code === code);
}

/** 批量签发（上限 200/次，与团队码同尺）。规格由调用方从 settings 现取并冻结进卡里 */
export function createStorageCodes(
	count: number,
	target: "user" | "team",
	spec: { bytes: number; days: number },
	opts?: { note?: string; agentId?: string },
): StorageCode[] {
	const n = Math.max(1, Math.min(200, Math.floor(count) || 1));
	const now = new Date().toISOString();
	const made: StorageCode[] = [];
	for (let i = 0; i < n; i++) {
		made.push({
			code: "sc-" + randomBytes(8).toString("hex"),
			target,
			bytes: spec.bytes,
			days: spec.days,
			note: opts?.note?.trim() || undefined,
			agentId: opts?.agentId,
			createdAt: now,
		});
	}
	db.codes.push(...made);
	persist();
	return made;
}

/**
 * 核销。调用方须先确认 owner 有资格（个人卡=本人；团队卡=团长）。
 * 幂等性：已核销的卡再次核销明确报错（不重复授予额度）。
 */
export function useStorageCode(code: string, owner: { type: "user" | "team"; id: string }): { ok: true; card: StorageCode } | { ok: false; error: string } {
	const c = db.codes.find((x) => x.code === code.trim());
	if (!c) return { ok: false, error: "扩容卡不存在" };
	if (c.usedBy) return { ok: false, error: "该扩容卡已被使用" };
	if (c.target !== owner.type) {
		return { ok: false, error: c.target === "team" ? "这是团队扩容卡，请由团长在团队页使用" : "这是个人扩容卡，不能用于团队" };
	}
	c.usedBy = owner;
	c.usedAt = new Date().toISOString();
	persist();
	return { ok: true, card: c };
}

/** 作废：未核销的可删（无退回，与激活码同规则）；已核销的留档不可删 */
export function deleteStorageCode(code: string): { ok: boolean; error?: string } {
	const c = db.codes.find((x) => x.code === code);
	if (!c) return { ok: false, error: "扩容卡不存在" };
	if (c.usedBy) return { ok: false, error: "该卡已被使用，留档不可删除" };
	db.codes = db.codes.filter((x) => x.code !== code);
	persist();
	return { ok: true };
}
