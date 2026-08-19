/**
 * 团队存储（第172轮，文件持久化 teams.json）。
 *
 * 团队 = 用户互相绑定：开团者为**团长**，其余为团员（一个用户同时只能在一个团队）。
 *  - 开团需要**团队码**（管理端生成，一码开一团，核销不复用）；
 *  - **绑定=邀请-同意制（⚠ 经济安全，勿回退成团长单方面直绑）**：团长按登录账号发出邀请（invites），
 *    对方在自己的团队页**接受**才入团（可拒绝；团长可撤销；7 天未处理自动过期）——防团长强拉陌生人。
 *  - 积分方式由团长决定：
 *      dispatch（分发积分模式，默认）：团员消耗扣自己积分；团长可把自己的积分分发给团员/从团员收回（零和转账）。
 *      shared（共享积分模式）：团员消耗**直接扣团长积分**（共享池=团长余额，团员自己的积分不动）；
 *        计费接入见 routes.ts planBilling/applyBilling（扣款人=团长，请求记录仍记实际用户）。
 *  - **收回上限=分发净额（⚠ 经济安全，勿回退成任意收缴）**：granted 台账记录团长对每名团员的
 *    分发净额（分发 + / 收回 −），收回不得超过 min(净额, 团员当前余额)——团长永远动不到团员自有积分；
 *    团员退出/被移除/解散时，分发余量（同一口径）自动退回团长（防「入团领分发→退团带走」套利）。
 *  - 每个团队码默认附带一份共享素材库（开团自动创建、团员自动成为成员、解散随删；团长可删文件夹/素材），
 *    库的创建/级联在路由层完成（本 store 只记 sharedLibId，不 import sharedLibs 保持单向依赖）。
 *  - **成员不限归属**（第173轮用户定「自由点」）：跨渠道商/平台直属都可互相绑定成团。计费仍各按各的口径：
 *    共享模式扣团长池、用户售价按各自归属定价、渠道商链按**消耗者自己的归属链**逐笔结算——互不越界；
 *    团队共享库经 SharedLibrary.teamId 豁免受众隔离（仅团队成员可见，路由层判定）。
 * 写频率=用户操作级（非热路径），saveJson 同步落盘（小文件）。
 */
import { loadJson, saveJson, genId } from "./db.ts";
import { randomBytes } from "node:crypto";
import { getUser, transferCredits } from "./users.ts";
import { getTeamMemberLimit, normTeamLimit } from "./settings.ts";

export type TeamCreditMode = "shared" | "dispatch";

export interface Team {
	id: string; // tm_xxx
	name: string;
	leaderId: string;
	/** 团员 id 列表（不含团长） */
	memberIds: string[];
	creditMode: TeamCreditMode;
	/** 团队人数上限（**含团长**）按团覆盖（第173轮，管理端设）；空=跟随全局默认（settings.teamMemberLimit，缺省 50） */
	memberLimit?: number;
	/** 待接受的入团邀请（邀请-同意制）：对方接受才入团；7 天未处理过期（sanitize 懒清） */
	invites?: { userId: string; createdAt: string }[];
	/** 分发净额台账 userId → 团长对该团员的净分发（分发+ / 收回−，恒 ≥0）——收回上限与退团自动结算都按它 */
	granted?: Record<string, number>;
	/** 开团自动创建的团队共享素材库 id（路由层创建后写入；解散时级联删除） */
	sharedLibId?: string;
	/** 开团核销的团队码（留档） */
	code: string;
	createdAt: string;
	updatedAt: string;
}

export interface TeamCode {
	code: string; // tc-xxxxxxxx
	note?: string;
	/** 签发渠道商 id（第173轮：商在门户用**开码积分**生成；空=源站签发）。
	 *  仅作签发方留档/统计——**不限制使用者归属**（用户定「自由点」：任何用户凭码可开团）。 */
	agentId?: string;
	/** 已开团则记录团队 id（核销；团队解散后码不复用，留档可查） */
	usedByTeamId?: string;
	usedAt?: string;
	createdAt: string;
}

