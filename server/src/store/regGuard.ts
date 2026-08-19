/**
 * 注册防线（P2 商业化改造）：验证码 + 频控 落 SQLite（qiji.db reg_guard 表，重启不丢）；
 * 图形验证码为内存态（重启失效重取即可，无持久价值）。
 *
 * 防线清单（与 docs/商业化改造方案.md §4.4 对齐）：
 *  - 图形验证码前置在「发验证码」上（自绘 SVG，零第三方依赖）；
 *  - 发码频控：同目标 60s 冷却；同 IP 每小时/每天上限（settings.register 可配）；
 *  - 验证码：6 位数字、10 分钟 TTL、错 5 次作废；
 *  - 注册频控：同 IP 每日上限（可配）；
 *  - 一次性邮箱域黑名单（内置 + 管理端追加）。
 */
import { randomBytes, randomInt } from "node:crypto";
import { db } from "./sqlite.ts";
import { getRegisterSettings } from "./settings.ts";

db.exec(`
CREATE TABLE IF NOT EXISTS reg_guard (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	kind TEXT NOT NULL,            -- 'code'=验证码 | 'register'=注册事件（频控计数用）
	purpose TEXT,                  -- kind=code：'register' | 'reset'
	target TEXT,                   -- 邮箱/手机号（小写归一）
	ip TEXT,
	code TEXT,
	created_at INTEGER NOT NULL,   -- epoch ms
	expires_at INTEGER,
	attempts INTEGER NOT NULL DEFAULT 0,
	used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_regguard_target ON reg_guard(kind, target, created_at);
CREATE INDEX IF NOT EXISTS idx_regguard_ip ON reg_guard(kind, ip, created_at);
`);
// 7 天前的行直接清（频控窗口最长 24h、验证码 TTL 10min，7 天足够留痕排障）
db.prepare("DELETE FROM reg_guard WHERE created_at < ?").run(Date.now() - 7 * 86400000);

const CODE_TTL_MS = 10 * 60 * 1000;
const SEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

/** 内置常见一次性邮箱域（管理端可在 settings.register.emailDomainBlacklist 追加） */
const DISPOSABLE_DOMAINS = new Set([
	"mailinator.com", "guerrillamail.com", "10minutemail.com", "temp-mail.org", "tempmail.com",
	"throwawaymail.com", "yopmail.com", "getnada.com", "maildrop.cc", "dispostable.com",
	"trashmail.com", "sharklasers.com", "linshiyouxiang.net", "mail.tm", "moakt.com",
]);

export function isBlacklistedEmailDomain(email: string): boolean {
	const domain = (email.split("@")[1] || "").toLowerCase();
	if (!domain) return false;
	if (DISPOSABLE_DOMAINS.has(domain)) return true;
	return getRegisterSettings().emailDomainBlacklist.includes(domain);
}

const norm = (s: string) => (s || "").trim().toLowerCase();

/**
 * 签发验证码（发码前的全部频控在此收口）。
 * 返回 ok + 6 位码（由调用方发送——存储层不做 IO）；被频控/冷却拦下返回明确 error。
 */
export function issueCode(purpose: "register" | "reset", target: string, ip: string): { ok: true; code: string } | { ok: false; error: string } {
	const t = norm(target);
	const now = Date.now();
	const cfg = getRegisterSettings();
	const last = db.prepare("SELECT created_at FROM reg_guard WHERE kind='code' AND target=? ORDER BY created_at DESC LIMIT 1").get(t) as { created_at: number } | undefined;
	if (last && now - last.created_at < SEND_COOLDOWN_MS) {
		return { ok: false, error: `发送过于频繁，请 ${Math.ceil((SEND_COOLDOWN_MS - (now - last.created_at)) / 1000)} 秒后再试` };
	}
	const hourCnt = (db.prepare("SELECT COUNT(*) AS n FROM reg_guard WHERE kind='code' AND ip=? AND created_at>?").get(ip, now - 3600_000) as { n: number }).n;
	if (hourCnt >= cfg.ipSendPerHour) return { ok: false, error: "发送过于频繁，请稍后再试" };
	const dayCnt = (db.prepare("SELECT COUNT(*) AS n FROM reg_guard WHERE kind='code' AND ip=? AND created_at>?").get(ip, now - 86400_000) as { n: number }).n;
	if (dayCnt >= cfg.ipSendPerDay) return { ok: false, error: "今日发送次数已达上限，请明天再试" };
	// 旧的未用码作废（同目标同用途只认最新一条）
	db.prepare("UPDATE reg_guard SET used=1 WHERE kind='code' AND purpose=? AND target=? AND used=0").run(purpose, t);
	const code = String(randomInt(0, 1000000)).padStart(6, "0");
	db.prepare("INSERT INTO reg_guard (kind, purpose, target, ip, code, created_at, expires_at) VALUES ('code', ?, ?, ?, ?, ?, ?)")
		.run(purpose, t, ip, code, now, now + CODE_TTL_MS);
	return { ok: true, code };
}

