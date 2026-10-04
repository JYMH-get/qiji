import { db } from './sqlite.ts';
import type { LogMeta } from './logs.ts';
import type { UsageReportScope } from '../usageReportTypes.ts';
import { productKind, type ProductKind, type UsageProduct } from '../usageProducts.ts';

// First company created in the confirmed 2026-09-17 split. Historical Excel files
// are deliberately not imported. All companies share this new reporting epoch.
export const USAGE_REPORT_START = '2026-09-17T07:28:13.954Z';

db.exec(`
  CREATE TABLE IF NOT EXISTS usage_report_entries (
    id TEXT PRIMARY KEY, day TEXT NOT NULL, scope TEXT NOT NULL, cost REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS usage_report_entries_day ON usage_report_entries(day);
  CREATE TABLE IF NOT EXISTS usage_report_daily (
    company_id TEXT NOT NULL, group_id TEXT NOT NULL, user_id TEXT NOT NULL,
    day TEXT NOT NULL, scope TEXT NOT NULL, cost REAL NOT NULL,
    PRIMARY KEY(company_id, group_id, user_id, day)
  );
  CREATE INDEX IF NOT EXISTS usage_report_daily_day ON usage_report_daily(day);
  CREATE TABLE IF NOT EXISTS usage_report_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS usage_report_products (
    company_id TEXT NOT NULL, group_id TEXT NOT NULL, user_id TEXT NOT NULL, day TEXT NOT NULL,
    kind TEXT NOT NULL, scope TEXT NOT NULL, quantity REAL NOT NULL, cost REAL NOT NULL,
    known_cost REAL NOT NULL, requests INTEGER NOT NULL, missing INTEGER NOT NULL, estimated INTEGER NOT NULL,
    PRIMARY KEY(company_id,group_id,user_id,day,kind)
  );
`);
if (!(db.prepare('PRAGMA table_info(usage_report_entries)').all() as {name:string}[]).some(c => c.name === 'product')) db.exec('ALTER TABLE usage_report_entries ADD COLUMN product TEXT');

interface ProductEntry extends UsageProduct { cost: number }
interface Entry { id: string; day: string; scope: UsageReportScope; cost: number; product: ProductEntry | null }
const pending = new Map<string, Entry>();
const entryGet = db.prepare('SELECT scope,day,cost,product FROM usage_report_entries WHERE id=?');
const entryPut = db.prepare('INSERT INTO usage_report_entries(id,day,scope,cost,product) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET cost=excluded.cost,product=excluded.product');
const productAdd = db.prepare(`INSERT INTO usage_report_products(company_id,group_id,user_id,day,kind,scope,quantity,cost,known_cost,requests,missing,estimated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(company_id,group_id,user_id,day,kind) DO UPDATE SET quantity=quantity+excluded.quantity,cost=cost+excluded.cost,known_cost=known_cost+excluded.known_cost,requests=requests+excluded.requests,missing=missing+excluded.missing,estimated=estimated+excluded.estimated`);
const dailyAdd = db.prepare(`INSERT INTO usage_report_daily(company_id,group_id,user_id,day,scope,cost) VALUES(?,?,?,?,?,?)
  ON CONFLICT(company_id,group_id,user_id,day) DO UPDATE SET cost=usage_report_daily.cost+excluded.cost`);
const statePut = db.prepare('INSERT INTO usage_report_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');

export function queueUsage(logs: readonly LogMeta[], resolve: (log: LogMeta) => UsageReportScope | undefined): void {
  for (const log of logs) {
    if (!log.userId || log.purpose === 'code.issue' || log.startedAt < USAGE_REPORT_START) continue;
    if (!Number.isFinite(Date.parse(log.startedAt))) continue;
    const scope = pending.get(log.id)?.scope ?? log.usageReportScope ?? resolve(log);
    if (!scope) continue;
    const amount = Number(log.cost ?? 0);
    if (!Number.isFinite(amount) || amount < 0) throw new Error('Invalid usage amount: ' + log.id);
    const kind = log.model === 'fee-thirdparty' ? undefined : productKind(log.purpose);
    // Normalize retained metadata too: old processing entries used image counts/video seconds.
    const quantity = kind === 'other' ? {kind,quantity:1,estimated:false} : log.usageProduct && log.usageProduct.kind === kind ? log.usageProduct : {kind,quantity: kind === 'text' || kind === 'audio' ? 1 : null,estimated:false};
    const product = log.status === 'success' && kind ? { ...quantity, kind, cost: amount } : null;
    pending.set(log.id, { id: log.id, day: log.startedAt.slice(0, 10), scope, cost: log.status === 'failed' && !(log.localExecution && log.localRefundOnFailure === false) ? 0 : amount, product });
  }
}