interface Db {
	teams: Team[];
	codes: TeamCode[];
}

const FILE = "teams.json";
const db: Db = { teams: [], codes: [], ...loadJson<Partial<Db>>(FILE, {}) };

function persist(): void {
	saveJson(FILE, db);
}

/** 生效人数上限（含团长）：本团覆盖 > 全局默认（管理端「团队」页可改，缺省 50） */
export function effectiveTeamLimit(t: Team): number {
	return normTeamLimit(t.memberLimit) ?? getTeamMemberLimit();
}

const INVITE_TTL_MS = 7 * 86400000;

/** 懒清理：被删用户从成员表/邀请表/台账剔除、过期邀请剔除；团长被删的团队视为解散（返回被解散的团队供路由层级联删共享库） */
export function sanitizeTeams(): Team[] {
	const dissolved: Team[] = [];
	let dirty = false;
	const now = Date.now();
	db.teams = db.teams.filter((t) => {
		if (!getUser(t.leaderId)) {
			dissolved.push(t);
			dirty = true;
			return false;
		}
		const alive = t.memberIds.filter((id) => !!getUser(id));
		if (alive.length !== t.memberIds.length) {
			t.memberIds = alive;
			dirty = true;
		}
		const inv = (t.invites ?? []).filter((i) => !!getUser(i.userId) && now - Date.parse(i.createdAt) < INVITE_TTL_MS);
		if (inv.length !== (t.invites ?? []).length) {
			t.invites = inv;
			dirty = true;
		}
		for (const uid of Object.keys(t.granted ?? {})) {
			if (!t.memberIds.includes(uid)) {
				delete t.granted![uid];
				dirty = true;
			}
		}
		return true;
	});
	if (dirty) persist();
	return dissolved;
}

