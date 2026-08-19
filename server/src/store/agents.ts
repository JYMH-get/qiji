/**
 * 渠道商（Agent）存储（文件持久化）。
 *
 * P1 经济模型翻转（2026-08-09 商业化改造，方案见 docs/商业化改造方案.md）：
 *  - **统一定价**：所有用户按源站平台价扣费，渠道商不再有 售价/结算价/签发价 任何定价维度；
 *  - **预购积分池 + 分发实扣**：渠道商从源站买积分（管理端分发 credits），给名下用户发积分
 *    （兑换码/激活码面额）时按面额从池里真实划转；用户消耗只扣用户自己，不再链式结算；
 *  - **开码积分（codeCredits）整体退役**：签发免费，旧余额随迁移清零舍弃；
 *  - **多级渠道商链拍平**：parentAgentId 退役，所有渠道商平级、统一由源站管理。
 *  旧字段（modelPricing、costPricing、codePricing、codeSalePricing、defaultSub 两表、
 *  codeCredits、parentAgentId）由启动迁移剥离（先备份 agents.json 留档）。
 *
 * 与用户端 accessKey / 管理端 ADMIN_TOKEN 并列的第三套鉴权：账号+密码登录换取内存会话 token。
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadJson, saveJson, genId, DATA_DIR } from "./db.ts";
import { genInviteCode } from "./users.ts";

/**
 * 「源站」虚拟受众 id：平台直属用户（User.agentId 为空）在 模板/模型 开放控制里作为
 * 一个与渠道商并列的受众管理（第110轮，用户定「将源站作为一个渠道商管理」）。
 * shareAgentIds 里出现该 id = 开放给源站直属用户。不是真实 Agent 记录，仅用于受众匹配。
 */
export const PLATFORM_AUDIENCE = "platform";

/** 用户归属 → 受众 id（直属用户 = 源站） */
export const audienceOf = (agentId?: string): string => agentId || PLATFORM_AUDIENCE;

// ── 渠道商分组（第167轮）────────────────────────────────────────────────
// 分组 = 受众（渠道商 + 源站）的管理维度：模型「开放范围」按分组勾选（后期商多了好管理）。
// **源站也是一个受众**，与渠道商一样归属某个分组（缺省=默认分组）。
// 有且至少有「默认分组」（不可删除；删除其它分组时成员回落于此）。
// P1 起分组不再承载定价（原分组默认结算价随统一定价退役）。

export interface AgentGroup {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
}

interface GroupStore {
	groups: AgentGroup[];
	/** 源站（平台直属用户受众）所在分组 id；缺省/分组已删 = 默认分组 */
	platformGroupId?: string;
}

export const DEFAULT_GROUP_ID = "grp-default";
const GROUP_FILE = "agent-groups.json";
const groupStore: GroupStore = loadJson<GroupStore>(GROUP_FILE, { groups: [] });
if (!Array.isArray(groupStore.groups)) groupStore.groups = [];
// 种默认分组（有且至少有它）
if (!groupStore.groups.some((g) => g.id === DEFAULT_GROUP_ID)) {
	const now = new Date().toISOString();
	groupStore.groups.unshift({ id: DEFAULT_GROUP_ID, name: "默认分组", createdAt: now, updatedAt: now });
	saveJson(GROUP_FILE, groupStore);
}
function persistGroups(): void {
	saveJson(GROUP_FILE, groupStore);
}

export function listAgentGroups(): AgentGroup[] {
	return groupStore.groups;
}
export function getAgentGroup(id?: string): AgentGroup | undefined {
	return id ? groupStore.groups.find((g) => g.id === id) : undefined;
}

/** 受众（渠道商 id / 源站 PLATFORM_AUDIENCE）→ 生效分组 id（未设/所在分组已删 = 默认分组） */
export function audienceGroupId(aud: string): string {
	const gid = aud === PLATFORM_AUDIENCE ? groupStore.platformGroupId : getAgent(aud)?.groupId;
	return getAgentGroup(gid) ? (gid as string) : DEFAULT_GROUP_ID;
}

