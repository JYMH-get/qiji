/**
 * 阿里云短信（P2 注册体系：手机号验证码通道，可插拔适配器）。
 * 未配置（settings.register.sms）时手机号注册通道对外显示「暂未开放」。
 * 纯 RPC 签名实现（POP v1.0，HMAC-SHA1），零 SDK 依赖。
 * ⚠ 前提：阿里云企业实名 + 签名/模板审批通过（见 docs/商业化改造方案.md §8-Q3）。
 */
import { createHmac, randomBytes } from "node:crypto";
import { getRegisterSettings } from "../store/settings.ts";

export function isSmsConfigured(): boolean {
	const s = getRegisterSettings().sms;
	return !!(s?.accessKeyId && s?.accessKeySecret && s?.signName && s?.templateCode);
}

/** POP 签名规范的百分号编码（RFC3986 + 阿里云特例） */
function popEncode(v: string): string {
	return encodeURIComponent(v).replace(/\+/g, "%20").replace(/\*/g, "%2A").replace(/%7E/g, "~");
}

/** 发送验证码短信（模板变量固定 {"code": "..."}，与阿里云验证码类模板惯例一致） */
export async function sendSmsCode(phone: string, code: string): Promise<void> {
	const s = getRegisterSettings().sms;
	if (!s?.accessKeyId || !s?.accessKeySecret || !s?.signName || !s?.templateCode) throw new Error("短信未配置");
	const params: Record<string, string> = {
		AccessKeyId: s.accessKeyId,
		Action: "SendSms",
		Format: "JSON",
		PhoneNumbers: phone,
		RegionId: "cn-hangzhou",
		SignName: s.signName,
		SignatureMethod: "HMAC-SHA1",
		SignatureNonce: randomBytes(16).toString("hex"),
		SignatureVersion: "1.0",
		TemplateCode: s.templateCode,
		TemplateParam: JSON.stringify({ code }),
		Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
		Version: "2017-05-25",
	};
	const canonical = Object.keys(params).sort().map((k) => `${popEncode(k)}=${popEncode(params[k])}`).join("&");
	const strToSign = `GET&%2F&${popEncode(canonical)}`;
	const signature = createHmac("sha1", s.accessKeySecret + "&").update(strToSign).digest("base64");
	const qs = `Signature=${popEncode(signature)}&${canonical}`;
	const resp = await fetch(`https://dysmsapi.aliyuncs.com/?${qs}`, { signal: AbortSignal.timeout(15000) });
	const data = (await resp.json().catch(() => ({}))) as { Code?: string; Message?: string };
	if (data.Code !== "OK") throw new Error(`短信发送失败：${data.Message || data.Code || `HTTP ${resp.status}`}`);
}
