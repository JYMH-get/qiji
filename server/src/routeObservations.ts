/** Passive measurements only: no probes, retries or upstream requests originate here. */
import { db } from './store/sqlite.ts';

export type FailureKind = 'user' | 'channel' | 'unknown';
function classifyFailure(error = ''): FailureKind {
  // Integration and transport failures must not become user errors just because they mention parameters/materials.
  if (/GroupId.*required|模型目录缺少|模型不存在或已禁用|素材加速失败|素材.*(?:上传失败|下载失败|无法访问)|download.*(?:media|content)|服务端重启|任务中断/i.test(error)) return 'unknown';
  if (/HTTP\s*(?:408|504)\b|timeout|timed.?out|超时|断网|fetch failed|network|ECONN|ENOTFOUND/i.test(error)) return 'unknown';
  if (/上游.*密钥|未配置.*(?:key|密钥)|invalid.?api.?key|authentication.?failed|insufficient.?balance|余额不足|预扣费额度失败|无可用额度|暂无可用额度|额度不足|配额不足|quota|rate.?limit|限流|concurrency.?limit|too many pending|模型已停售|MODEL_NOT_FOUND|unknown provider for model/i.test(error)) return 'channel';
  if (/审核|不合规|违规|敏感|违禁|版权|人脸|人像|提交错误|参数.*(?:有误|错误|不支持)|invalid.?parameter|moderation|policy|safety|unsafe|sensitive information|real person|guidelines|terms of use|content.?filter|face.?mismatch|参考.*(?:上限|最多)|时长.*(?:需|不符合)|提示词不能为空/i.test(error)) return 'user';
  return /capacity|overload|服务繁忙|服务不可用|服务异常|系统错误|系统异常|内部错误|internal.?error|internal.?server|service.?error|service.?busy|service.?unavailable|upstream.?error|channel.?error|渠道故障|通道故障|HTTP\s*5\d\d/i.test(error) ? 'channel' : 'unknown';
}
export function routeFailureKind(error = '', observationId?: string): FailureKind {
  const result = classifyFailure(error);
  // Only a generic failure can fall back to the latest raw receipt; transport/integration outcomes stay excluded.
  if (result !== 'unknown' || !/^(?:生成失败.*|generation failed.*|video generation failed.*|视频生成提交失败.*|unknown error|)$/i.test(error.trim())) return result;
  return classifyFailure(get(observationId)?.failureEvidence ?? '');
}
export const isChannelFailure = (error?: string, observationId?: string) => routeFailureKind(error, observationId) === 'channel';

