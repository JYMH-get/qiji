/// <reference types="vite/client" />

// 客户端版本虚拟模块（appVersionPlugin.ts 注入；dev/build/vitest 三管线可解析）
declare module "virtual:app-version" {
	export const version: string;
	export const buildTime: string;
}
