/**
 * 邮件发送（P2 注册体系：邮箱验证码通道）。
 * SMTP 配置在管理端「注册与安全」页维护（settings.register.smtp），密钥只存服务端。
 * 发信量小（验证码/通知），每次现建 transporter 即可，不做连接池。
 */
import nodemailer from "nodemailer";
import { getRegisterSettings } from "../store/settings.ts";

export function isSmtpConfigured(): boolean {
	const s = getRegisterSettings().smtp;
	return !!(s?.host && s?.user && s?.pass);
}

/** 发一封纯文本邮件；SMTP 未配/发送失败抛错（调用方转成明确的用户可见错误） */
export async function sendMail(to: string, subject: string, text: string): Promise<void> {
	const s = getRegisterSettings().smtp;
	if (!s?.host || !s?.user || !s?.pass) throw new Error("SMTP 未配置");
	const port = Number(s.port) || 465;
	const transporter = nodemailer.createTransport({
		host: s.host,
		port,
		secure: s.secure !== false && port !== 587, // 465=隐式 TLS；587 走 STARTTLS
		auth: { user: s.user, pass: s.pass },
		connectionTimeout: 15000,
		greetingTimeout: 15000,
		socketTimeout: 30000,
	});
	try {
		await transporter.sendMail({ from: s.from || s.user, to, subject, text });
	} finally {
		transporter.close();
	}
}

/** 验证码邮件（注册/找回共用模板） */
export async function sendCodeMail(to: string, code: string, action: string): Promise<void> {
	await sendMail(
		to,
		`【Qiji】${action}验证码`,
		`您的${action}验证码为：${code}\n\n10 分钟内有效，请勿泄露给他人。如非本人操作请忽略本邮件。`,
	);
}
