/**
 * 客户端版本标识（第144轮）。
 *
 * 版本号 = package.json version、构建时间 = 打包那一刻——经 `virtual:app-version` 虚拟模块注入
 * （appVersionPlugin.ts，dev/build/vitest 三管线共用）。⚠ 曾试 vite `define` 与 `process.env.VITE_*`
 * 两条注入链，本仓 rolldown-vite dev/build 实测均不生效（产物落兜底值），勿改回。
 * 版本号未 bump 时也能凭构建时间区分新旧包（个人中心 / 设置弹窗显示，供排查「跑的是哪个构建」）。
 * vite dev 下构建时间 = 启动后首次加载时刻，并标「开发版」。
 */
import { version, buildTime } from "virtual:app-version";

export const APP_VERSION: string = version || "0.0.0";
export const BUILD_TIME_ISO: string = buildTime || "";

/** 是否开发运行（vite dev / vitest）；打包产物为 false */
const IS_DEV: boolean = !!import.meta.env.DEV;

/** 构建时间戳 → 本地时区人读格式「2026-07-20 22:14」；解析不出返回空串 */
export function formatBuildTime(iso: string): string {
	const d = new Date(iso);
	if (!iso || Number.isNaN(d.getTime())) return "";
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 展示用完整标识：如「v0.2.0 · 构建 2026-07-20 22:14」（开发运行追加「 · 开发版」） */
export function versionLabel(version = APP_VERSION, buildIso = BUILD_TIME_ISO, dev = IS_DEV): string {
	const t = formatBuildTime(buildIso);
	return `v${version}${t ? ` · 构建 ${t}` : ""}${dev ? " · 开发版" : ""}`;
}