export function createAgentGroup(name: string): { ok: true; group: AgentGroup } | { ok: false; error: string } {
	const n = (name || "").trim();
	if (!n) return { ok: false, error: "请填分组名称" };
	if (groupStore.groups.some((g) => g.name === n)) return { ok: false, error: "同名分组已存在" };
	const now = new Date().toISOString();
	const group: AgentGroup = { id: genId("grp"), name: n, createdAt: now, updatedAt: now };
	groupStore.groups.push(group);
	persistGroups();
	return { ok: true, group };
}

export function renameAgentGroup(id: string, name: string): { ok: boolean; error?: string } {
	const g = getAgentGroup(id);
	if (!g) return { ok: false, error: "分组不存在" };
	const n = (name || "").trim();
	if (!n) return { ok: false, error: "请填分组名称" };
	g.name = n;
	g.updatedAt = new Date().toISOString();
	persistGroups();
	return { ok: true };
}

/** 删除分组：默认分组不可删；成员（渠道商/源站）回落默认分组（成员商 bump pricingVersion——
 *  分组变化可能改变模型开放范围，其名下用户 catalog 须热更；源站受影响由调用方 touchModelsVersion 全局刷新）。 */
export function deleteAgentGroup(id: string): { ok: boolean; error?: string; platformMoved?: boolean } {
	if (id === DEFAULT_GROUP_ID) return { ok: false, error: "默认分组不可删除" };
	const before = groupStore.groups.length;
	groupStore.groups = groupStore.groups.filter((g) => g.id !== id);
	if (groupStore.groups.length === before) return { ok: false, error: "分组不存在" };
	let agentTouched = false;
	for (const a of agents) {
		if (a.groupId === id) {
			delete a.groupId;
			a.pricingVersion = (a.pricingVersion ?? 0) + 1;
			a.updatedAt = new Date().toISOString();
			agentTouched = true;
		}
	}
	const platformMoved = groupStore.platformGroupId === id;
	if (platformMoved) delete groupStore.platformGroupId;
	persistGroups();
	if (agentTouched) persist();
	return { ok: true, platformMoved };
}

/** 设置渠道商所属分组（null/默认分组 id = 回落默认）。变化 bump pricingVersion（分组决定
 *  模型开放范围 → 其名下用户 catalog 须热更，经 .p 段版本生效）。 */
export function setAgentGroup(agentId: string, groupId: string | null): { ok: boolean; error?: string } {
	const a = getAgent(agentId);
	if (!a) return { ok: false, error: "渠道商不存在" };
	const gid = groupId && groupId !== DEFAULT_GROUP_ID ? groupId : undefined;
	if (gid && !getAgentGroup(gid)) return { ok: false, error: "分组不存在" };
	if ((a.groupId ?? undefined) === gid) return { ok: true }; // 幂等
	if (gid) a.groupId = gid;
	else delete a.groupId;
	a.pricingVersion = (a.pricingVersion ?? 0) + 1;
	a.updatedAt = new Date().toISOString();
	persist();
	return { ok: true };
}

/** 设置源站所属分组（影响平台直属用户的模型开放范围——调用方须 touchModelsVersion 让其 catalog 热更） */
export function setPlatformGroup(groupId: string | null): { ok: boolean; error?: string } {
	const gid = groupId && groupId !== DEFAULT_GROUP_ID ? groupId : undefined;
	if (gid && !getAgentGroup(gid)) return { ok: false, error: "分组不存在" };
	if (gid) groupStore.platformGroupId = gid;
	else delete groupStore.platformGroupId;
	persistGroups();
	return { ok: true };
}

/**
 * 渠道商级可用模式（第121轮：源站对整个渠道商的模式管控）。
 * 与 User.features 同形；字段缺省=开。语义=**整商硬闸**：商关的模式，其名下用户
 * 无论自身 features 如何一律不可用（下发时 AND 合成）；商开=按用户自身设置。
 */
export interface AgentFeatures {
	assetMode?: boolean;
	canvasMode?: boolean;
	editorMode?: boolean;
	libtv?: boolean;
	dreamina?: boolean;
	/** 动态视频模式硬闸（第130轮）modeId→bool（缺省=开）：商关的模式其名下用户一律不可用（AND 合成） */
	modes?: Record<string, boolean>;
}

