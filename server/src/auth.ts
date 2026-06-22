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

/**
 * 用户端鉴权：accessKey 必须对应一个启用用户，且本机机器码必须已激活并匹配。
 * 机器码绑定只在 /v1/login（公开）完成；此处只校验——未激活或换机一律拦截，
 * 从根上保证「没激活就用不了」（不止登录，所有受保护接口都拦）。
 */
export async function requireAccessKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
	const key = bearer(req);
	const user = key ? touchByAccessKey(key) : undefined;
	if (!user) {
		await reply.code(401).send({ error: { message: "无效或被禁用的 accessKey" } });
		return;
	}
	const mc = (req.headers["x-machine-code"] as string | undefined)?.trim();
	if (!user.machineCode) {
		await reply.code(403).send({ error: { message: "本机未激活，请重新登录以绑定机器码" } });
		return;
	}
	if (!mc || user.machineCode !== mc) {
		await reply.code(403).send({ error: { message: "机器码不匹配（该账号已绑定其他机器），请联系管理员解绑" } });
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
