/** Official image/video/audio preparation; generation only validates certified bindings. */
import { createHash } from "node:crypto";
import { upstreamCreditFeedback, UPSTREAM_CREDIT_SHORTAGE } from './creditFeedback.ts';
import type { AssetRef, MaterialPolicy } from "./contract.ts";
import type { ModelDef } from "./store/models.ts";
import { currentAssetOwner, getAsset } from "./store/assets.ts";
import { maskToken } from "./store/logs.ts";
import { toPublicUrl } from "./translators/jianmeng.ts";
import type { Upstream } from "./translators/upstream.ts";
import type { OnUpstream } from "./translators/openai.ts";
import { materialPolicyForModel } from "./materialPolicy.ts";
import {
	getOfficialAssetBinding, getOfficialAssetBindingById, putOfficialAssetBinding, deleteOfficialAssetBinding,
	getOfficialAssetGroup, putOfficialAssetGroup, deleteOfficialAssetGroup,
	type OfficialAssetBinding, type OfficialAssetScope,
} from "./store/officialAssets.ts";

export interface OfficialMaterialState {
	status: "Active" | "Processing" | "Failed";
	error?: string;
	checkedAt: number;
	scopeKey: string;
	/** Returned after certification so the client can submit the exact prepared ID. */
	assetId?: string;
}
type CheckedMaterial = OfficialMaterialState;
interface Context {
	ref: AssetRef; url: string; up: Upstream; policy: MaterialPolicy; model: ModelDef;
	assetType: "Image" | "Video" | "Audio";
	scope: OfficialAssetScope; sourceKey: string; sourceUrlHash: string; legacySourceKey: string;
	onUpstream?: OnUpstream;
}
const flights = new Map<string, Promise<CheckedMaterial>>();
const groupFlights = new Map<string, Promise<string>>();
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const scopeIdentity = (scope: OfficialAssetScope) => JSON.stringify([scope.channelId, scope.credentialHash, scope.upstreamModel]);