/** 归一模式开关表：只保留布尔值（关=false），空表回 undefined */
export function normModeGates(m?: Record<string, boolean>): Record<string, boolean> | undefined {
	if (!m || typeof m !== "object") return undefined;
	const out: Record<string, boolean> = {};
	for (const [k, v] of Object.entries(m)) if (k) out[k] = v !== false;
	return Object.keys(out).length ? out : undefined;
}

/** 逐级 AND 合成模式开关（缺省=开）：base 与 af 里任一为 false 即 false */
function composeModes(base?: Record<string, boolean>, af?: Record<string, boolean>): Record<string, boolean> | undefined {
	if (!base && !af) return undefined;
	const out: Record<string, boolean> = { ...(base ?? {}) };
	for (const [k, v] of Object.entries(af ?? {})) out[k] = out[k] !== false && v !== false;
	return Object.keys(out).length ? out : undefined;
}

export interface Agent {
	id: string;
	name: string;
	/** 登录账号（全局唯一，小写归一存储） */
	account: string;
	salt: string;
	/** scrypt(password, salt) 十六进制 */
	passwordHash: string;
	/** 积分池余额（P1 起唯一的钱袋子）：源站分发充入；给名下用户发积分（兑换码/激活码面额）时按面额实扣 */
	credits: number;
	enabled: boolean;
	note: string;
	/** 模型显示名覆盖（第138轮）：modelId → 渠道商给模型改的名（门户「模型」页维护；
	 *  只影响**显示**——catalog 下发给名下用户的 label 用它（未设=平台名），
	 *  计费/协议/id 一概不变。改名 bump pricingVersion 触发用户 catalog 热更。 */
	modelLabels?: Record<string, string>;
	/** 目录版本（沿用旧名 pricingVersion 兼容存量数据）：改名/启停模型/换分组 +1，
	 *  并入名下用户 catalog version（.p 段）触发客户端热更。P1 起与定价无关。 */
	pricingVersion?: number;
	/** 共享素材库开关（第120轮「对允许的渠道商开放」）：缺省=开；关=该商门户不可建/管共享库（存量库仍在但其用户端仍可用，管理员按需删） */
	allowSharedLib?: boolean;
	/** 渠道商级可用模式（第121轮）：缺省/字段缺省=全开；关=该商名下用户一律不可用（硬闸，AND 合成后随登录/心跳下发） */
	features?: AgentFeatures;
	/** 渠道商级模型禁用清单（第121轮）：源站/本商禁止使用的模型 id。命中=其名下用户 catalog 不下发、
	 *  generate/batch 403、门户「模型」页显示为停用。与模型侧 shareScope（开放范围）双闸并存，任一不过即不可用。 */
	blockedModels?: string[];
	/** 所属分组 id（第167轮渠道商分组）：缺省/分组已删=默认分组（audienceGroupId 一把尺解析）。
	 *  分组决定模型「开放范围（按分组）」命中。 */
	groupId?: string;
	/** 渠道商邀请码（P2b，替代激活码获客）：`A` 前缀 7 位；用户注册时填它 → 归属本商名下。
	 *  创建即生成；存量商由启动补齐。 */
	inviteCode?: string;
	/** 渠道节点密钥（P3 独立部署）：`ank-` 前缀；渠道商自部署的 relay 节点凭它走源站 /v1 协议，
	 *  计费落本商积分池。按需生成（管理端/门户按钮），未部署节点的商没有。重置=旧密钥立即失效。 */
	nodeKey?: string;
	createdAt: string;
	updatedAt: string;
	lastSeenAt?: string;
}

const FILE = "agents.json";
let agents: Agent[] = loadJson<Agent[]>(FILE, []);

function persist(): void {
	saveJson(FILE, agents);
}

