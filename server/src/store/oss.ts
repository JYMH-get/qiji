/**
 * OSS 对象存储（S3 兼容，雨云 rains3）。
 *
 * 配置来源 = settings.getOssConfig()（管理端 /admin 可改，未填回退 .env）。
 * 资产/项目云备份：把字节 PUT 到桶里，公有读 → 直接返回公网直链。
 * 未配置时 isOssConfigured()=false，调用方退回内存 + /raw。
 */
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getOssConfig, ossConfigVersion } from "./settings.ts";
import { activeProfile, publicUrlOf, type StorageProfile } from "./storage.ts";

/**
 * 目标存储位置：省略即用**当前 active 档**（未配 storageProfiles 时 = 改造前的唯一桶）。
 * 老对象要写回/删除时，调用方须传该行 `storage` 档解析出的 profile（见 store/storage.ts locate）。
 */
export type OssTarget = StorageProfile | undefined;

const target = (t: OssTarget): StorageProfile => t ?? activeProfile();

// S3 客户端按「endpoint + key + region」缓存（多档可能是不同桶甚至不同端点）；
// 主配置改动时 ossConfigVersion 变化 → 整体作废重建。
const clients = new Map<string, S3Client>();
let _clientVer = -1;

export function isOssConfigured(): boolean {
	const o = getOssConfig();
	return !!(o.endpoint && o.bucket && o.accessKeyId && o.secretAccessKey);
}

function client(t?: OssTarget): S3Client {
	const ver = ossConfigVersion();
	if (_clientVer !== ver) {
		clients.clear();
		_clientVer = ver;
	}
	const p = target(t);
	const ck = `${p.endpoint}|${p.accessKeyId}|${p.region}`;
	let c = clients.get(ck);
	if (!c) {
		c = new S3Client({
			region: p.region || "auto",
			endpoint: p.endpoint,
			credentials: { accessKeyId: p.accessKeyId, secretAccessKey: p.secretAccessKey },
			forcePathStyle: false, // 虚拟主机风格：<bucket>.<host>/<key>
			// 新版 SDK 默认给 PutObject 注入 CRC32 校验参数——预签名时会把「空体校验值」钉进 URL
			// （客户端直传真实字节即失配；rains3 宽松忽略但严格 S3 会拒）。按需才算，预签名 URL 保持干净。
			requestChecksumCalculation: "WHEN_REQUIRED",
		});
		clients.set(ck, c);
	}
	return c;
}

/** 资产对象的公网直链（公有读桶）。对象键仅 ASCII（资产 id），无需 URL 编码。 */
export function ossPublicUrl(key: string, t?: OssTarget): string {
	return publicUrlOf(target(t), key);
}

/** 上传字节到 OSS，返回公网直链。未配置则抛错（调用方应先判 isOssConfigured） */
export async function ossPut(key: string, body: Buffer, contentType: string, t?: OssTarget): Promise<string> {
	const p = target(t);
	await client(p).send(
		new PutObjectCommand({
			Bucket: p.bucket,
			Key: key.replace(/^\/+/, ""),
			Body: body,
			ContentType: contentType,
		}),
	);
	return ossPublicUrl(key, p);
}

/**
 * 预签名 PUT（第170轮直传）：客户端凭此 URL 把字节直传 OSS（国内用户→国内桶，绕开跨境服务器中转）。
 * 密钥只在服务端；URL 绑定 对象键+Content-Type，有效期内可发起上传（已开始的上传不因过期中断）。
 */
export async function ossPresignPut(key: string, contentType: string, expiresIn = 1800, t?: OssTarget): Promise<string> {
	const p = target(t); // 缺省=active 档：直传永远写进当前正在用的那套布局
	return getSignedUrl(
		client(p),
		new PutObjectCommand({ Bucket: p.bucket, Key: key.replace(/^\/+/, ""), ContentType: contentType }),
		{ expiresIn },
	);
}

/**
 * 删除对象（best-effort：直传超限拒收/缩略图清理用，失败不抛）。
 * ⚠ 删老资产必须传该行 `storage` 档解析出的 profile——用 active 档会打到新桶上，
 *   结果是「以为删了、其实老桶还占着容量」。
 */
export async function ossDelete(key: string, t?: OssTarget): Promise<void> {
	await ossDeleteStrict(key, t).catch(() => {});
}

/**
 * 删除对象（严格版：失败抛错——P3 清理执行用）。
 * 清理侧删失败必须**不打墓碑**（下轮重试）：吞掉错误照打墓碑=对象还在桶里占容量、
 * 却从台账统计里消失，成了 verify.mjs 才抓得到的孤儿。对象本就不存在时 S3 DELETE 返回 204 视为成功。
 */
export async function ossDeleteStrict(key: string, t?: OssTarget): Promise<void> {
	const p = target(t);
	await client(p).send(new DeleteObjectCommand({ Bucket: p.bucket, Key: key.replace(/^\/+/, "") }));
}

/** 连接自检：上传一个临时对象再删除，验证 endpoint/桶/密钥/权限 */
export async function ossSelfTest(): Promise<{ ok: boolean; url?: string; error?: string }> {
	if (!isOssConfigured()) return { ok: false, error: "OSS 未配置（endpoint/bucket/key 缺失）" };
	const p = activeProfile(); // 自检打在「新资产会落到的那个桶」上，才有意义
	const key = "assets/_admin_test.txt";
	try {
		const url = await ossPut(key, Buffer.from("qiji oss test"), "text/plain", p);
		const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
		const okRead = r.ok;
		await client(p).send(new DeleteObjectCommand({ Bucket: p.bucket, Key: key })).catch(() => {});
		return okRead ? { ok: true, url } : { ok: false, error: `上传成功但公网读取失败 HTTP ${r.status}（桶是否公有读？）` };
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
}
