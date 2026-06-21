/**
 * 管理端控制台 API + 静态页面。
 *  GET /admin           → 控制台页面（公开，页面内再用 admin token 调 API）
 *  /admin-api/*         → 需要 ADMIN_TOKEN（Bearer）
 *    users / models / logs 的增删改查
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../auth.ts";
import {
	listUsers, getUser, createUser, updateUser, deleteUser, genAccessKey,
} from "../store/users.ts";
import {
	listModels, createModel, updateModel, deleteModel,
	type ModelDef,
} from "../store/models.ts";
import {
	listTemplates, createTemplate, updateTemplate, deleteTemplate,
	type TemplateDef,
} from "../store/templates.ts";
import { listLogs, getLog, logFacets } from "../store/logs.ts";
import { getOssConfig, setOssConfig } from "../store/settings.ts";
import { isOssConfigured, ossSelfTest } from "../store/oss.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ADMIN_HTML = join(here, "..", "admin", "index.html");

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
	// 控制台页面（公开加载，页面内提示输入 admin token）
	app.get("/admin", async (_req, reply) => {
		const html = readFileSync(ADMIN_HTML, "utf8");
		return reply.header("Content-Type", "text/html; charset=utf-8").send(html);
	});

	await app.register(async (api) => {
		api.addHook("preHandler", requireAdmin);

		// ── 用户 ──
		api.get("/admin-api/users", async () => ({ items: listUsers() }));
		api.post("/admin-api/users", async (req) => createUser((req.body ?? {}) as any));
		api.put("/admin-api/users/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			const u = updateUser(id, (req.body ?? {}) as any);
			if (!u) return reply.code(404).send({ error: { message: "用户不存在" } });
			return u;
		});
		api.delete("/admin-api/users/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			if (!deleteUser(id)) return reply.code(404).send({ error: { message: "用户不存在" } });
			return { ok: true };
		});
		api.post("/admin-api/users/:id/regenerate-key", async (req, reply) => {
			const { id } = req.params as { id: string };
			if (!getUser(id)) return reply.code(404).send({ error: { message: "用户不存在" } });
			return updateUser(id, { accessKey: genAccessKey() })!;
		});

		// ── 模型（含翻译格式：protocol / upstreamModel / baseUrl / apiKey）──
		api.get("/admin-api/models", async () => ({ items: listModels() }));
		api.post("/admin-api/models", async (req, reply) => {
			const b = (req.body ?? {}) as Partial<ModelDef>;
			if (!b.id || !b.label || !b.capability || !b.protocol) {
				return reply.code(400).send({ error: { message: "缺少 id/label/capability/protocol" } });
			}
			return createModel(b as any);
		});
		api.put("/admin-api/models/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			const m = updateModel(id, (req.body ?? {}) as any);
			if (!m) return reply.code(404).send({ error: { message: "模型不存在" } });
			return m;
		});
		api.delete("/admin-api/models/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			if (!deleteModel(id)) return reply.code(404).send({ error: { message: "模型不存在" } });
			return { ok: true };
		});

		// ── 提示词模板（正文 + 节点类型白名单 + 链式复合）──
		api.get("/admin-api/templates", async () => ({ items: listTemplates() }));
		api.post("/admin-api/templates", async (req, reply) => {
			const b = (req.body ?? {}) as Partial<TemplateDef>;
			if (!b.id || !b.name || !b.capability) {
				return reply.code(400).send({ error: { message: "缺少 id/name/capability" } });
			}
			return createTemplate(b as any);
		});
		api.put("/admin-api/templates/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			const t = updateTemplate(id, (req.body ?? {}) as any);
			if (!t) return reply.code(404).send({ error: { message: "模板不存在" } });
			return t;
		});
		api.delete("/admin-api/templates/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			if (!deleteTemplate(id)) return reply.code(404).send({ error: { message: "模板不存在" } });
			return { ok: true };
		});

		// ── 请求记录 ──
		// 筛选下拉选项（用户/步骤/模型去重）。须在 /:id 之前注册以免被参数路由吞掉。
		api.get("/admin-api/logs/facets", async () => logFacets());
		api.get("/admin-api/logs", async (req) => {
			const q = req.query as Record<string, string | undefined>;
			const num = (v?: string) => (v != null && v !== "" ? Number(v) : undefined);
			return listLogs({
				limit: num(q.limit) ?? 50,
				offset: num(q.offset) ?? 0,
				from: num(q.from),
				to: num(q.to),
				userName: q.user || undefined,
				purpose: q.purpose || undefined,
				model: q.model || undefined,
			});
		});
		api.get("/admin-api/logs/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			const log = getLog(id);
			if (!log) return reply.code(404).send({ error: { message: "记录不存在" } });
			return log;
		});

		// ── OSS 对象存储设置（密钥只存服务端；secret 返回时脱敏）──
		api.get("/admin-api/settings/oss", async () => {
			const o = getOssConfig();
			const tail = o.secretAccessKey ? o.secretAccessKey.slice(-4) : "";
			return {
				endpoint: o.endpoint, bucket: o.bucket, accessKeyId: o.accessKeyId,
				region: o.region, publicBase: o.publicBase,
				secretMasked: o.secretAccessKey ? "****" + tail : "",
				configured: isOssConfigured(),
			};
		});
		api.put("/admin-api/settings/oss", async (req) => {
			const b = (req.body ?? {}) as Record<string, string>;
			const patch: Record<string, string> = {};
			for (const k of ["endpoint", "bucket", "accessKeyId", "region", "publicBase"]) {
				if (b[k] !== undefined) patch[k] = b[k];
			}
			// secret 仅在传入“非掩码”新值时更新，避免被 **** 覆盖清空
			if (b.secretAccessKey && !b.secretAccessKey.startsWith("****")) patch.secretAccessKey = b.secretAccessKey;
			setOssConfig(patch);
			return { ok: true, configured: isOssConfigured() };
		});
		api.post("/admin-api/settings/oss/test", async () => ossSelfTest());
	});
}
