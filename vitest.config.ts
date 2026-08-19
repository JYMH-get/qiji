import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { appVersionPlugin } from "./appVersionPlugin";

export default defineConfig({
	// appVersionPlugin：src/lib/appVersion.ts 引用 virtual:app-version，测试管线同样要能解析（第144轮）
	plugins: [react(), tailwindcss(), appVersionPlugin()],
	resolve: {
		alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
	},
	test: {
		globals: true,
		environment: "node",
		include: ["src/**/*.{test,spec}.{ts,tsx}"],
	},
});