// ── P1 一次性迁移（2026-08 商业化改造，幂等按字段存在性判定）────────────────
// 剥离定价/开码积分/层级字段：modelPricing、costPricing、codePricing、codeSalePricing、
// defaultSubCostPricing、defaultSubCodePricing、codeCredits（余额清零舍弃，用户拍板）、
// parentAgentId（链拍平：存量下级商升为源站直连）。首次剥离前把原文件备份留档。
// 分组的旧 costPricing（分组默认结算价）一并剥离（agent-groups.json 同规备份）。
{
	const LEGACY_AGENT_KEYS = [
		"parentAgentId", "codeCredits", "modelPricing", "costPricing",
		"codePricing", "codeSalePricing", "defaultSubCostPricing", "defaultSubCodePricing",
	] as const;
	const dirtyAgents = (agents as unknown as Record<string, unknown>[]).filter(
		(a) => LEGACY_AGENT_KEYS.some((k) => a[k] !== undefined),
	);
	if (dirtyAgents.length) {
		const bak = join(DATA_DIR, "agents.json.bak-p1-unified-pricing");
		const src = join(DATA_DIR, FILE);
		if (!existsSync(bak) && existsSync(src)) copyFileSync(src, bak);
		for (const a of dirtyAgents) for (const k of LEGACY_AGENT_KEYS) delete a[k];
		persist();
	}
	const dirtyGroups = (groupStore.groups as unknown as Record<string, unknown>[]).filter(
		(g) => g.costPricing !== undefined,
	);
	if (dirtyGroups.length) {
		const bak = join(DATA_DIR, "agent-groups.json.bak-p1-unified-pricing");
		const src = join(DATA_DIR, GROUP_FILE);
		if (!existsSync(bak) && existsSync(src)) copyFileSync(src, bak);
		for (const g of dirtyGroups) delete g.costPricing;
		persistGroups();
	}
}

// P2b：存量渠道商补齐邀请码（幂等按字段存在性）
{
	let touched = false;
	for (const a of agents) {
		if (!a.inviteCode) {
			let code = genInviteCode("A");
			while (agents.some((x) => x.inviteCode === code)) code = genInviteCode("A");
			a.inviteCode = code;
			touched = true;
		}
	}
	if (touched) persist();
}

// ── 渠道节点密钥（P3 独立部署）──────────────────────────────────────

/** 按节点密钥查商（ank- 全串精确匹配；auth.ts 节点鉴权用） */
export function getAgentByNodeKey(key: string): Agent | undefined {
	const k = (key || "").trim();
	if (!k.startsWith("ank-")) return undefined;
	return agents.find((a) => a.nodeKey === k);
}

/** 生成/重置节点密钥（重置=旧密钥立即失效——线上节点须同步换 SOURCE_NODE_KEY） */
export function regenerateAgentNodeKey(id: string): Agent | undefined {
	const a = getAgent(id);
	if (!a) return undefined;
	a.nodeKey = "ank-" + randomBytes(24).toString("hex");
	a.updatedAt = new Date().toISOString();
	persist();
	return a;
}

/** 节点请求刷活跃（lastSeenAt；节流落盘防高频请求把 agents.json 写穿） */
let _nodeTouchPersistedAt = 0;
export function touchAgentNode(a: Agent): void {
	a.lastSeenAt = new Date().toISOString();
	const now = Date.now();
	if (now - _nodeTouchPersistedAt > 60_000) {
		_nodeTouchPersistedAt = now;
		persist();
	}
}

/** 按渠道商邀请码查商（大小写不敏感；注册归属用） */
export function getAgentByInviteCode(code: string): Agent | undefined {
	const c = (code || "").trim().toUpperCase();
	if (!c) return undefined;
	return agents.find((a) => a.inviteCode === c);
}

const normAccount = (a: string) => (a || "").trim().toLowerCase();

function hashPw(password: string, salt: string): string {
	return scryptSync(password, salt, 32).toString("hex");
}

