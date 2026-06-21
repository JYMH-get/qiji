/**
 * 用户存储（文件持久化）。
 *
 * accessKey 是用户端的唯一凭证（登录 + 每请求 Bearer + 心跳都用它）。
 * 管理端可增删改查用户、启停、改额度、重置 accessKey。
 */
import { randomBytes } from "node:crypto";
import { loadJson, saveJson, genId } from "./db.ts";
import { config } from "../config.ts";

export interface User {
	id: string;
	name: string;
	accessKey: string;
	enabled: boolean;
	note: string;
	credits: number;
	createdAt: string;
	updatedAt: string;
	lastSeenAt?: string;
}

const FILE = "users.json";
let users: User[] = loadJson<User[]>(FILE, []);

function persist(): void {
	saveJson(FILE, users);
}

export function genAccessKey(): string {
	return "qk-" + randomBytes(18).toString("hex");
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
		createdAt: now,
		updatedAt: now,
	});
	persist();
}

export function listUsers(): User[] {
	return [...users].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getUser(id: string): User | undefined {
	return users.find((u) => u.id === id);
}

export function getUserByAccessKey(key: string): User | undefined {
	return users.find((u) => u.accessKey === key);
}

export function createUser(input: Partial<Pick<User, "name" | "note" | "credits" | "enabled" | "accessKey">>): User {
	const now = new Date().toISOString();
	const user: User = {
		id: genId("u"),
		name: input.name?.trim() || "未命名用户",
		accessKey: input.accessKey?.trim() || genAccessKey(),
		enabled: input.enabled ?? true,
		note: input.note ?? "",
		credits: input.credits ?? 0,
		createdAt: now,
		updatedAt: now,
	};
	users.push(user);
	persist();
	return user;
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
		return true;
	}
	return false;
}

/**
 * 按请求扣减额度：余额足够则扣并持久化，返回 { ok, remaining }；
 * 不足返回 ok:false 且不扣；amount<=0 视为免费直接通过。
 */
export function chargeCredits(id: string, amount: number): { ok: boolean; remaining: number } {
	const u = getUser(id);
	if (!u) return { ok: false, remaining: 0 };
	if (amount <= 0) return { ok: true, remaining: u.credits };
	if (u.credits < amount) return { ok: false, remaining: u.credits };
	u.credits -= amount;
	u.updatedAt = new Date().toISOString();
	persist();
	return { ok: true, remaining: u.credits };
}

/** 校验 accessKey 是否对应一个启用的用户；顺便刷新 lastSeen */
export function touchByAccessKey(key: string): User | undefined {
	const u = getUserByAccessKey(key);
	if (!u || !u.enabled) return undefined;
	u.lastSeenAt = new Date().toISOString();
	// 不频繁落盘 lastSeen，避免心跳每次写文件——内存更新即可，随其它写操作持久化
	return u;
}
