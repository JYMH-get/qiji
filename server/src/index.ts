/**
 * Qiji 管理端网关入口。
 *
 * 用户端 → 本服务 → 第三方 API。本服务持有真 key、做翻译/转发/规范化、分配资产 id。
 * 阶段2 骨架：5 端点 + 一个真文本翻译器(OpenAI 兼容) + 占位异步任务 + 内存存储。
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { config } from "./config.ts";
import { registerRoutes } from "./routes.ts";
import { registerAdminRoutes } from "./routes/admin.ts";

async function main(): Promise<void> {
	const app = Fastify({ logger: { level: "info" }, bodyLimit: 25 * 1024 * 1024 });

	// 用户端为 Tauri/Vite，跨域来源不固定，开发期放开（生产再收敛白名单）
	await app.register(cors, { origin: true });
	await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

	app.get("/health", async () => ({ ok: true, service: "qiji-server", version: "0.1.0" }));

	// 以插件方式注册，封装鉴权 hook，使其只作用于各自范围
	await app.register(registerRoutes);
	await app.register(registerAdminRoutes);

	try {
		await app.listen({ port: config.port, host: "0.0.0.0" });
		app.log.info(`Qiji 管理端已启动: http://localhost:${config.port}`);
		app.log.info(`控制台: http://localhost:${config.port}/admin （ADMIN_TOKEN=${config.adminToken === "admin-dev" ? "admin-dev(默认)" : "已自定义"}）`);
		app.log.info(`上游网关: ${config.gateway.apiKey ? "已配置 GATEWAY_API_KEY" : "未配置(仅 echo / 占位 可用)"}`);
	} catch (err) {
		app.log.error(err);
		process.exit(1);
	}
}

main();
