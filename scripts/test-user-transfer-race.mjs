import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'outputs/user-transfer-20260915');
const legacyGuards = process.argv.includes('--legacy-guards');
const evidencePrefix = legacyGuards ? 'race-legacy-control' : 'race';
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qiji-user-transfer-race-'));
const protectedFiles = ['users.json', 'agents.json', 'teams.json', 'tasks.json', 'settings.json', 'qiji.db', 'qiji.db-wal'];
const realDataHashes = () => Object.fromEntries(protectedFiles.flatMap(name => {
  const file = path.join(root, 'server/data', name);
  return fs.existsSync(file) ? [[name, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]] : [];
}));
const before = realDataHashes();
fs.mkdirSync(path.join(sandbox, 'src'));
fs.mkdirSync(path.join(sandbox, 'server/scripts'), { recursive: true });
fs.copyFileSync(path.join(root, 'src/contract.ts'), path.join(sandbox, 'src/contract.ts'));
for (const dir of ['src', 'skills']) fs.cpSync(path.join(root, 'server', dir), path.join(sandbox, 'server', dir), { recursive: true });
fs.copyFileSync(path.join(root, 'server/package.json'), path.join(sandbox, 'server/package.json'));
fs.symlinkSync(path.join(root, 'server/node_modules'), path.join(sandbox, 'server/node_modules'), 'junction');
fs.copyFileSync(path.join(root, 'server/scripts/smoke-user-transfer-race.mjs'), path.join(sandbox, 'server/scripts/smoke-user-transfer-race.mjs'));
fs.writeFileSync(path.join(sandbox, 'server/.qiji-user-transfer-race-sandbox'), 'isolated empty data, no .env or production data copied');

// Only the copied preflight receives a gate; real auth/routes/transfer/settle are unchanged.
const preflightPath = path.join(sandbox, 'server/src/refVideoBilling.ts');
const original = fs.readFileSync(preflightPath, 'utf8');
const needle = '): Promise<RefVideoBilling> {';
assert.equal(original.split(needle).length, 2, 'preflight insertion point is unique');
fs.writeFileSync(preflightPath, original.replace(needle, `${needle}\n  await (globalThis as any).__qijiTransferRaceGate?.(md, params, inputs);`));
if (legacyGuards) {
  const routesPath = path.join(sandbox, 'server/src/routes.ts');
  const routes = fs.readFileSync(routesPath, 'utf8');
  const guard = 'user.accessKey !== requestAccessKey || requestPayment.priceOwner.accessKey !== requestPriceOwnerKey || ';
  assert.equal(routes.split(guard).length, 4, 'all three credential guards identified in copied routes');
  fs.writeFileSync(routesPath, routes.replaceAll(guard, ''));
}
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, `${evidencePrefix}-sandbox.txt`), sandbox);
try {
  const output = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/smoke-user-transfer-race.mjs'], {
    cwd: path.join(sandbox, 'server'), encoding: 'utf8', timeout: 90000,
    env: { ...process.env, QIJI_TEST_SNAPSHOT: '1', ADMIN_TOKEN: 'admin-dev', NODE_ROLE: 'source' },
  });
  if (legacyGuards) throw Error('Negative control unexpectedly accepted the legacy guards');
  fs.writeFileSync(path.join(out, `${evidencePrefix}-tests.log`), output);
  process.stdout.write(output);
  fs.copyFileSync(path.join(sandbox, 'server/race-verification.json'), path.join(out, 'race-verification.json'));
} catch (error) {
  const output = String(error.stdout ?? '') + String(error.stderr ?? '');
  fs.writeFileSync(path.join(out, `${evidencePrefix}-tests.log`), output);
  if (!legacyGuards) throw error;
  assert.match(output, /single-owner-ABA: stale single request rejected/);
  assert.match(output, /200 !== 409/);
  fs.writeFileSync(path.join(out, `${evidencePrefix}-verification.json`), JSON.stringify({ regressionDetected: true, expected: '409', legacyActual: '200', productionCodeUnchanged: true }, null, 2));
  console.log('USER_TRANSFER_RACE_LEGACY_CONTROL_PASSED: removing copied credential guards reproduces ABA acceptance (200 instead of 409)');
} finally {
  const after = realDataHashes();
  assert.deepEqual(after, before, 'real data remains byte-identical');
  fs.writeFileSync(path.join(out, `${evidencePrefix}-real-data-verification.json`), JSON.stringify({ unchanged: true, files: Object.keys(before) }, null, 2));
}
console.log('Race sandbox:', sandbox);