interface Observation {
  id: string; lineId: string; channelId: string; modelId: string;
  familyName?: string; modelName?: string; lineName?: string;
  startedAt: number; sentAt?: number; responseAt?: number; acceptedAt?: number; finishedAt?: number;
  slowRequestSec: number; status: 'running' | 'success' | 'failed'; failureKind?: FailureKind; error?: string;
  failureEvidence?: string;
}
db.exec(`CREATE TABLE IF NOT EXISTS route_observations (
  id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, line_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  finished_at INTEGER, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS route_observations_hour ON route_observations(started_at);
CREATE INDEX IF NOT EXISTS route_observations_pending ON route_observations(line_id, channel_id, started_at) WHERE finished_at IS NULL;`);
const read = db.prepare('SELECT data FROM route_observations WHERE id=?');
const upsert = db.prepare('INSERT OR REPLACE INTO route_observations(id,started_at,line_id,channel_id,finished_at,data) VALUES(?,?,?,?,?,?)');
const pending = db.prepare('SELECT COUNT(*) AS n FROM route_observations WHERE line_id=? AND channel_id=? AND finished_at IS NULL AND started_at<=?');
const activeByLine = db.prepare('SELECT channel_id, COUNT(*) AS n FROM route_observations WHERE line_id=? AND finished_at IS NULL GROUP BY channel_id');
export function routeActiveCounts(lineId: string): Record<string, number> {
  return Object.fromEntries((activeByLine.all(lineId) as { channel_id: string; n: number }[]).map(r => [r.channel_id, Number(r.n)]));
}
export function pendingRouteObservationIds(): string[] {
  return (db.prepare('SELECT id FROM route_observations WHERE finished_at IS NULL').all() as { id: string }[]).map(r => r.id);
}
let lastPrune = 0;
function get(id?: string): Observation | undefined { const row = id ? read.get(id) as { data: string } | undefined : undefined; return row ? JSON.parse(row.data) : undefined; }
function put(o: Observation) { upsert.run(o.id, o.startedAt, o.lineId, o.channelId, o.finishedAt ?? null, JSON.stringify(o)); }
export function routeObservationIdentity(id: string) {
  const o = get(id);
  return o ? { lineId:o.lineId, modelId:o.modelId, familyName:o.familyName, modelName:o.modelName, lineName:o.lineName } : undefined;
}
export function beginRouteObservation(id: string, ticket: { lineId: string; channelId: string; modelId: string; familyName?: string; modelName?: string; lineName?: string }, slowRequestSec: number, now = Date.now()) {
  if (get(id)) return;
  put({ id, ...ticket, startedAt: now, slowRequestSec, status: 'running' });
  if (now - lastPrune > 3600000) {
    db.prepare('DELETE FROM route_observations WHERE started_at<? AND finished_at IS NOT NULL').run(now - 30 * 86400000);
    lastPrune = now;
  }
}
export function observeUpstream(id: string, rec: { request?: unknown; response?: unknown }, now = Date.now()) {
  const o = get(id); if (!o || o.finishedAt) return;
  const request = rec.request as { method?: string; phase?: string } | undefined;
  if (request?.method?.toUpperCase() === 'POST' && (!request.phase || request.phase === 'submit') && o.sentAt === undefined) { o.sentAt = now; put(o); }
  const response = rec.response as { phase?: string; error?: unknown; httpStatus?: number } | undefined;
  if (response !== undefined) {
    const fields: string[] = [];
    const collect = (value: unknown, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 6) return;
      for (const [key, v] of Object.entries(value)) {
        if (/^(error|message|msg|code|reason|failure_reason)$/i.test(key) && typeof v === 'string') fields.push(v);
        else if (/^(body|data|error|result)$/i.test(key)) collect(v, depth + 1);
      }
    };
    collect(response);
    o.failureEvidence = errorSummary(fields.join(' '));
    put(o);
  }
  if (response !== undefined && o.sentAt !== undefined && o.responseAt === undefined
    && (!response?.phase || response.phase === 'submit') && (!response?.error || response.httpStatus !== undefined)) {
    o.responseAt = now; put(o);
  }
}
export function observeAccepted(id?: string, now = Date.now()) {
  const o = get(id); if (!o || o.finishedAt || o.acceptedAt !== undefined) return;
  o.acceptedAt = now; put(o);
}
function errorSummary(error: string) {
  return error.replace(/https?:\/\/\S+/gi, '[地址]').replace(/(?:Bearer\s+|sk-|ank-)[\w.-]+/gi, '[凭据]')
    .replace(/[\da-f]{8}-[\da-f-]{20,}/gi, '[ID]').replace(/[A-Za-z0-9_-]{24,}/g, '[ID]').slice(0, 180);
}
export function finishRouteObservation(id: string | undefined, success: boolean, error?: string, now = Date.now()) {
  const o = get(id); if (!o || o.finishedAt !== undefined) return;
  o.finishedAt = now; o.status = success ? 'success' : 'failed';
  if (!success) { o.failureKind = routeFailureKind(error, id); o.error = errorSummary(error || '未提供失败原因'); }
  put(o);
}
export function slowRouteCount(lineId: string, channelId: string, seconds = 900, now = Date.now()): number {
  return Number((pending.get(lineId, channelId, now - seconds * 1000) as { n: number }).n);
}
export function routingHourlyStats(hours = 24, now = Date.now()) {
  const since = Math.floor(now / 3600000) * 3600000 - (hours - 1) * 3600000;
  const records = db.prepare('SELECT data FROM route_observations WHERE started_at>=? AND started_at<=? ORDER BY started_at DESC').all(since, now) as { data: string }[];
  const groups = new Map<string, {
    hour: number; lineId: string; channelId: string; requests: number; success: number; failed: number;
    userFailures: number; channelFailures: number; unknownFailures: number; running: number; slow: number;
    generationTotalMs: number; responseTotalMs: number; responseSamples: number; errors: Map<string, number>;
  }>();
  for (const row of records) {
    const o: Observation = JSON.parse(row.data), hour = Math.floor(o.startedAt / 3600000) * 3600000;
    const key = `${hour}/${o.lineId}/${o.channelId}`;
    const g = groups.get(key) ?? { hour, lineId: o.lineId, channelId: o.channelId, requests: 0, success: 0, failed: 0,
      userFailures: 0, channelFailures: 0, unknownFailures: 0, running: 0, slow: 0, generationTotalMs: 0, responseTotalMs: 0, responseSamples: 0, errors: new Map() };
    g.requests++;
    if (o.status === 'success') { g.success++; g.generationTotalMs += o.finishedAt! - o.startedAt; }
    else if (o.status === 'running') g.running++;
    else {
      g.failed++; if (o.failureKind === 'user') g.userFailures++; else if (o.failureKind === 'channel') g.channelFailures++; else g.unknownFailures++;
      const text = `${o.failureKind === 'user' ? '用户原因' : o.failureKind === 'channel' ? '渠道故障' : '结果未知'}：${o.error}`;
      g.errors.set(text, (g.errors.get(text) ?? 0) + 1);
    }
    if ((o.finishedAt ?? now) - o.startedAt >= o.slowRequestSec * 1000) g.slow++;
    if (o.responseAt !== undefined && o.sentAt !== undefined) { g.responseTotalMs += o.responseAt - o.sentAt; g.responseSamples++; }
    groups.set(key, g);
  }
  return { hours, since, until: now, rows: [...groups.values()].map(({ generationTotalMs, responseTotalMs, errors, ...g }) => ({
    ...g, successRate: g.success + g.failed ? g.success / (g.success + g.failed) : null,
    averageGenerationMs: g.success ? generationTotalMs / g.success : null,
    averageResponseMs: g.responseSamples ? responseTotalMs / g.responseSamples : null,
    topErrors: [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([message, count]) => ({ message, count })),
  })) };
}
