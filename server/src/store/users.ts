/**
 * 用户存储（文件持久化）。
 *
 * accessKey 是用户端的唯一凭证（登录 + 每请求 Bearer + 心跳都用它）。
 * 管理端可增删改查用户、启停、改额度、重置 accessKey。
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadJson, saveJson, genId, DATA_DIR } from "./db.ts";
import { config } from "../config.ts";
import { getDeviceLimit } from "./settings.ts";

export interface User {
	id: string;
	name: string;
	accessKey: string;
	enabled: boolean;
	note: string;
	credits: number;
	/** 累计消耗（总） */
	totalSpent: number;
	/** 当日消耗（配合 dailyDate 判定是否跨天清零） */
	dailySpent: number;
	/** dailySpent 所属日期 YYYY-MM-DD；与今天不一致则当日消耗视为 0 */
	dailyDate: string;
	/** 活跃设备表（P2 同时在线限制）：登录抢占制——新设备登录挤掉最久未活跃者；
	 *  设备 id=客户端 x-device-id 头（随机 UUID，无硬件语义；旧客户端 x-machine-code 头兼容收下）。
	 *  上限见 effectiveDeviceLimit。 */
	devices?: { id: string; at: string }[];
	/** 同时在线设备数覆盖（空=跟随全局默认 settings.deviceLimit=1；0=不限） */
	deviceLimit?: number;
	/** 登录账号（可选，注册/个人中心绑定后写入；全局唯一、小写归一）。
	 *  账号+密码只是登录便捷层；下游身份凭证恒为 accessKey（API 密钥，第218轮正名） */
	account?: string;
	passwordSalt?: string;
	/** scrypt(password, passwordSalt) 十六进制 */
	passwordHash?: string;
	/** 功能开关（字段缺省=开）：控制客户端可用模式，随登录/心跳下发；仅单模式时客户端隐藏切换交互键。
	 *  libtv：LibTV 授权入口；dreamina：即梦授权入口（均为个人中心连接 + Seedance 2.0 本地 CLI 生成，生成不经管理端不扣积分）。
	 *  modes（第130轮）：动态视频模式开关 modeId→bool（缺省/字段缺省=开）；关=该模式下模型客户端隐藏 + generate/batch 403。 */
	features?: { assetMode?: boolean; canvasMode?: boolean; editorMode?: boolean; libtv?: boolean; dreamina?: boolean; modes?: Record<string, boolean> };
	/** 归属渠道商 id（P2b：注册时填渠道商邀请码写入；空=平台直属用户） */
	agentId?: string;
	/** 收藏配额覆盖（P1，字节）：空=跟随全局默认 settings.favQuotaBytes（200MB）。
	 *  生效配额 = 本值(或全局默认) + 未过期扩容卡合计 */
	favQuotaBytes?: number;
	/** 个人邀请码（P2b）：`U` 前缀 7 位；新用户注册时可填 → 写进对方 invitedBy（邀请关系留档，
	 *  为后续邀请奖励留钩子）。懒生成（首次经 ensureUserInviteCode 取用时写入）。 */
	inviteCode?: string;
	/** 邀请人（P2b）：注册时填了某用户的个人邀请码 → 记录该用户 id */
	invitedBy?: string;
	createdAt: string;
	updatedAt: string;
	lastSeenAt?: string;
}

function todayKey(): string {
	return new Date().toISOString().slice(0, 10);
}

/** 当日消耗（跨天自动归零的展示值，不改存储） */
export function dailySpentToday(u: User): number {
	return u.dailyDate === todayKey() ? (u.dailySpent || 0) : 0;
}

const FILE = "users.json";
let users: User[] = loadJson<User[]>(FILE, []);

function persist(): void {
	saveJson(FILE, users);
}

export function genAccessKey(): string {
	return "qk-" + randomBytes(18).toString("hex");
}

const normAccount = (a: string): string => (a || "").trim().toLowerCase();

function hashPw(password: string, salt: string): string {
	return scryptSync(password, salt, 32).toString("hex");
}

