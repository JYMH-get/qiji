/**
 * §9「请求参数绝不静默改写」（第188轮用户定稿）统一助手（第215轮收口）：
 * 显式参数**原样透传**——数字/数字串归一为 number（值不变），其余原样发出（上游明确报错可见）；
 * 仅当**缺省**（undefined/null/空串）才补调用方给的默认值。
 *
 * ⚠ 勿在任何翻译器重新引入 夹钳/就近取档/白名单回退（Math.min、nearestDuration、RATIOS.has 回退 之类）——
 *   档位由管理端模型参数把关（客户端下拉），非法值由上游明确报错（失败自动退款）。
 *   反例（真实亏钱事故）：第186/187轮 overseas 与第215轮 简梦（Seedance 渠道）——客户端请 20s/30s
 *   被翻译器静默夹成 15s，按秒计费却按请求参数扣 = 多扣钱、少交货。
 */

/** 数值参数透传：缺省→默认；数字/数字串→number；其余原样（string）发出 */
export function numberParam(raw: unknown, dflt: number): number | string {
	if (raw === undefined || raw === null || String(raw).trim() === "") return dflt;
	const n = Number(raw);
	return Number.isFinite(n) ? n : String(raw);
}

/** 字符串参数透传：缺省/空串→默认；其余 trim 后原样发出 */
export function stringParam(raw: unknown, dflt: string): string {
	const s = raw === undefined || raw === null ? "" : String(raw).trim();
	return s === "" ? dflt : s;
}