export function listTeams(): Team[] {
	return [...db.teams].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getTeam(id: string): Team | undefined {
	return db.teams.find((t) => t.id === id);
}

/** 用户所在团队（团长或团员；一个用户同时只能在一个团队） */
export function teamOfUser(userId: string): Team | undefined {
	return db.teams.find((t) => t.leaderId === userId || t.memberIds.includes(userId));
}

export type TeamResult = { ok: true; team: Team } | { ok: false; error: string };

/** 开团：校验团队码（存在且未核销）+ 团长不在任何团队 + 团名合法，核销码并建团 */
export function createTeam(input: { code?: string; name?: string; leaderId: string }): TeamResult {
	const name = (input.name || "").trim();
	if (!name || name.length > 20) return { ok: false, error: "团队名需 1–20 字" };
	const codeStr = (input.code || "").trim();
	if (!codeStr) return { ok: false, error: "缺少团队码" };
	const code = db.codes.find((c) => c.code === codeStr);
	if (!code) return { ok: false, error: "团队码无效" };
	if (code.usedByTeamId) return { ok: false, error: "该团队码已被使用" };
	// 团队码不限归属（第173轮用户定「自由点」）：任何用户拿到码都能开团；agentId 仅作签发方留档
	if (teamOfUser(input.leaderId)) return { ok: false, error: "你已在一个团队中（先退出/解散后才能开团）" };
	if (db.teams.some((t) => t.name === name)) return { ok: false, error: "已存在同名团队" };
	const now = new Date().toISOString();
	const team: Team = {
		id: genId("tm"),
		name,
		leaderId: input.leaderId,
		memberIds: [],
		creditMode: "dispatch",
		code: code.code,
		createdAt: now,
		updatedAt: now,
	};
	db.teams.push(team);
	code.usedByTeamId = team.id;
	code.usedAt = now;
	persist();
	return { ok: true, team };
}

export function updateTeam(id: string, patch: { name?: string; creditMode?: TeamCreditMode; memberLimit?: number | null; sharedLibId?: string }): TeamResult {
	const t = getTeam(id);
	if (!t) return { ok: false, error: "团队不存在" };
	if (patch.name !== undefined) {
		const name = patch.name.trim();
		if (!name || name.length > 20) return { ok: false, error: "团队名需 1–20 字" };
		if (db.teams.some((x) => x.name === name && x.id !== id)) return { ok: false, error: "已存在同名团队" };
		t.name = name;
	}
	if (patch.creditMode !== undefined) {
		if (patch.creditMode !== "shared" && patch.creditMode !== "dispatch") return { ok: false, error: "积分方式无效" };
		t.creditMode = patch.creditMode;
	}
	// 人数上限按团覆盖（管理端设）：null/非法=清除跟随全局默认；不做「压到低于现有人数」拦截——只影响后续加人
	if (patch.memberLimit !== undefined) t.memberLimit = normTeamLimit(patch.memberLimit);
	if (patch.sharedLibId !== undefined) t.sharedLibId = patch.sharedLibId;
	t.updatedAt = new Date().toISOString();
	persist();
	return { ok: true, team: t };
}

// ── 邀请-同意制（⚠ 经济安全：入团必须对方接受，勿回退成团长单方面直绑） ──

/** 团长发出邀请：目标不在任何团队、未被本团重复邀请、未满员（满员判定含待接受邀请，防超发） */
export function inviteToTeam(teamId: string, userId: string): TeamResult {
	const t = getTeam(teamId);
	if (!t) return { ok: false, error: "团队不存在" };
	if (t.leaderId === userId) return { ok: false, error: "不能邀请自己" };
	if (teamOfUser(userId)) return { ok: false, error: "对方已在一个团队中" };
	const invites = t.invites ?? (t.invites = []);
	if (invites.some((i) => i.userId === userId)) return { ok: false, error: "已向对方发出邀请，等待其在个人中心「团队」页接受" };
	const limit = effectiveTeamLimit(t);
	if (t.memberIds.length + 1 + invites.length >= limit) return { ok: false, error: `团队人数已达上限（${limit} 人，含团长与待接受邀请）` };
	invites.push({ userId, createdAt: new Date().toISOString() });
	t.updatedAt = new Date().toISOString();
	persist();
	return { ok: true, team: t };
}

/** 撤销邀请（团长）/ 拒绝邀请（被邀请人）共用：从邀请表移除 */
export function removeInvite(teamId: string, userId: string): boolean {
	const t = getTeam(teamId);
	if (!t || !(t.invites ?? []).some((i) => i.userId === userId)) return false;
	t.invites = (t.invites ?? []).filter((i) => i.userId !== userId);
	t.updatedAt = new Date().toISOString();
	persist();
	return true;
}

/** 某用户收到的待处理邀请（非过期；随 sanitizeTeams 懒清） */
export function invitesForUser(userId: string): Array<{ team: Team; createdAt: string }> {
	const now = Date.now();
	const out: Array<{ team: Team; createdAt: string }> = [];
	for (const t of db.teams) {
		const inv = (t.invites ?? []).find((i) => i.userId === userId);
		if (inv && now - Date.parse(inv.createdAt) < INVITE_TTL_MS) out.push({ team: t, createdAt: inv.createdAt });
	}
	return out;
}

/** 被邀请人**接受**邀请才真正入团（唯一入团路径）；入团后清掉该用户在所有团队的其它待处理邀请 */
export function acceptInvite(teamId: string, userId: string): TeamResult {
	const t = getTeam(teamId);
	if (!t) return { ok: false, error: "团队不存在（可能已解散）" };
	if (!(t.invites ?? []).some((i) => i.userId === userId)) return { ok: false, error: "邀请不存在或已过期" };
	if (teamOfUser(userId)) return { ok: false, error: "你已在一个团队中" };
	const limit = effectiveTeamLimit(t);
	if (t.memberIds.length + 1 >= limit) return { ok: false, error: `该团队人数已达上限（${limit} 人，含团长）` };
	t.memberIds.push(userId);
	for (const x of db.teams) {
		if (x.invites?.some((i) => i.userId === userId)) x.invites = x.invites.filter((i) => i.userId !== userId);
	}
	t.updatedAt = new Date().toISOString();
	persist();
	return { ok: true, team: t };
}

// ── 分发净额台账（⚠ 经济安全：收回/退团结算只认它，团长永远动不到团员自有积分） ──

/** 团长对某团员的分发净额（=收回上限的基数；另受团员当前余额约束） */
export function grantedOf(teamId: string, userId: string): number {
	return Math.max(0, Math.floor(getTeam(teamId)?.granted?.[userId] ?? 0));
}

/** 分发/收回后登记净额（delta 正=分发、负=收回；下限 0 防御浮点/越界） */
export function bumpGranted(teamId: string, userId: string, delta: number): void {
	const t = getTeam(teamId);
	if (!t) return;
	const g = t.granted ?? (t.granted = {});
	g[userId] = Math.max(0, Math.floor((g[userId] ?? 0) + delta));
	if (g[userId] === 0) delete g[userId];
	persist();
}

/** 退团结算（退出/移除/解散共用）：把分发余量 min(净额, 团员当前余额) 自动退回团长并清台账。
 *  返回实退数——只结算团长分发过的部分，绝不触碰团员自有积分（防「入团领分发→退团带走」套利）。 */
export function settleMemberGrant(teamId: string, userId: string): number {
	const t = getTeam(teamId);
	if (!t) return 0;
	const granted = grantedOf(teamId, userId);
	const back = Math.min(granted, getUser(userId)?.credits ?? 0);
	if (back > 0 && getUser(t.leaderId)) transferCredits(userId, t.leaderId, back);
	if (t.granted?.[userId] !== undefined) {
		delete t.granted[userId];
		persist();
	}
	return back;
}

export function removeTeamMember(teamId: string, userId: string): TeamResult {
	const t = getTeam(teamId);
	if (!t) return { ok: false, error: "团队不存在" };
	if (!t.memberIds.includes(userId)) return { ok: false, error: "该用户不在团队中" };
	t.memberIds = t.memberIds.filter((id) => id !== userId);
	if (t.granted) delete t.granted[userId];
	t.updatedAt = new Date().toISOString();
	persist();
	return { ok: true, team: t };
}

/** 解散团队（团队码不复用；共享库级联删除由路由层做） */
export function dissolveTeam(id: string): Team | undefined {
	const t = getTeam(id);
	if (!t) return undefined;
	db.teams = db.teams.filter((x) => x.id !== id);
	persist();
	return t;
}

// ── 团队码（管理端/渠道商门户生成，作废；开团核销） ──

export function listTeamCodes(): TeamCode[] {
	return [...db.codes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 某渠道商签发的团队码（门户「团队」页） */
export function listTeamCodesByAgent(agentId: string): TeamCode[] {
	return listTeamCodes().filter((c) => c.agentId === agentId);
}

export function getTeamCode(code: string): TeamCode | undefined {
	return db.codes.find((c) => c.code === code);
}

export function createTeamCodes(count: number, note?: string, agentId?: string): TeamCode[] {
	const n = Math.max(1, Math.min(200, Math.floor(count) || 1));
	const now = new Date().toISOString();
	const made: TeamCode[] = [];
	for (let i = 0; i < n; i++) {
		made.push({ code: "tc-" + randomBytes(8).toString("hex"), note: note?.trim() || undefined, agentId, createdAt: now });
	}
	db.codes.push(...made);
	persist();
	return made;
}

/** 删除团队码：未使用的可删；已开团的仅当团队已解散（留档无意义）才可删，团队仍存在不可删 */
export function deleteTeamCode(code: string): { ok: boolean; error?: string } {
	const c = db.codes.find((x) => x.code === code);
	if (!c) return { ok: false, error: "团队码不存在" };
	if (c.usedByTeamId && getTeam(c.usedByTeamId)) return { ok: false, error: "该码已开团且团队仍存在，不可删除" };
	db.codes = db.codes.filter((x) => x.code !== code);
	persist();
	return { ok: true };
}
