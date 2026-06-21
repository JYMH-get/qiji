/**
 * OSS 对象存储（S3 兼容，雨云 rains3）。
 *
 * 资产/项目云备份：把字节 PUT 到桶里，公有读 → 直接返回公网直链。
 * 未配置（无 endpoint/bucket/key）时 isOssConfigured()=false，调用方退回内存 + /raw。
 */
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { config } from "../config.ts";

let _client: S3Client | null = null;

export function isOssConfigured(): boolean {
	const o = config.oss;
	return !!(o.endpoint && o.bucket && o.accessKeyId && o.secretAccessKey);
}

function client(): S3Client {
	if (!_client) {
		_client = new S3Client({
			region: config.oss.region || "auto",
			endpoint: config.oss.endpoint,
			credentials: { accessKeyId: config.oss.accessKeyId, secretAccessKey: config.oss.secretAccessKey },
			forcePathStyle: false, // 虚拟主机风格：<bucket>.<host>/<key>
		});
	}
	return _client;
}

/** 资产对象的公网直链（公有读桶） */
export function ossPublicUrl(key: string): string {
	return `${config.oss.publicBase}/${key.replace(/^\/+/, "")}`;
}

/** 上传字节到 OSS，返回公网直链。未配置则抛错（调用方应先判 isOssConfigured） */
export async function ossPut(key: string, body: Buffer, contentType: string): Promise<string> {
	await client().send(
		new PutObjectCommand({
			Bucket: config.oss.bucket,
			Key: key.replace(/^\/+/, ""),
			Body: body,
			ContentType: contentType,
		}),
	);
	return ossPublicUrl(key);
}
