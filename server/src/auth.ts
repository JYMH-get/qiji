/**
 * 鉴权。
 *  - 用户端 /v1/*：Authorization: Bearer <accessKey>，校验对应启用用户。
 *  - 管理端 /admin-api/*：Authorization: Bearer <ADMIN_TOKEN>。
 */
import type { FastifyRequest, FastifyReply } from "fastify";
import { config } from "./config.ts";
import { touchByAccessKey, type User } from "./store/users.ts";

declare module "fastify" {
	interface FastifyRequest {
		user?: User;
	}
}

function bearer(req: FastifyRequest): string | undefined {
	const m = (req.headers.authorization ?? "").match(/^Bearer\s+(.+)$/i);
	return m?.[1]?.trim();
}

/** 用户端鉴权：accessKey 必须对应一个启用用户 */
export async function requireAccessKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
	const key = bearer(req);
	const user = key ? touchByAccessKey(key) : undefined;
	if (!user) {
		await reply.code(401).send({ error: { message: "无效或被禁用的 accessKey" } });
		return;
	}
	req.user = user;
}

/** 管理端鉴权 */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
	if (bearer(req) !== config.adminToken) {
		await reply.code(401).send({ error: { message: "管理端令牌无效" } });
	}
}