/** 核销验证码：最新未用未过期一条；错 5 次作废；命中即标 used（一次性） */
export function verifyCode(purpose: "register" | "reset", target: string, code: string): { ok: boolean; error?: string } {
	const t = norm(target);
	const c = (code || "").trim();
	if (!/^\d{6}$/.test(c)) return { ok: false, error: "验证码格式不正确" };
	const row = db.prepare("SELECT id, code, expires_at, attempts, used FROM reg_guard WHERE kind='code' AND purpose=? AND target=? ORDER BY created_at DESC LIMIT 1")
		.get(purpose, t) as { id: number; code: string; expires_at: number; attempts: number; used: number } | undefined;
	if (!row || row.used) return { ok: false, error: "验证码不存在或已失效，请重新获取" };
	if (Date.now() > row.expires_at) return { ok: false, error: "验证码已过期，请重新获取" };
	if (row.attempts >= MAX_ATTEMPTS) return { ok: false, error: "验证码错误次数过多，请重新获取" };
	if (row.code !== c) {
		db.prepare("UPDATE reg_guard SET attempts = attempts + 1 WHERE id=?").run(row.id);
		return { ok: false, error: "验证码错误" };
	}
	db.prepare("UPDATE reg_guard SET used=1 WHERE id=?").run(row.id);
	return { ok: true };
}

/** 注册事件登记 + 同 IP 每日上限校验 */
export function checkAndNoteRegister(ip: string): { ok: boolean; error?: string } {
	const cfg = getRegisterSettings();
	const cnt = (db.prepare("SELECT COUNT(*) AS n FROM reg_guard WHERE kind='register' AND ip=? AND created_at>?").get(ip, Date.now() - 86400_000) as { n: number }).n;
	if (cnt >= cfg.ipRegPerDay) return { ok: false, error: "今日注册次数已达上限，请明天再试" };
	db.prepare("INSERT INTO reg_guard (kind, ip, created_at) VALUES ('register', ?, ?)").run(ip, Date.now());
	return { ok: true };
}

// ── 图形验证码（内存态；自绘 SVG 零依赖）──

const captchas = new Map<string, { answer: string; expiresAt: number }>();
const CAPTCHA_TTL_MS = 5 * 60 * 1000;
const CAPTCHA_MAX = 5000;

function pruneCaptchas(): void {
	const now = Date.now();
	for (const [k, v] of captchas) if (now > v.expiresAt) captchas.delete(k);
	// 容量兜底：极端情况下按插入序砍半（Map 迭代序=插入序）
	if (captchas.size > CAPTCHA_MAX) {
		let i = 0;
		for (const k of captchas.keys()) { captchas.delete(k); if (++i > CAPTCHA_MAX / 2) break; }
	}
}

/** 生成图形验证码：4 位数字扭曲 SVG + 噪线。返回 { id, svg } */
export function genCaptcha(): { id: string; svg: string } {
	pruneCaptchas();
	const answer = String(randomInt(0, 10000)).padStart(4, "0");
	const id = "cap-" + randomBytes(12).toString("hex");
	const W = 120, H = 44;
	const rnd = (a: number, b: number) => a + Math.random() * (b - a);
	const colors = ["#3b5bdb", "#c92a2a", "#087f5b", "#5f3dc4", "#e8590c"];
	let body = "";
	for (let i = 0; i < 4; i++) {
		const x = 14 + i * 26 + rnd(-3, 3);
		const y = rnd(26, 34);
		const rot = rnd(-28, 28).toFixed(1);
		const color = colors[Math.floor(rnd(0, colors.length))];
		body += `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${rnd(22, 28).toFixed(0)}" font-family="Georgia, serif" font-weight="bold" fill="${color}" transform="rotate(${rot} ${x.toFixed(1)} ${y.toFixed(1)})">${answer[i]}</text>`;
	}
	for (let i = 0; i < 4; i++) {
		body += `<path d="M${rnd(0, 20).toFixed(0)} ${rnd(0, H).toFixed(0)} Q ${rnd(30, 90).toFixed(0)} ${rnd(0, H).toFixed(0)}, ${rnd(100, W).toFixed(0)} ${rnd(0, H).toFixed(0)}" stroke="${colors[Math.floor(rnd(0, colors.length))]}" stroke-width="1" fill="none" opacity="0.5"/>`;
	}
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#f4f4f6" rx="6"/>${body}</svg>`;
	captchas.set(id, { answer, expiresAt: Date.now() + CAPTCHA_TTL_MS });
	return { id, svg };
}

/** 校验图形验证码（一次性：对错都销，防爆破） */
export function verifyCaptcha(id: string, answer: string): boolean {
	const rec = captchas.get(id);
	if (!rec) return false;
	captchas.delete(id);
	return Date.now() <= rec.expiresAt && (answer || "").trim() === rec.answer;
}