function errorParts(data: any): { code: string; message: string } {
	const err = data?.Error ?? data?.error ?? data?.data?.Error ?? data?.data?.error;
	return {
		code: String(err?.Code ?? err?.code ?? data?.Code ?? data?.code ?? "").trim(),
		message: String(err?.Message ?? err?.message ?? (typeof err === "string" ? err : undefined) ?? data?.Message ?? data?.message ?? "").trim(),
	};
}
function failureMessage(code: string, message: string): string {
	const feedback = upstreamCreditFeedback(`${code}: ${message}`);
	if (feedback === UPSTREAM_CREDIT_SHORTAGE) return feedback;
	const known: Record<string, string> = {
		FaceMismatch: "真人脸一致性校验失败", ContentRestricted: "素材内容安全审核未通过",
		DownloadFailed: "官方上游无法下载该素材，请检查素材公网地址", TranscodingFailed: "素材转码或处理失败",
		TypeMismatch: "素材实际类型与声明类型不一致", FormatUnsupported: "素材格式不受支持",
		FileSizeTooLarge: "素材超过官方素材库大小上限", SubscriptionRequired: "当前官方渠道未开通素材库能力",
	};
	const prefix = known[code] ?? "官方素材验证失败";
	return message ? `${prefix}：${message}` : prefix;
}
function httpError(data: any, status: number): Error {
	const { code, message } = errorParts(data);
	const feedback = upstreamCreditFeedback(`${code}: ${message}`);
	if (feedback === UPSTREAM_CREDIT_SHORTAGE) return new Error(feedback);
	if (status === 401) return new Error("官方素材库密钥无效，请联系运营检查渠道设置");
	if (status === 403) return new Error(message ? `官方素材库拒绝：${message}` : "官方素材库无权限或余额不足");
	if (status === 429) return new Error("官方素材库限流，请稍后重试");
	if (status >= 500) return new Error("官方素材库服务暂时异常，请稍后重试");
	return new Error(message ? failureMessage(code, message) : `官方素材库请求失败（HTTP ${status}）`);
}
async function assetApi(ctx: Context, action: string, body: Record<string, unknown>) {
	const url = `${ctx.up.baseUrl}/v3/open/${action}`;
	ctx.onUpstream?.({ request: { phase: "official-asset", url, method: "POST", headers: { Authorization: `Bearer ${maskToken(ctx.up.apiKey)}`, "Content-Type": "application/json" }, body } });
	let response: Response;
	try {
		response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${ctx.up.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
	} catch { throw new Error("官方素材库连接失败，请稍后重试"); }
	const data: any = await response.json().catch(() => ({}));
	ctx.onUpstream?.({ response: { phase: "official-asset", httpStatus: response.status, body: data } });
	return { response, data };
}
function materialScope(model: ModelDef, up: Upstream): { scope: OfficialAssetScope; policy: MaterialPolicy } {
	const policy = materialPolicyForModel(model);
	if (policy.kind !== "official-assets" || !policy.library) throw new Error("当前线路不使用官方人像素材库");
	const actualLibrary = /^(sd|me|we)-/.exec(up.upstreamModel)?.[1];
	if (actualLibrary && actualLibrary !== policy.library) throw new Error("模型重定向的素材库与线路配置不一致，请联系运营调整");
	if (!up.apiKey || !up.baseUrl) throw new Error("官方素材库渠道地址或密钥未配置");
	const userId = currentAssetOwner()?.userId;
	if (!userId) throw new Error("人像素材处理缺少用户身份，请重新登录");
	const scope = {
		// A logical channel may be cloned without changing the upstream library/account.
		userId, channelId: `provider:${digest(up.baseUrl).slice(0, 24)}`,
		credentialHash: digest(`${up.baseUrl}|${up.apiKey}`),
		// Libraries are separate namespaces. Model variants within the same library share IDs.
		upstreamModel: `library:${policy.library}:${policy.groupRequired ? "group" : "plain"}`,
	};
	return { scope, policy };
}
function context(ref: AssetRef, model: ModelDef, up: Upstream, onUpstream?: OnUpstream): Context {
	const { scope, policy } = materialScope(model, up);
	const assetType = ref.officialAssetType ?? 'Image';
	if (!['Image', 'Video', 'Audio'].includes(assetType)) throw new Error('官方素材类型无效');
	const rec = ref.id ? getAsset(ref.id) : undefined;
	// Media size/type acceptance belongs to the upstream. Ledger metadata is only used for deduplication.
	const url = toPublicUrl(ref);
	if (!url) throw new Error("素材尚未上传完成或缺少可用公网地址");
	const sourceUrlHash = digest(url);
	const rawSourceKey = rec?.sha256 ? `sha:${rec.sha256}` : ref.id ? `id:${ref.id}:url:${sourceUrlHash}` : `url:${sourceUrlHash}`;
	// Preserve image cache keys; newly supported media cannot collide by URL or bytes.
	const sourceKey = assetType === 'Image' ? rawSourceKey : `${assetType}:${rawSourceKey}`;
	const legacySourceKey = rec?.sha256 ? `id:${ref.id}:sha:${rec.sha256}` : sourceKey;
	return { ref, model, up, policy, url, scope, sourceKey, sourceUrlHash, legacySourceKey, assetType, onUpstream };
}
function scopeToken(ctx: Context): string { return ctx.policy.scopeKey ?? digest(scopeIdentity(ctx.scope)); }
function isAssetMissing(status: number, data: any): boolean {
	const { code } = errorParts(data);
	// Do not interpret an unknown gateway 404 or an unrelated NotFound as an expired asset.
	return /^(?:NotFound\.asset_?id|AssetNotFound|ResourceNotFound(?:\.Asset)?)$/i.test(code)
		|| (status === 404 && /asset/i.test(code) && /not.?found/i.test(code));
}
function legacyBinding(ctx: Context): OfficialAssetBinding | undefined {
	if (ctx.assetType !== 'Image') return;
	// Only import the exact old model and credential scope, and only its documented protocol.
	const prefix = /^([a-z]+)-/.exec(ctx.up.upstreamModel)?.[1];
	if (prefix !== ctx.policy.library) return;
	const old = getOfficialAssetBinding({ ...ctx.scope, channelId: ctx.model.channelId ?? "ch-official", credentialHash: digest(ctx.up.apiKey), upstreamModel: ctx.up.upstreamModel }, ctx.legacySourceKey);
	if (!old || Boolean(old.groupId) !== Boolean(ctx.policy.groupRequired)) return;
	return old;
}
function saveBinding(ctx: Context, binding: { assetId: string; groupId?: string; status: string; errorCode?: string; errorMessage?: string }) {
	putOfficialAssetBinding({ ...ctx.scope, sourceKey: ctx.sourceKey, sourceUrlHash: ctx.sourceUrlHash, assetType: ctx.assetType, assetId: binding.assetId, groupId: binding.groupId, status: binding.status, errorCode: binding.errorCode, errorMessage: binding.errorMessage });
}
async function checkBinding(ctx: Context, binding: Pick<OfficialAssetBinding, "assetId" | "groupId">): Promise<CheckedMaterial | undefined> {
	const { response, data } = await assetApi(ctx, "GetAsset", { model: ctx.up.upstreamModel, Id: binding.assetId });
	if (isAssetMissing(response.status, data)) { deleteOfficialAssetBinding(ctx.scope, ctx.sourceKey); return; }
	if (!response.ok) throw httpError(data, response.status);
	const view = data?.data && typeof data.data === "object" ? data.data : data;
	const responseId = view?.Id ?? view?.id;
	if (responseId !== undefined && String(responseId) !== binding.assetId) throw new Error("官方素材查询返回了不匹配的素材 ID，请稍后重试");
	// Providers may normalize AssetType differently; use their status/error instead of rejecting a successful response.
	const rawStatus = String(view?.Status ?? view?.status ?? "").trim().toLowerCase();
	const { code, message } = errorParts(view);
	if (code && !rawStatus) throw httpError(data, response.status);
	if (!["active", "failed", "processing"].includes(rawStatus)) throw new Error("官方素材库返回的处理状态无法识别，请稍后重试");
	const status = rawStatus === "active" ? "Active" : rawStatus === "failed" ? "Failed" : "Processing";
	saveBinding(ctx, { ...binding, status, errorCode: code || undefined, errorMessage: message || undefined });
	if (status === "Active" && binding.groupId && !getOfficialAssetGroup(ctx.scope)) putOfficialAssetGroup({ ...ctx.scope, groupId: binding.groupId });
	return { status, assetId: binding.assetId, checkedAt: Date.now(), scopeKey: scopeToken(ctx), error: status === "Failed" ? failureMessage(code, message) : undefined };
}
async function groupIdFor(ctx: Context): Promise<string | undefined> {
	if (!ctx.policy.groupRequired) return;
	const cached = getOfficialAssetGroup(ctx.scope);
	if (cached) return cached.groupId;
	const key = scopeIdentity(ctx.scope);
	let pending = groupFlights.get(key);
	if (!pending) {
		pending = (async () => {
			const { response, data } = await assetApi(ctx, "CreateAssetGroup", { model: ctx.up.upstreamModel, Name: `Qiji-${digest(key).slice(0, 20)}`, GroupType: "AIGC" });
			const id = data?.Id ?? data?.id ?? data?.data?.Id ?? data?.data?.id;
			if (!response.ok || !id) throw httpError(data, response.status);
			putOfficialAssetGroup({ ...ctx.scope, groupId: String(id) });
			return String(id);
		})();
		groupFlights.set(key, pending);
	}
	try { return await pending; } finally { if (groupFlights.get(key) === pending) groupFlights.delete(key); }
}
async function createAndCheck(ctx: Context): Promise<CheckedMaterial> {
	let groupId = await groupIdFor(ctx);
	const body = () => ({ model: ctx.up.upstreamModel, ...(groupId ? { GroupId: groupId } : {}), URL: ctx.url, Name: `Qiji-${ctx.assetType.toLowerCase()}-${digest(ctx.sourceKey).slice(0, 16)}`, AssetType: ctx.assetType });
	let result = await assetApi(ctx, "CreateAsset", body());
	const err = errorParts(result.data);
	if (!result.response.ok && groupId && /group/i.test(err.code) && /not.?found/i.test(err.code)) {
		deleteOfficialAssetGroup(ctx.scope);
		groupId = await groupIdFor(ctx);
		result = await assetApi(ctx, "CreateAsset", body());
	}
	const id = result.data?.Id ?? result.data?.id ?? result.data?.data?.Id ?? result.data?.data?.id;
	if (!result.response.ok || !id) throw httpError(result.data, result.response.status);
	const binding = { assetId: String(id), groupId, status: "Processing" };
	saveBinding(ctx, binding);
	// A create response, even one labelled Active, is not evidence for reuse.
	const state = await checkBinding(ctx, binding);
	if (!state) throw new Error("官方素材创建后记录不可用，请稍后重试");
	return state;
}
const reviewDay = (time: number) => Math.floor((time + 8 * 3600000) / 86400000);
function observedBinding(ctx: Context, binding: OfficialAssetBinding): CheckedMaterial {
 return { status: binding.status as CheckedMaterial['status'], assetId: binding.assetId, checkedAt: binding.updatedAt,
  scopeKey: scopeToken(ctx), error: binding.status === 'Failed' ? failureMessage(binding.errorCode ?? '', binding.errorMessage ?? '') : undefined };
}
async function prepare(ctx: Context, retry: boolean): Promise<CheckedMaterial> {
	const current = getOfficialAssetBinding(ctx.scope, ctx.sourceKey);
 const binding = current ?? legacyBinding(ctx);
	if (binding) {
  if (current && !retry && ['Active', 'Failed'].includes(binding.status) && reviewDay(binding.updatedAt) === reviewDay(Date.now())) return observedBinding(ctx, binding);
		const state = await checkBinding(ctx, binding);
		if (state && !(retry && state.status === "Failed")) return state;
		if (state) deleteOfficialAssetBinding(ctx.scope, ctx.sourceKey);
	}
	return createAndCheck(ctx);
}
async function checked(ref: AssetRef, model: ModelDef, up: Upstream, options: { retry?: boolean; onUpstream?: OnUpstream } = {}): Promise<CheckedMaterial> {
	const ctx = context(ref, model, up, options.onUpstream);
	const key = `${scopeIdentity(ctx.scope)}|${ctx.sourceKey}`;
	let pending = flights.get(key);
	if (!pending) { pending = prepare(ctx, options.retry === true); flights.set(key, pending); }
	try { return await pending; } finally { if (flights.get(key) === pending) flights.delete(key); }
}
/** Placement/route switches inspect an existing binding without uploading. */
export async function inspectOfficialMaterial(ref: AssetRef, model: ModelDef, up: Upstream): Promise<OfficialMaterialState & { uploadRequired?: boolean }> {
 const ctx = context(ref, model, up);
 const binding = getOfficialAssetBinding(ctx.scope, ctx.sourceKey) ?? legacyBinding(ctx);
 if (binding) {
  const key = `inspect:${scopeIdentity(ctx.scope)}|${ctx.sourceKey}`;
  let pending = flights.get(key);
  if (!pending) {
   pending = (async () => (await checkBinding(ctx, binding)) ?? { status: 'Failed' as const, checkedAt: Date.now(), scopeKey: scopeToken(ctx) })();
   flights.set(key, pending);
  }
  try {
   const state = await pending;
   return { ...state, assetId: state.status === 'Active' ? state.assetId : undefined, uploadRequired: state.status === 'Failed' };
  } finally { if (flights.get(key) === pending) flights.delete(key); }
 }
 return { status: 'Processing', checkedAt: Date.now(), scopeKey: scopeToken(ctx), uploadRequired: true };
}
/** Legacy callers retain daily preparation; new clients explicitly inspect on each placement. */
export async function prepareOfficialMaterial(ref: AssetRef, model: ModelDef, up: Upstream, options: { retry?: boolean; onUpstream?: OnUpstream } = {}): Promise<OfficialMaterialState> {
	const state = await checked(ref, model, up, options);
	return { ...state, assetId: state.status === 'Active' ? state.assetId : undefined };
}
/** Generation validates the client's prepared ID only; it never creates or polls materials. */
export async function officialIdentityUrl(ref: AssetRef, model: ModelDef, up: Upstream, assetType: "Image" | "Video" | "Audio" = 'Image'): Promise<string> {
	const assetId = ref.officialAssetId;
	const label = { Image: '图片', Video: '视频', Audio: '音频' }[assetType];
	if (typeof assetId !== 'string' || !assetId.trim() || assetId !== assetId.trim()) throw new Error(`${label}缺少已准备的官方素材库 ID，请在客户端完成素材准备后重试`);
	const { scope } = materialScope(model, up);
	const binding = getOfficialAssetBindingById(scope, assetId);
	if (!binding) throw new Error(`${label}素材库 ID 不适用于所选模型的素材库/上游账号，请在客户端重新准备素材`);
	if (binding.status === 'Failed') throw new Error(failureMessage(binding.errorCode ?? '', binding.errorMessage ?? ''));
	if (binding.status !== 'Active') throw new Error(`${label}素材仍在预处理，状态变为绿色后再生成`);
	return `asset://${assetId}`;
}
