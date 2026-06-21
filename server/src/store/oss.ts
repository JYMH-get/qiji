/**
 * OSS 对象存储（S3 兼容，雨云 rains3）。
 *
 * 配置来源 = settings.getOssConfig()（管理端 /admin 可改，未填回退 .env）。
 * 资产/项目云备份：把字节 PUT 到桶里，公有读 → 直接返回公网直链。
 * 未配置时 isOssConfigured()=false，调用方退回内存 + /raw。
 */
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getOssConfig, ossConfigVersion } from "./settings.ts";

let _client: S3Client | null = null;
let _clientVer = -1;

export function isOssConfigured(): boolean {
	const o = getOssConfig();
	return !!(o.endpoint && o.bucket && o.accessKeyId && o.secretAccessKey);
}

function client(): S3Client {
	const ver = ossConfigVersion();
	if (!_client || _clientVer !== ver) {
		const o = getOssConfig();
		_client = new S3Client({
			region: o.region || "auto",
			endpoint: o.endpoint,
			credentials: { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey },
			forcePathStyle: false, // 虚拟主机风格：<bucket>.<host>/<key>
		});
		_clientVer = ver;
	}
	return _client;
}

/** 资产对象的公网直链（公有读桶） */
export function ossPublicUrl(key: string): string {
	return `${getOssConfig().publicBase}/${key.replace(/^\/+/, "")}`;
}

/** 上传字节到 OSS，返回公网直链。未配置则抛错（调用方应先判 isOssConfigured） */
export async function ossPut(key: string, body: Buffer, contentType: string): Promise<string> {
	await client().send(
		new PutObjectCommand({
			Bucket: getOssConfig().bucket,
			Key: key.replace(/^\/+/, ""),
			Body: body,
			ContentType: contentType,
		}),
	);
	return ossPublicUrl(key);
}

/** 连接自检：上传一个临时对象再删除，验证 endpoint/桶/密钥/权限 */
export async function ossSelfTest(): Promise<{ ok: boolean; url?: string; error?: string }> {
	if (!isOssConfigured()) return { ok: false, error: "OSS 未配置（endpoint/bucket/key 缺失）" };
	const key = "assets/_admin_test.txt";
	try {
		const url = await ossPut(key, Buffer.from("qiji oss test"), "text/plain");
		const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
		const okRead = r.ok;
		await client().send(new DeleteObjectCommand({ Bucket: getOssConfig().bucket, Key: key })).catch(() => {});
		return okRead ? { ok: true, url } : { ok: false, error: `上传成功但公网读取失败 HTTP ${r.status}（桶是否公有读？）` };
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
}
