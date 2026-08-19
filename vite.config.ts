import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath, URL } from "node:url"
import { appVersionPlugin } from "./appVersionPlugin"

export default defineConfig({
	// 客户端版本标识（第144轮）：virtual:app-version 虚拟模块注入版本号+构建时刻（详见 appVersionPlugin.ts 注释）
	plugins: [react(), tailwindcss(), appVersionPlugin()],
	resolve: {
		alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
	},
	// transformers.js/onnxruntime 不能被 esbuild 预打包：ort 靠动态 import 自己的 .mjs 运行时，
	// 预打包会把它揉碎 → 「webgpuInit is not a function / no available backend found」（转深度实测）
	optimizeDeps: {
		exclude: ["@huggingface/transformers", "onnxruntime-web"],
	},
	build: {
		// 产物文件名只用哈希，不带模块名——避免 canvasSpawn/inferRun 等内部模块结构从文件名泄漏。
		// 代码内容本就压缩混淆、无 source map；这里再把文件名也匿名化。
		rollupOptions: {
			output: {
				entryFileNames: "assets/[hash].js",
				chunkFileNames: "assets/[hash].js",
				assetFileNames: "assets/[hash][extname]",
			},
		},
	},
	server: {
		port: 5173,
		strictPort: true,
		watch: {
			ignored: ["**/*.zip", "**/node_modules/**", "**/.git/**", "**/src-tauri/**"],
		},
	},
})

