/**
 * 用户端路由。
 *  公开：/v1/login（校验 accessKey）、/v1/assets/:id/raw（<img> 直读，无法带头）。
 *  鉴权：/catalog /generate /tasks /batch /assets /heartbeat（Bearer accessKey）。
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireAccessKey } from "./auth.ts";
import { buildCatalog } from "./catalog.ts";
import { dispatchGenerate } from "./translators/index.ts";
import { getTaskState, createCompletedTask } from "./store/tasks.ts";
import { createAsset, getAsset, getAssetBytes, assetUrl } from "./store/assets.ts";
import { getUserByAccessKey, chargeCredits, bindOrCheckMachine } from "./store/users.ts";
import { getModelDef } from "./store/models.ts";
import { startLog } from "./store/logs.ts";
import type { GenerateRequest, BatchRequest, BatchState, TaskState, Capability } from "./contract.ts";

function baseUrlOf(req: FastifyRequest): string {
	return `${req.protocol}://${req.headers.host}`;
}

function fillAssetUrls(state: TaskState, baseUrl: string): TaskState {
	if (state.result?.assets?.length) {
		state.result.assets = state.result.assets.map((a) => ({ ...a, url: a.url || assetUrl(baseUrl, a.id) }));
	}
	return state;
}

function inferCapability(mime: string): Capability {
	if (mime.startsWith("image/")) return "image";
	if (mime.startsWith("video/")) return "video";
	if (mime.startsWith("audio/")) return "audio";
	return "text";
}

function bearer(req: FastifyRequest): string | undefined {
	const m = (req.headers.authorization ?? "").match(/^Bearer\s+(.+)$/i);
	return m?.[1]?.trim();
}

const batches = new Map<string, string[]>();
let _batchSeq = 0;

export async function registerRoutes(app: FastifyInstance): Promise<void> {
	// ── 公开：登录校验 accessKey ──
	app.post("/v1/login", async (req, reply) => {
		const body = (req.body ?? {}) as { accessKey?: string; machineCode?: string };
		const key = body.accessKey?.trim() || bearer(req);
		const user = key ? getUserByAccessKey(key) : undefined;
		if (!user || !user.enabled) {
			return reply.code(401).send({ error: { message: "accessKey 无效或已被禁用" } });
		}
		// 机器码：未绑定→绑定当前机器；已绑定→必须一致（body 优先，回退请求头）
		const machineCode = body.machineCode || (req.headers["x-machine-code"] as string | undefined);
		const mc = bindOrCheckMachine(user, machineCode);
		if (!mc.ok) {
			return reply.code(403).send({ error: { message: mc.error || "机器码校验失败" } });
		}
		return { ok: true, user: { id: user.id, name: user.name, credits: user.credits } };
	});

	// ── 公开：资产原始字节（<img>/<video> 直读，无法带 Authorization 头）──
	app.get("/v1/assets/:id/raw", async (req, reply) => {
		const { id } = req.params as { id: string };
		const rec = getAsset(id);
		if (!rec) return reply.code(404).send({ error: { message: "资产不存在" } });
		if (rec.url) return reply.redirect(rec.url); // OSS 公网直链
		const bytes = getAssetBytes(id);
		if (!bytes) return reply.code(404).send({ error: { message: "资产字节不可用（未配 OSS 且内存已失）" } });
		return reply.header("Content-Type", rec.contentType).send(bytes);
	});

	// ── 以下需要 accessKey ──
	await app.register(async (api) => {
		api.addHook("preHandler", requireAccessKey);

		// 心跳：能进到这里说明 requireAccessKey 已校验 accessKey 启用 + 机器码激活匹配。
		// 任一不符（被禁用/未激活/换机）→ requireAccessKey 直接 401/403 → 用户端登出。
		api.post("/v1/heartbeat", async (req) => {
			const u = req.user!;
			return { ok: true, user: { id: u.id, name: u.name, credits: u.credits } };
		});

		// 拉取目录（since 版本一致回 304）
		api.get("/v1/catalog", async (req, reply) => {
			const catalog = buildCatalog();
			const since = (req.query as { since?: string })?.since;
			if (since && since === catalog.version) return reply.code(304).send();
			return catalog;
		});

		// 提交生成（同步文本直接出结果；异步图/视频/音频回 taskId）+ 记录请求
		api.post("/v1/generate", async (req, reply) => {
			const body = req.body as GenerateRequest;
			if (!body?.model) return reply.code(400).send({ error: { message: "缺少 model" } });

			// 额度前置校验：不足则拒绝、不下单
			const user = req.user!;
			const cost = getModelDef(body.model)?.cost ?? 0;
			if (cost > 0 && user.credits < cost) {
				return reply.code(402).send({
					error: { message: `额度不足：本次需 ${cost}，剩余 ${user.credits}` },
				});
			}

			const log = startLog({ req: body, userId: req.user?.id, userName: req.user?.name, cost, headers: req.headers });
			const r = await dispatchGenerate(body, log.id);

			// 扣费：异步已受理 / 同步成功才扣；同步失败不扣
			if (cost > 0 && !(r.kind === "sync" && r.status === "failed")) {
				chargeCredits(user.id, cost);
			}

			if (r.kind === "async") return { taskId: r.taskId };
			if (r.status === "failed") return reply.code(200).send({ status: "failed", error: r.error });
			return { status: "success", result: r.result };
		});

		// 轮询任务
		api.get("/v1/tasks/:taskId", async (req, reply) => {
			const { taskId } = req.params as { taskId: string };
			const state = getTaskState(taskId);
			if (!state) return reply.code(404).send({ error: { message: "任务不存在" } });
			return fillAssetUrls(state, baseUrlOf(req));
		});

		// 批量提交（每个子任务也记录请求）
		api.post("/v1/batch", async (req, reply) => {
			const body = req.body as BatchRequest;
			if (!Array.isArray(body?.tasks)) return reply.code(400).send({ error: { message: "缺少 tasks" } });

			const user = req.user!;
			const taskIds: string[] = [];
			for (const t of body.tasks) {
				// 逐任务额度校验：不足则记一条 failed 任务、跳过下单
				const cost = getModelDef(t.model)?.cost ?? 0;
				if (cost > 0 && user.credits < cost) {
					taskIds.push(
						createCompletedTask("text", "failed", undefined, `额度不足：需 ${cost}，剩余 ${user.credits}`, t.clientTaskId).taskId,
					);
					continue;
				}
				const log = startLog({ req: t, userId: req.user?.id, userName: req.user?.name, cost, headers: req.headers });
				const r = await dispatchGenerate(t, log.id);
				if (cost > 0 && !(r.kind === "sync" && r.status === "failed")) chargeCredits(user.id, cost);
				if (r.kind === "async") taskIds.push(r.taskId);
				else taskIds.push(createCompletedTask("text", r.status, r.result, r.error, t.clientTaskId).taskId);
			}
			_batchSeq += 1;
			const batchId = `b${String(_batchSeq).padStart(6, "0")}`;
			batches.set(batchId, taskIds);
			return { batchId, taskIds };
		});

		api.get("/v1/batch/:batchId", async (req, reply) => {
			const { batchId } = req.params as { batchId: string };
			const taskIds = batches.get(batchId);
			if (!taskIds) return reply.code(404).send({ error: { message: "批次不存在" } });
			const baseUrl = baseUrlOf(req);
			const states = taskIds
				.map((id) => getTaskState(id))
				.filter((s): s is TaskState => !!s)
				.map((s) => fillAssetUrls(s, baseUrl));
			const summary = {
				total: states.length,
				success: states.filter((s) => s.status === "success").length,
				failed: states.filter((s) => s.status === "failed").length,
				running: states.filter((s) => s.status === "running").length,
				queued: states.filter((s) => s.status === "queued").length,
			};
			const out: BatchState = {
				batchId,
				tasks: states.map((s) => ({ taskId: s.taskId, clientTaskId: s.clientTaskId, status: s.status, progress: s.progress })),
				summary,
			};
			return out;
		});

		// 素材上传（multipart）→ 全局唯一 id + 公网 url
		api.post("/v1/assets", async (req, reply) => {
			const file = await req.file();
			if (!file) return reply.code(400).send({ error: { message: "缺少文件字段 file" } });
			const buf = await file.toBuffer();
			const cap = inferCapability(file.mimetype ?? "");
			const q = req.query as { prefix?: string; name?: string };
			const rec = await createAsset(buf, file.mimetype ?? "application/octet-stream", cap, { prefix: q.prefix, name: q.name ?? file.filename });
			return { id: rec.id, url: assetUrl(baseUrlOf(req), rec.id) };
		});

		// 凭 id 重解析 url
		api.get("/v1/assets/:id", async (req, reply) => {
			const { id } = req.params as { id: string };
			const rec = getAsset(id);
			if (!rec) return reply.code(404).send({ error: { message: "资产不存在" } });
			return { id: rec.id, url: assetUrl(baseUrlOf(req), rec.id) };
		});
	});
}