// 首次启动播种一个默认用户，沿用约定的 dev accessKey，保证现有联调不断
if (users.length === 0) {
	const now = new Date().toISOString();
	users.push({
		id: genId("u"),
		name: "默认用户",
		accessKey: config.seedAccessKey,
		enabled: true,
		note: "首次启动自动创建",
		credits: 100000,
		totalSpent: 0,
		dailySpent: 0,
		dailyDate: "",
		createdAt: now,
		updatedAt: now,
	});
	persist();
}

// 兼容旧数据：补齐新增字段
for (const u of users) {
	if (typeof u.totalSpent !== "number") u.totalSpent = 0;
	if (typeof u.dailySpent !== "number") u.dailySpent = 0;
	if (typeof u.dailyDate !== "string") u.dailyDate = "";
}

// ── P4 清理收尾（第219轮）：剥离激活码/机器码时代的存量字段 ──
// machineCode（硬件绑定，第218轮起设备区分=随机 UUID）/ validityDays+expiresAt（有效期，
// P2b 绿地删除后语义已不存在——存量值只是死数据）。按字段存在性幂等；首次剥离前备份原文件留档
// （与 P1 agents 迁移同模式）。⚠ 只删死字段不动任何在役数据；不新增语义。
{
	const LEGACY_USER_KEYS = ["machineCode", "validityDays", "expiresAt"] as const;
	const dirty = users.filter((u) => LEGACY_USER_KEYS.some((k) => (u as unknown as Record<string, unknown>)[k] !== undefined));
	if (dirty.length) {
		try {
			const src = join(DATA_DIR, FILE);
			const bak = join(DATA_DIR, `${FILE}.bak-p4-cleanup`);
			if (existsSync(src) && !existsSync(bak)) copyFileSync(src, bak);
		} catch { /* 备份失败不阻塞启动（字段本就是死数据） */ }
		for (const u of dirty) for (const k of LEGACY_USER_KEYS) delete (u as unknown as Record<string, unknown>)[k];
		persist();
	}
}

// ── 用户级动态模式门禁退役（第228轮）：剥离存量 features.modes ──
// 用户定稿：用户管理只留功能形式模式（资产/画布/LibTV/即梦），渠道形式模式的管控走
// 「模式管理」全局启停 + 渠道商级整商硬闸（agents 的 features.modes **保留在役**，勿动）。
// 两控制台的用户级动态模式开关已删——存量行上残留的 modes 会隐形封 403 且再无开关可解，故启动剥净。
// 按字段存在性幂等；只删用户行上的 modes 子键，其余 features 四开关不动。
{
	const dirty = users.filter((u) => u.features && (u.features as Record<string, unknown>).modes !== undefined);
	if (dirty.length) {
		for (const u of dirty) delete (u.features as Record<string, unknown>).modes;
		persist();
	}
}