export function listAgents(): Agent[] {
	return [...agents].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * 归属「链」（P1 拍平后退化为单级）：用户的直属渠道商本身；直属用户为空。
 * 保留函数形态是因为 feature 闸/模型禁用/显示名等消费点都以「链」遍历书写，拍平后语义不变。
 */
export function agentChain(agentId?: string): Agent[] {
	const a = agentId ? getAgent(agentId) : undefined;
	return a ? [a] : [];
}

/** 受众链（P1 拍平后=单受众）：用户直属商 id；直属用户 = [源站]。模型/模板 shareScope=select 命中即开放。 */
export function audienceChain(agentId?: string): string[] {
	const chain = agentChain(agentId);
	return chain.length ? chain.map((a) => a.id) : [PLATFORM_AUDIENCE];
}

/** 目录版本（沿用旧名）：该商改模型显示名/启停模型/换分组都 bump 自己的 pricingVersion →
 *  名下用户 catalog version（.p 段）变化 → 客户端热更。 */
export function chainPricingVersion(agentId?: string): number {
	return agentChain(agentId).reduce((s, a) => s + (a.pricingVersion ?? 0), 0);
}

export function getAgent(id: string): Agent | undefined {
	return agents.find((a) => a.id === id);
}

export function getAgentByAccount(account: string): Agent | undefined {
	const acc = normAccount(account);
	return agents.find((a) => a.account === acc);
}

/** 对外脱敏视图（不含 salt / passwordHash） */
export function publicAgent(a: Agent): Omit<Agent, "salt" | "passwordHash"> {
	const { salt, passwordHash, ...rest } = a;
	return rest;
}

export type CreateAgentResult = { ok: true; agent: Agent } | { ok: false; error: string };

export function createAgent(input: {
	name?: string;
	account?: string;
	password?: string;
	credits?: number;
	note?: string;
	enabled?: boolean;
}): CreateAgentResult {
	const account = normAccount(input.account || "");
	if (!account) return { ok: false, error: "缺少登录账号" };
	if (!/^[a-z0-9_.-]{3,32}$/.test(account)) return { ok: false, error: "账号需 3–32 位，仅限字母/数字/._-" };
	if (getAgentByAccount(account)) return { ok: false, error: "该登录账号已存在" };
	const password = (input.password || "").trim();
	if (password.length < 6) return { ok: false, error: "密码至少 6 位" };
	const now = new Date().toISOString();
	const salt = randomBytes(16).toString("hex");
	let inviteCode = genInviteCode("A");
	while (agents.some((x) => x.inviteCode === inviteCode)) inviteCode = genInviteCode("A");
	const agent: Agent = {
		id: genId("ag"),
		name: input.name?.trim() || account,
		account,
		salt,
		passwordHash: hashPw(password, salt),
		credits: Math.max(0, Math.floor(Number(input.credits) || 0)),
		enabled: input.enabled ?? true,
		note: input.note ?? "",
		inviteCode,
		createdAt: now,
		updatedAt: now,
	};
	agents.push(agent);
	persist();
	return { ok: true, agent };
}

export type UpdateAgentResult = { ok: true; agent: Agent } | { ok: false; error: string };

/** 更新渠道商基础信息；password 非空则改密；account 变更查重。credits 不走这里（用 changeAgentCredits）。 */
export function updateAgent(id: string, patch: {
	name?: string;
	account?: string;
	note?: string;
	enabled?: boolean;
	password?: string;
	allowSharedLib?: boolean;
	features?: AgentFeatures;
}): UpdateAgentResult {
	const a = getAgent(id);
	if (!a) return { ok: false, error: "渠道商不存在" };
	if (patch.account !== undefined) {
		const acc = normAccount(patch.account);
		if (!/^[a-z0-9_.-]{3,32}$/.test(acc)) return { ok: false, error: "账号需 3–32 位，仅限字母/数字/._-" };
		const other = getAgentByAccount(acc);
		if (other && other.id !== id) return { ok: false, error: "该登录账号已被占用" };
		a.account = acc;
	}
	if (patch.name !== undefined) a.name = patch.name.trim() || a.account;
	if (patch.note !== undefined) a.note = patch.note;
	if (patch.enabled !== undefined) a.enabled = patch.enabled;
	if (patch.allowSharedLib !== undefined) a.allowSharedLib = patch.allowSharedLib;
	if (patch.features !== undefined) {
		const f = patch.features ?? {};
		// 与用户级同一约束：资产/画布/实时剪辑三个主模式不允许全关（整商全关=名下用户无界面可用）
		if (f.assetMode === false && f.canvasMode === false && f.editorMode === false) {
			return { ok: false, error: "资产、画布与实时剪辑模式不能全部关闭" };
		}
		a.features = {
			assetMode: f.assetMode !== false,
			canvasMode: f.canvasMode !== false,
			editorMode: f.editorMode !== false,
			libtv: f.libtv !== false,
			dreamina: f.dreamina !== false,
			modes: normModeGates(f.modes),
		};
	}
	if (patch.password) {
		if (patch.password.trim().length < 6) return { ok: false, error: "密码至少 6 位" };
		a.salt = randomBytes(16).toString("hex");
		a.passwordHash = hashPw(patch.password.trim(), a.salt);
	}
	a.updatedAt = new Date().toISOString();
	persist();
	return { ok: true, agent: a };
}

export function deleteAgent(id: string): boolean {
	const before = agents.length;
	agents = agents.filter((a) => a.id !== id);
	if (agents.length !== before) {
		persist();
		return true;
	}
	return false;
}

// ── 结算闸门用的低层原语（第183轮，与 users.ts 同款）──
// P1 后渠道商积分不再参与生成结算（settle agents 恒空），但退款/对账仍要能原路退回
// **切换前**的历史扣款（billing 快照里带 agentCosts），故原语保留。

/** 只改内存余额，不落盘。delta<0=扣、>0=退。返回 false=渠道商不存在或会透支。 */
export function applyAgentCreditsDelta(id: string, delta: number): boolean {
	const a = getAgent(id);
	if (!a) return false;
	if (a.credits + delta < 0) return false;
	a.credits += delta;
	a.updatedAt = new Date().toISOString();
	return true;
}

/** 读余额（结算闸门做 pre/post 快照用）；渠道商不存在返回 null */
export function agentCredits(id: string): number | null {
	return getAgent(id)?.credits ?? null;
}

/** 立即落盘 agents.json（结算闸门在一次结算的所有内存变更完成后调用一次） */
export function persistAgents(): void {
	persist();
}

/**
 * 积分变动（管理员分发 delta>0 / 扣回 delta<0；P1 起门户发码面额实扣/作废退回也走这里）。
 * 扣减不得使余额为负。
 */
export function changeAgentCredits(id: string, delta: number): { ok: boolean; balance: number; error?: string } {
	const a = getAgent(id);
	if (!a) return { ok: false, balance: 0, error: "渠道商不存在" };
	const d = Math.floor(Number(delta) || 0);
	if (d < 0 && a.credits + d < 0) return { ok: false, balance: a.credits, error: "余额不足，无法扣减" };
	a.credits += d;
	a.updatedAt = new Date().toISOString();
	persist();
	return { ok: true, balance: a.credits };
}

/**
 * 模型显示名（第138轮，P1 拍平后=本商自设或无）：无人改回 undefined（用平台名）。
 * catalog 下发与门户展示共用这一把尺。
 */
export function agentModelLabel(agentId: string | undefined, modelId: string): string | undefined {
	for (const a of agentChain(agentId)) {
		const v = a.modelLabels?.[modelId]?.trim();
		if (v) return v;
	}
	return undefined;
}

/** 设置/清除本商的模型显示名（空/null=清除回退）。改动 bump pricingVersion → 名下用户 catalog 热更。 */
export function setAgentModelLabel(agentId: string, modelId: string, label: string | null): { ok: boolean; error?: string; label?: string } {
	const a = getAgent(agentId);
	if (!a) return { ok: false, error: "渠道商不存在" };
	const clean = String(label ?? "").replace(/\s+/g, " ").trim();
	if (clean.length > 40) return { ok: false, error: "名称最长 40 字" };
	const cur = a.modelLabels?.[modelId] ?? "";
	if (clean === cur) return { ok: true, label: clean || undefined }; // 幂等：没变不 bump
	if (!a.modelLabels) a.modelLabels = {};
	if (!clean) delete a.modelLabels[modelId];
	else a.modelLabels[modelId] = clean;
	if (Object.keys(a.modelLabels).length === 0) delete a.modelLabels;
	a.pricingVersion = (a.pricingVersion ?? 0) + 1;
	a.updatedAt = new Date().toISOString();
	persist();
	return { ok: true, label: clean || undefined };
}

// ── 渠道商级模式/模型管控（第121轮：源站禁止某商用 LibTV / 某模型）──

/**
 * 用户 features 过商级闸门后的**生效 features**（登录/心跳下发用）：
 * 商未设/字段缺省=开 → 按用户自身；商关=硬禁（AND 合成，用户开关失效）。
 * 主模式（资产/画布/实时剪辑）合成后全关（如 用户只开画布 × 商只开资产）时以**商的设定**为准——
 * updateAgent 已保证商侧至少开一个，避免客户端「都关回退仅资产」把商明令禁止的模式放出来。
 */
export function applyAgentFeatureGate(agentId: string | undefined, userFeatures?: AgentFeatures): AgentFeatures | undefined {
	const on = (v?: boolean) => v !== false; // 缺省=开
	let features = userFeatures;
	for (const agent of agentChain(agentId)) {
		const af = agent.features;
		if (!af) continue;
		const merged: AgentFeatures = {
			assetMode: on(af.assetMode) && on(features?.assetMode),
			canvasMode: on(af.canvasMode) && on(features?.canvasMode),
			editorMode: on(af.editorMode) && on(features?.editorMode),
			libtv: on(af.libtv) && on(features?.libtv),
			dreamina: on(af.dreamina) && on(features?.dreamina),
			modes: composeModes(features?.modes, af.modes),
		};
		if (!merged.assetMode && !merged.canvasMode && !merged.editorMode) {
			merged.assetMode = on(af.assetMode);
			merged.canvasMode = on(af.canvasMode);
			merged.editorMode = on(af.editorMode);
		}
		features = merged;
	}
	return features;
}

/** 某模型是否被该商禁用（直属用户无商级禁用） */
export function agentModelBlocked(agentId: string | undefined, modelId: string): boolean {
	if (!agentId) return false;
	return agentChain(agentId).some((a) => (a.blockedModels ?? []).includes(modelId));
}

/**
 * 设置/解除某商对某模型的禁用。变更 bump pricingVersion（并入名下用户 catalog version，
 * 触发客户端热更把该模型从下拉里移除/恢复）。
 */
export function setAgentModelAccess(agentId: string, modelId: string, blocked: boolean): { ok: boolean; error?: string } {
	const a = getAgent(agentId);
	if (!a) return { ok: false, error: "渠道商不存在" };
	const list = new Set(a.blockedModels ?? []);
	if (blocked === list.has(modelId)) return { ok: true }; // 幂等：状态未变不 bump 不落盘
	if (blocked) list.add(modelId);
	else list.delete(modelId);
	if (list.size) a.blockedModels = [...list];
	else delete a.blockedModels;
	a.pricingVersion = (a.pricingVersion ?? 0) + 1;
	a.updatedAt = new Date().toISOString();
	persist();
	return { ok: true };
}

/** 登录校验：账号存在 + 启用 + 密码匹配。成功刷新 lastSeen。 */
export function verifyAgentLogin(account: string, password: string): { ok: boolean; agent?: Agent; error?: string } {
	const a = getAgentByAccount(account);
	if (!a) return { ok: false, error: "账号或密码错误" };
	if (!a.enabled) return { ok: false, error: "该渠道商账号已停用，请联系管理员" };
	const cand = hashPw(password || "", a.salt);
	const ok = cand.length === a.passwordHash.length && timingSafeEqual(Buffer.from(cand, "hex"), Buffer.from(a.passwordHash, "hex"));
	if (!ok) return { ok: false, error: "账号或密码错误" };
	a.lastSeenAt = new Date().toISOString();
	persist();
	return { ok: true, agent: a };
}

// ── 门户会话（内存态，进程重启后需重新登录；发出的码/用户已持久化不受影响）──
const sessions = new Map<string, string>(); // token → agentId

export function createAgentSession(agentId: string): string {
	const token = "as-" + randomBytes(24).toString("hex");
	sessions.set(token, agentId);
	return token;
}

export function agentBySession(token: string): Agent | undefined {
	const id = sessions.get(token);
	if (!id) return undefined;
	const a = getAgent(id);
	if (!a || !a.enabled) return undefined;
	a.lastSeenAt = new Date().toISOString();
	return a;
}

export function dropAgentSession(token: string): void {
	sessions.delete(token);
}
