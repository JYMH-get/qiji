/**
 * Qiji 管理端网关入口。
 *
 * 用户端 → 本服务 → 第三方 API。本服务持有真 key、做翻译/转发/规范化、分配资产 id。
 * 阶段2 骨架：5 端点 + 一个真文本翻译器(OpenAI 兼容) + 占位异步任务 + 内存存储。
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { Agent, setGlobalDispatcher } from "undici";
import { config } from "./config.ts";
import { registerRoutes } from "./routes.ts";
import { registerAdminRoutes } from "./routes/admin.ts";
import { registerAgentRoutes } from "./routes/agent.ts";
import { selfHealCredits, pruneCreditOps } from "./store/credits.ts";
import { backfillLogOwners } from "./store/logs.ts";
import { getUser } from "./store/users.ts";
import { reconcileOnStartup } from "./reconcile.ts";
import { startCleanupLoop } from "./store/cleanup.ts";
import { setAssetAccountResolver } from "./store/assets.ts";
import { isRelay, startRelayLoops } from "./relay.ts";
import { flushPendingSaves } from "./store/db.ts";
import { closeSqlite } from "./store/sqlite.ts";

// 第169轮（取消提交超时的配套，⚠ 勿删）：Node 内置全局 fetch 的 undici 缺省 headersTimeout/bodyTimeout=300s
// 是一道隐形闸——上游提交慢于 5 分钟会在各请求自己的 AbortSignal 之前被它掐断（HeadersTimeoutError）。
// 归零后超时完全由各请求自身的 AbortSignal 决定（提交类=submitTimeout.ts 安全闸；轮询/下载类短超时不变）。
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

async function main(): Promise<void> {
	const app = Fastify({ logger: { level: "info" }, bodyLimit: 25 * 1024 * 1024 });

	// 第224轮：新对象键布局 acct/kind/yyyy/mm/dd 需要「归属用户 id → 登录账号」——
	// 注入而非直接 import，防 assets.ts ↔ users.ts 循环引用（logs.ts↔users.ts 同款先例）
	setAssetAccountResolver((userId) => getUser(userId)?.account);

	// 用户端为 Tauri/Vite，跨域来源不固定，开发期放开（生产再收敛白名单）
	await app.register(cors, { origin: true });
	await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

	app.get("/health", async () => ({ ok: true, service: "qiji-server", version: "0.1.0" }));

	// 以插件方式注册，封装鉴权 hook，使其只作用于各自范围
	await app.register(registerRoutes);
	await app.register(registerAdminRoutes);
	await app.register(registerAgentRoutes);

	try {
		await app.listen({ port: config.port, host: "0.0.0.0" });
		if (isRelay()) {
			app.log.info(`Qiji 渠道节点（relay）已启动: http://localhost:${config.port}`);
			app.log.info(`源站: ${config.source.url || "未配置 SOURCE_URL（生成/素材将不可用）"}${config.source.nodeKey ? "" : " ｜ 未配置 SOURCE_NODE_KEY"}`);
		} else {
			app.log.info(`Qiji 管理端已启动: http://localhost:${config.port}`);
			app.log.info(`上游网关: ${config.gateway.apiKey ? "已配置 GATEWAY_API_KEY" : "未配置(仅 echo / 占位 可用)"}`);
		}
		app.log.info(`控制台: http://localhost:${config.port}/admin （ADMIN_TOKEN=${config.adminToken === "admin-dev" ? "admin-dev(默认)" : "已自定义"}）`);
		// 结算自愈（第183轮）：上次进程若死在「用户已扣、渠道商未扣」之间，按流水的 pre/post 补齐或作废。
		// 须在启动对账**之前**——先把上一次的钱理清，再去处理在途任务的退款。
		selfHealCredits({ warn: (m) => app.log.warn(m) });
		pruneCreditOps(); // 流水裁剪：done 且超 180 天的行（pending/healed/aborted 永久保留供人工核）
		if (isRelay()) {
			// P3 relay：不跑源站对账（本地无上游任务；孤儿在途单由台账清扫向源站补查——见 relay.ts）。
			// ⚠ 勿在 relay 启用 reconcileOnStartup：它会把仍在源站跑的任务当孤儿退款（任务完成=用户白拿）。
			startRelayLoops({ info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) });
		} else {
			// 第198轮一次性回填：存量请求记录的渠道商归属固化进 ownerId（新记录已在落笔时写入）。
			// 注入 users 查询防 logs.ts↔users.ts 循环引用；flag 防重跑，量大时首启阻塞数秒属一次性代价。
			const owned = backfillLogOwners((uid) => getUser(uid)?.agentId);
			if (owned) app.log.info(`[logs] 已按渠道商归属回填 ${owned} 条存量请求记录（一次性）`);
			// 启动对账：上次进程中断遗留的在途任务/日志（视频续轮询，其余失败退款；异步进行不阻塞启动）
			// 须在 registerRoutes 之后——退款钩子 setBillingReverseHook 在那里注册
			reconcileOnStartup({ info: (m) => app.log.info(m) }).catch((err) => app.log.error(err, "启动对账失败"));
			// P3 清理定时器（第223轮）：mode=off（默认）时每轮直接跳过，零开销；首轮延后 5 分钟避开启动对账/VACUUM
			startCleanupLoop({ info: (m) => app.log.info(m) });
		}
	} catch (err) {
		app.log.error(err);
		process.exit(1);
	}

	// 优雅关闭：部署重启（SIGTERM）/ Ctrl-C（SIGINT）时先把待落盘的防抖写刷盘，避免丢窗口内的日志/任务。
	let shuttingDown = false;
	const shutdown = async (sig: string): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		app.log.info(`收到 ${sig}，刷盘并关闭…`);
		try {
			await app.close();
			await flushPendingSaves();
			closeSqlite();
		} catch (err) {
			app.log.error(err, "关闭刷盘失败");
		}
		process.exit(0);
	};
	for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => void shutdown(sig));
}

main();
