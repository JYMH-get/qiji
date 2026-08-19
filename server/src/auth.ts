/**
 * 鉴权。
 *  - 用户端 /v1/*：Authorization: Bearer <accessKey>，校验对应启用用户。
 *  - 管理端 /admin-api/*：Authorization: Bearer <ADMIN_TOKEN>。
 */
import type { FastifyRequest, FastifyReply } from "fastify";
import { config } from "./config.ts";
import { touchByAccessKey, checkDeviceAccess, type User } from "./store/users.ts";
import { getAgentByNodeKey, touchAgentNode, type Agent } from "./store/agents.ts";

declare module "fastify" {
	interface FastifyRequest {
		user?: User;
		/** 渠道节点身份（P3）：Bearer 为 ank- 节点密钥时设置（与 user 互斥）。
		 *  计费=该商积分池；只允许 NODE_ALLOWED_ROUTES 里的端点。 */
		agentNode?: Agent;
	}
}

/**
 * 渠道节点可用端点白名单（P3，按 Fastify 路由模板匹配）。
 * 节点是「转发器」身份：目录/生成/任务/素材/引用上报/收藏透传/自身状态。
 * 用户个体语义的端点（me/stats/team/redeem/shared/logs/储值……）一律 403——
 * 节点的用户体系在节点本地，不在源站。
 */
const NODE_ALLOWED_ROUTES = new Set([
	"/v1/catalog",
	"/v1/generate",
	"/v1/batch",
	"/v1/batch/:batchId",
	"/v1/tasks/:taskId",
	"/v1/tasks/:id/result-asset",
	"/v1/assets",
	"/v1/assets/direct",
	"/v1/assets/direct/:id/complete",
	"/v1/assets/ref",
	"/v1/assets/rehost",
	"/v1/assets/:id",
	"/v1/assets/:id/alive",
	"/v1/assets/:id/reput",
	"/v1/assets/:id/thumb",
	"/v1/assets/:id/thumb/complete",
	"/v1/favorites",
	"/v1/favorites/:assetId",
	"/v1/favorites/flags",
	"/v1/node/me",
]);

function bearer(req: FastifyRequest): string | undefined {
	const m = (req.headers.authorization ?? "").match(/^Bearer\s+(.+)$/i);
	return m?.[1]?.trim();
}

/** 设备标识解析（第218轮机器码全面退役）：新客户端发 x-device-id（随机 UUID 持久化，无硬件语义）；
 *  旧客户端仍发 x-machine-code——同样当不透明设备 id 收下，双向兼容。 */
export function deviceIdOf(req: FastifyRequest): string | undefined {
	return (req.headers["x-device-id"] as string | undefined) ?? (req.headers["x-machine-code"] as string | undefined);
}

/**
 * 用户端鉴权（第218轮：身份=API 密钥（accessKey），机器码概念整体退役）：
 *  - API 密钥必须对应一个启用用户；
 *  - x-device-id / x-machine-code 头当**设备标识**用（同时在线限制）：
 *    设备在活跃表/表有空位 → 放行；表满且是陌生设备 → 403（登录抢占制——重新登录
 *    即成为活跃设备并挤掉最久未活跃者，被挤设备走客户端「401/403 立即登出」）。
 */
export async function requireAccessKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
	const key = bearer(req);
	// P3 渠道节点分支：ank- 密钥 → 节点身份（无设备语义），仅放行白名单端点
	if (key?.startsWith("ank-")) {
		const agent = getAgentByNodeKey(key);
		if (!agent || !agent.enabled) {
			await reply.code(401).send({ error: { message: "节点密钥无效或渠道商已停用" } });
			return;
		}
		const routeUrl = req.routeOptions?.url ?? "";
		if (!NODE_ALLOWED_ROUTES.has(routeUrl)) {
			await reply.code(403).send({ error: { message: "渠道节点凭证不可用于此端点" } });
			return;
		}
		touchAgentNode(agent);
		req.agentNode = agent;
		return;
	}
	const user = key ? touchByAccessKey(key) : undefined;
	if (!user) {
		await reply.code(401).send({ error: { message: "无效或被禁用的 accessKey" } });
		return;
	}
	const dev = checkDeviceAccess(user, deviceIdOf(req));
	if (!dev.ok) {
		await reply.code(403).send({ error: { message: dev.error || "该账号已在其它设备登录" } });
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
