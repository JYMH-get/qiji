import { readFileSync } from "node:fs"
import { fileURLToPath, URL } from "node:url"

/**
 * 客户端版本虚拟模块插件（第144轮）：`virtual:app-version` 导出 package.json 版本号 + 构建时刻。
 * dev / build / vitest 三管线共用（vite.config.ts 与 vitest.config.ts 都挂载）。
 * ⚠ 走虚拟模块而非 `define` / `process.env.VITE_*`：本仓 rolldown-vite 这两条注入链 dev/build 实测均不生效，勿改回。
 * buildTime 在模块被加载那一刻取值：build=打包时刻；dev=启动后首次加载时刻（界面另标「开发版」）。
 */
export function appVersionPlugin() {
	const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8")) as { version?: string }
	const VID = "virtual:app-version"
	const RID = "\0" + VID
	return {
		name: "qiji-app-version",
		resolveId(id: string) {
			return id === VID ? RID : undefined
		},
		load(id: string) {
			if (id !== RID) return undefined
			return `export const version = ${JSON.stringify(pkg.version ?? "0.0.0")};\nexport const buildTime = ${JSON.stringify(new Date().toISOString())};\n`
		},
	}
}