/** Idempotent deltas also repair the original request date after a late refund/token settlement. */
export function flushUsage(now = Date.now()): void {
  const batch = [...pending.values()];
  db.exec('BEGIN');
  try {
    for (const item of batch) {
      const previous = entryGet.get(item.id) as { scope: string; day: string; cost: number; product: string | null } | undefined;
      const scopeText = previous?.scope ?? JSON.stringify(item.scope);
      const scope = previous ? JSON.parse(scopeText) as UsageReportScope : item.scope;
      const day = previous?.day ?? item.day;
      const delta = item.cost - (previous?.cost ?? 0);
      if (!previous || delta !== 0) {
        dailyAdd.run(scope.companyId, scope.groupId, scope.userId, day, scopeText, delta);
      }
      const productText = item.product ? JSON.stringify(item.product) : null;
      if (productText !== (previous?.product ?? null)) {
        const add = (p: ProductEntry, sign: number) => productAdd.run(scope.companyId,scope.groupId,scope.userId,day,p.kind,scopeText,sign*(p.quantity??0),sign*p.cost,p.quantity === null ? 0 : sign*p.cost,sign,p.quantity === null ? sign : 0,p.estimated ? sign : 0);
        if (previous?.product) add(JSON.parse(previous.product),-1);
        if (item.product) add(item.product,1);
      }
      entryPut.run(item.id, day, scopeText, item.cost, productText);
    }
    // Keep compact identities so late settlement or replay of retained running logs cannot double-count.
    statePut.run('updatedAt', new Date(now).toISOString());
    db.exec('COMMIT');
    for (const item of batch) pending.delete(item.id);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error; // Pending entries stay queued for a retry.
  }
}

export interface ProductRow { day:string; scope:UsageReportScope; kind:ProductKind; quantity:number; cost:number; known_cost:number; requests:number; missing:number; estimated:number }
export function productRows(companyId: string, fromDay: string, toDay: string, teamId?: string, userId?: string): ProductRow[] {
  const query = 'SELECT day,scope,kind,quantity,cost,known_cost,requests,missing,estimated FROM usage_report_products WHERE day>=? AND day<=?';
  const rows = userId ? db.prepare(query+' AND user_id=?').all(fromDay,toDay,userId) : teamId ? db.prepare(query+' AND group_id=?').all(fromDay,toDay,teamId) : companyId === 'all' ? db.prepare(query).all(fromDay,toDay) : db.prepare(query+' AND company_id=?').all(fromDay,toDay,companyId);
  return (rows as (Omit<ProductRow,'scope'> & {scope:string})[]).map(r => ({...r,scope:JSON.parse(r.scope)}));
}

export function usageRows(companyId: string, fromDay: string, toDay: string, teamId?: string): { day: string; scope: UsageReportScope; cost: number }[] {
  const rows = teamId ? db.prepare('SELECT day,scope,cost FROM usage_report_daily WHERE group_id=? AND day>=? AND day<=? ORDER BY day').all(teamId,fromDay,toDay) : companyId === 'all'
    ? db.prepare('SELECT day,scope,cost FROM usage_report_daily WHERE day>=? AND day<=? ORDER BY day').all(fromDay, toDay)
    : db.prepare('SELECT day,scope,cost FROM usage_report_daily WHERE company_id=? AND day>=? AND day<=? ORDER BY day').all(companyId, fromDay, toDay);
  return (rows as { day: string; scope: string; cost: number }[]).map(r => ({ ...r, scope: JSON.parse(r.scope) as UsageReportScope }));
}

export function archivedUsageCompanies(): { id: string; name: string }[] {
  return (db.prepare('SELECT company_id,scope FROM usage_report_daily GROUP BY company_id').all() as { company_id: string; scope: string }[])
    .map(r => ({ id: r.company_id, name: (JSON.parse(r.scope) as UsageReportScope).companyName }));
}