export function listUsers(): User[] {
	return [...users].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getUser(id: string): User | undefined {
	return users.find((u) => u.id === id);
}

/** 某渠道商名下的用户（新→旧） */
export function usersByAgent(agentId: string): User[] {
	return listUsers().filter((u) => u.agentId === agentId);
}

export function getUserByAccessKey(key: string): User | undefined {
	return users.find((u) => u.accessKey === key);
}

/** 按登录账号查用户（小写归一） */
export function getUserByAccount(account: string): User | undefined {
	const acc = normAccount(account);
	if (!acc) return undefined;
	return users.find((u) => u.account === acc);
}

/** 邮箱格式（宽松够用：本地段@域，域至少一个点） */
export const isEmailAccount = (s: string): boolean => /^[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9.-]+\.[a-z]{2,}$/.test(normAccount(s));
/** 大陆手机号格式 */
export const isPhoneAccount = (s: string): boolean => /^1[3-9]\d{9}$/.test(normAccount(s));

/** 账号格式与全局唯一校验（不落盘）。excludeUserId：允许某用户占用（改绑自身时用）。
 *  P2 起账号三种形态：邮箱 / 手机号 / 旧式用户名（3–32 位字母数字._-，存量兼容）。 */
export function validateAccount(account: string, excludeUserId?: string): { ok: boolean; error?: string } {
	const acc = normAccount(account);
	if (!isEmailAccount(acc) && !isPhoneAccount(acc) && !/^[a-z0-9_.-]{3,32}$/.test(acc)) {
		return { ok: false, error: "账号需为邮箱、手机号，或 3–32 位字母/数字/._-" };
	}
	const other = getUserByAccount(acc);
	if (other && other.id !== excludeUserId) return { ok: false, error: "该账号已被占用" };
	return { ok: true };
}

// ── 邀请码（P2b：取消激活码签发后，渠道商/用户的获客与邀请通道）──

/** 生成邀请码：前缀 + 7 位无易混字符（0O1IL 剔除）。prefix：U=个人 / A=渠道商 */
export function genInviteCode(prefix: "U" | "A"): string {
	const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
	let s = prefix;
	const bytes = randomBytes(7);
	for (let i = 0; i < 7; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
	return s;
}

/** 取用户个人邀请码（懒生成：首次取用时写入并查重落盘） */
export function ensureUserInviteCode(u: User): string {
	if (u.inviteCode) return u.inviteCode;
	let code = genInviteCode("U");
	while (users.some((x) => x.inviteCode === code)) code = genInviteCode("U");
	u.inviteCode = code;
	u.updatedAt = new Date().toISOString();
	persist();
	return code;
}

/** 按个人邀请码查用户（大小写不敏感） */
export function getUserByInviteCode(code: string): User | undefined {
	const c = (code || "").trim().toUpperCase();
	if (!c) return undefined;
	return users.find((u) => u.inviteCode === c);
}

/** 某用户已邀请的注册人数（invitedBy 计数） */
export function invitedCountOf(userId: string): number {
	return users.reduce((s, u) => s + (u.invitedBy === userId ? 1 : 0), 0);
}

/** 直接改密（P2 找回密码/个人中心改密用）；密码强度校验后落盘 */
export function setUserPassword(u: User, password: string): { ok: boolean; error?: string } {
	const pw = (password || "").trim();
	if (pw.length < 6) return { ok: false, error: "密码至少 6 位" };
	u.passwordSalt = randomBytes(16).toString("hex");
	u.passwordHash = hashPw(pw, u.passwordSalt);
	u.updatedAt = new Date().toISOString();
	persist();
	return { ok: true };
}

/**
 * 绑定账号+密码到用户（注册 / 个人中心绑定）：校验账号格式+唯一、密码强度后落盘。
 * 不改动 accessKey——它仍是下游请求的真凭证。
 */
export function bindAccount(u: User, account: string, password: string, name?: string): { ok: boolean; error?: string } {
	const v = validateAccount(account, u.id);
	if (!v.ok) return v;
	const pw = (password || "").trim();
	if (pw.length < 6) return { ok: false, error: "密码至少 6 位" };
	u.account = normAccount(account);
	u.passwordSalt = randomBytes(16).toString("hex");
	u.passwordHash = hashPw(pw, u.passwordSalt);
	// 用户名=用户自定义昵称；未提供则回退账号（保证注册后有非空用户名）
	const nm = (name || "").trim();
	if (nm) u.name = nm;
	else if (!u.name || !u.name.trim()) u.name = normAccount(account);
	u.updatedAt = new Date().toISOString();
	persist();
	return { ok: true };
}

/** 校验用户账号密码（timingSafeEqual 防时序侧信道）。未设密码一律 false。 */
export function verifyUserPassword(u: User, password: string): boolean {
	if (!u.passwordHash || !u.passwordSalt) return false;
	const cand = hashPw(password || "", u.passwordSalt);
	return cand.length === u.passwordHash.length && timingSafeEqual(Buffer.from(cand, "hex"), Buffer.from(u.passwordHash, "hex"));
}

export function createUser(input: Partial<Pick<User, "name" | "note" | "credits" | "enabled" | "accessKey" | "features" | "agentId" | "invitedBy">>): User {
	const now = new Date().toISOString();
	const user: User = {
		id: genId("u"),
		name: input.name?.trim() || "",
		accessKey: input.accessKey?.trim() || genAccessKey(),
		enabled: input.enabled ?? true,
		note: input.note ?? "",
		credits: input.credits ?? 0,
		features: input.features,
		agentId: input.agentId,
		invitedBy: input.invitedBy,
		totalSpent: 0,
		dailySpent: 0,
		dailyDate: "",
		createdAt: now,
		updatedAt: now,
	};
	users.push(user);
	persist();
	return user;
}

/** 最近 n 天的 UTC 日期串（YYYY-MM-DD），升序，末位为今天，与 dailyDate 口径一致。 */
function lastNDays(n: number): string[] {
	const out: string[] = [];
	const base = Date.now();
	for (let i = n - 1; i >= 0; i--) {
		out.push(new Date(base - i * 86400000).toISOString().slice(0, 10));
	}
	return out;
}

/** 用户维度统计（供管理端统计图表）。 */
export function userStats(): {
	total: number;
	enabled: number;
	disabled: number;
	bound: number;
	unbound: number;
	totalCredits: number;
	totalSpentAll: number;
	regByDay: { date: string; count: number }[];
	topSpenders: { name: string; spent: number; credits: number }[];
} {
	let enabled = 0, disabled = 0, bound = 0, unbound = 0, totalCredits = 0, totalSpentAll = 0;
	for (const u of users) {
		if (u.enabled) enabled++; else disabled++;
		if (u.account) bound++; else unbound++; // P2b：bound=已注册账号（机器码/激活码语义退役）
		totalCredits += u.credits || 0;
		totalSpentAll += u.totalSpent || 0;
	}
	const regByDay = lastNDays(30).map((date) => ({ date, count: 0 }));
	const regIdx = new Map(regByDay.map((r, i) => [r.date, i] as const));
	for (const u of users) {
		const i = regIdx.get((u.createdAt || "").slice(0, 10));
		if (i != null) regByDay[i].count++;
	}
	const topSpenders = [...users]
		.sort((a, b) => (b.totalSpent || 0) - (a.totalSpent || 0))
		.slice(0, 8)
		.filter((u) => (u.totalSpent || 0) > 0)
		.map((u) => ({ name: u.name, spent: u.totalSpent || 0, credits: u.credits || 0 }));
	return { total: users.length, enabled, disabled, bound, unbound, totalCredits, totalSpentAll, regByDay, topSpenders };
}

export function updateUser(id: string, patch: Partial<Omit<User, "id" | "createdAt">>): User | undefined {
	const u = getUser(id);
	if (!u) return undefined;
	Object.assign(u, patch, { updatedAt: new Date().toISOString() });
	persist();
	return u;
}

export function deleteUser(id: string): boolean {
	const before = users.length;
	users = users.filter((u) => u.id !== id);
	if (users.length !== before) {
		persist();
		// P1：级联清其收藏与扩容额度。⚠ dropOwnerFavorites 会先把这些资产的 last_ref_at 刷新，
		// 让它们走「被引用 +N 天」倒计时而不是立刻掉进「从未引用」档——删用户不等于删他的素材。
		// 动态 import 规避 users ↔ favorites 的模块环（favorites 只依赖 sqlite/db）。
		void import("./favorites.ts").then((m) => {
			m.dropOwnerFavorites("user", id);
			m.dropOwnerGrants("user", id);
		}).catch(() => { /* 清理失败不影响删用户本身；孤儿收藏行由 JOIN 自然过滤 */ });
		return true;
	}
	return false;
}

/** 消耗统计记账（当日跨天清零 + 累计）；delta 可负=回冲。不动余额。 */
function bumpSpendStats(u: User, delta: number): void {
	const today = todayKey();
	if (delta > 0) {
		if (u.dailyDate !== today) { u.dailyDate = today; u.dailySpent = 0; }
		u.dailySpent = (u.dailySpent || 0) + delta;
		u.totalSpent = (u.totalSpent || 0) + delta;
	} else if (delta < 0) {
		u.totalSpent = Math.max(0, (u.totalSpent || 0) + delta);
		if (u.dailyDate === today) u.dailySpent = Math.max(0, (u.dailySpent || 0) + delta);
	}
}

// ── 结算闸门用的低层原语（第183轮）──
// 生成链的扣费要把「用户 + 归属链各级渠道商」合成一次结算（store/credits.ts settle），
// 故这里拆出「只改内存、不落盘」与「落盘」两半，由 settle 统一决定落盘时机；
// 单账户的日常增减（充值/转账/管理端调整）仍走下面各自带 persist 的函数，不受影响。

/** 只改内存余额与消耗统计，不落盘。delta<0=扣、>0=退。返回 false=账户不存在或会透支。 */
export function applyUserCreditsDelta(payerId: string, statsUserId: string, delta: number): boolean {
	const payer = getUser(payerId);
	if (!payer) return false;
	if (payer.credits + delta < 0) return false;
	payer.credits += delta;
	payer.updatedAt = new Date().toISOString();
	const stats = payerId === statsUserId ? payer : getUser(statsUserId);
	if (stats) {
		bumpSpendStats(stats, -delta); // delta<0（扣款）=消耗增加
		stats.updatedAt = new Date().toISOString();
	}
	return true;
}

/** 读余额（结算闸门做 pre/post 快照用）；用户不存在返回 null */
export function userCredits(id: string): number | null {
	return getUser(id)?.credits ?? null;
}

/** 立即落盘 users.json（结算闸门在一次结算的所有内存变更完成后调用一次） */
export function persistUsers(): void {
	persist();
}

/**
 * 按请求扣减额度：余额足够则扣并持久化，返回 { ok, remaining }；
 * 不足返回 ok:false 且不扣；amount<=0 视为免费直接通过。
 */
export function chargeCredits(id: string, amount: number): { ok: boolean; remaining: number } {
	return chargeCreditsAs(id, id, amount);
}

/**
 * 团队共享积分扣费（第172轮）：余额从 payerId（共享模式=团长的池）扣，
 * 消耗统计记在 statsUserId（实际发起消耗的团员）名下——「钱归付款人、消耗归消耗人」。
 * payerId === statsUserId 时与 chargeCredits 完全等价。
 */
export function chargeCreditsAs(payerId: string, statsUserId: string, amount: number): { ok: boolean; remaining: number } {
	const payer = getUser(payerId);
	if (!payer) return { ok: false, remaining: 0 };
	if (amount <= 0) return { ok: true, remaining: payer.credits };
	if (payer.credits < amount) return { ok: false, remaining: payer.credits };
	payer.credits -= amount;
	payer.updatedAt = new Date().toISOString();
	const stats = payerId === statsUserId ? payer : getUser(statsUserId);
	if (stats) {
		bumpSpendStats(stats, amount);
		stats.updatedAt = new Date().toISOString();
	}
	persist();
	return { ok: true, remaining: payer.credits };
}

/**
 * 退款：异步任务后台失败时，把预扣的积分退回，并回冲消耗统计（当日/累计）。
 * amount<=0 或用户不存在则 no-op。
 */
export function refundCredits(id: string, amount: number): void {
	refundCreditsAs(id, id, amount);
}

/** 团队共享积分退款：余额退给 payerId、消耗统计回冲 statsUserId（chargeCreditsAs 的逆） */
export function refundCreditsAs(payerId: string, statsUserId: string, amount: number): void {
	const payer = getUser(payerId);
	if (!payer || amount <= 0) return;
	payer.credits += amount;
	payer.updatedAt = new Date().toISOString();
	const stats = payerId === statsUserId ? payer : getUser(statsUserId);
	if (stats) {
		bumpSpendStats(stats, -amount);
		stats.updatedAt = new Date().toISOString();
	}
	persist();
}

/**
 * 用户间积分转账（第172轮团队分发/收回）：from 扣 amount、to 加 amount（零和，不计消耗统计）。
 * 不透支：from 余额不足直接拒绝。amount 必须为正整数。
 */
export function transferCredits(fromId: string, toId: string, amount: number): { ok: boolean; error?: string } {
	const n = Math.floor(Number(amount) || 0);
	if (n <= 0) return { ok: false, error: "金额需为正整数" };
	const from = getUser(fromId);
	const to = getUser(toId);
	if (!from || !to) return { ok: false, error: "用户不存在" };
	if (from.credits < n) return { ok: false, error: `积分不足：需 ${n}，剩余 ${from.credits}` };
	from.credits -= n;
	to.credits += n;
	const now = new Date().toISOString();
	from.updatedAt = now;
	to.updatedAt = now;
	persist();
	return { ok: true };
}

/** 充值/兑换：仅增加余额，不计入消耗统计。返回新余额（用户不存在返回 undefined） */
export function grantCredits(id: string, amount: number): number | undefined {
	const u = getUser(id);
	if (!u) return undefined;
	if (amount > 0) {
		u.credits += amount;
		u.updatedAt = new Date().toISOString();
		persist();
	}
	return u.credits;
}

// ── P2 商业化改造：机器码硬绑定退役，换「同时在线设备限制」（登录抢占制）──

/** 该用户生效的同时在线设备上限：按用户覆盖 > 全局默认（1）；0=不限 */
export function effectiveDeviceLimit(u: User): number {
	const n = Math.floor(Number(u.deviceLimit));
	return Number.isFinite(n) && n >= 0 && u.deviceLimit != null ? n : getDeviceLimit();
}

/**
 * 登录抢占（P2）：本次登录设备成为活跃设备；超上限时挤掉**最久未活跃**的设备
 * （被挤设备后续请求 403 → 客户端既有「401/403 立即登出」逻辑自动退出）。
 * deviceId=客户端 x-machine-code 头（缺失按空串归一——同样占一个名额，防剥头绕过限制）。
 */
export function registerDeviceOnLogin(u: User, deviceId: string | undefined): void {
	const id = (deviceId ?? "").trim();
	const limit = effectiveDeviceLimit(u);
	const now = new Date().toISOString();
	if (limit <= 0) { // 不限：仍记录（供管理端观察），上限 20 条防膨胀
		u.devices = [{ id, at: now }, ...(u.devices ?? []).filter((d) => d.id !== id)].slice(0, 20);
	} else {
		u.devices = [{ id, at: now }, ...(u.devices ?? []).filter((d) => d.id !== id)]
			.sort((a, b) => (a.id === id ? -1 : b.id === id ? 1 : b.at.localeCompare(a.at)))
			.slice(0, limit);
	}
	u.updatedAt = now;
	persist();
}

/**
 * 逐请求设备校验（requireAccessKey 调用）：
 *  - 上限 0（不限）→ 放行；
 *  - 设备在活跃表 → 刷新活跃时间（内存，不落盘——与 lastSeen 同策略）放行；
 *  - 活跃表还有空位（含存量用户空表）→ 当场收编放行（P2 上线瞬间已登录的老客户端无感过渡）；
 *  - 表满且不在表 → 拒绝（已在其它设备登录）。
 */
export function checkDeviceAccess(u: User, deviceId: string | undefined): { ok: boolean; error?: string } {
	const id = (deviceId ?? "").trim();
	const limit = effectiveDeviceLimit(u);
	if (limit <= 0) return { ok: true };
	const list = u.devices ?? [];
	const hit = list.find((d) => d.id === id);
	if (hit) {
		hit.at = new Date().toISOString(); // 内存刷新，随其它写操作持久化
		return { ok: true };
	}
	if (list.length < limit) {
		u.devices = [...list, { id, at: new Date().toISOString() }];
		persist();
		return { ok: true };
	}
	return { ok: false, error: `该账号已在其它设备登录（同时在线上限 ${limit} 台）。如需在本机使用，请重新登录（将顶替最久未活跃的设备）` };
}

/** 校验 accessKey 是否对应一个启用的用户；顺便刷新 lastSeen */
export function touchByAccessKey(key: string): User | undefined {
	const u = getUserByAccessKey(key);
	if (!u || !u.enabled) return undefined;
	u.lastSeenAt = new Date().toISOString();
	// 不频繁落盘 lastSeen，避免心跳每次写文件——内存更新即可，随其它写操作持久化
	return u;
}
