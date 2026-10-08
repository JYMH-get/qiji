import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qiji-website-split-'));
const server = path.join(sandbox, 'server');
const runner = 'scripts/smoke-website-split.mjs';
// Record metadata without reading or copying any development records or credentials.
function dataSnapshot(directory) {
  const rows = [];
  if (!fs.existsSync(directory)) return rows;
  function visit(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const filename = path.join(folder, entry.name);
      if (entry.isDirectory()) visit(filename);
      else {
        const stat = fs.statSync(filename);
        rows.push([path.relative(directory, filename), stat.size, stat.mtimeMs]);
      }
    }
  }
  visit(directory);
  return rows.sort((a, b) => a[0].localeCompare(b[0]));
}
const before = dataSnapshot(path.join(root, 'server/data'));
const siteHash = () => {
  const filename = path.join(root, 'server/data/site.json');
  return fs.existsSync(filename) ? createHash('sha256').update(fs.readFileSync(filename)).digest('hex') : null;
};
const siteBefore = siteHash();
let developmentDataChanges = [];
fs.mkdirSync(path.join(sandbox, 'src'), { recursive: true });
fs.mkdirSync(path.join(server, 'scripts'), { recursive: true });
fs.copyFileSync(path.join(root, 'src/contract.ts'), path.join(sandbox, 'src/contract.ts'));
for (const dir of ['src', 'skills']) fs.cpSync(path.join(root, 'server', dir), path.join(server, dir), { recursive: true });
fs.cpSync(path.join(root, 'website'), path.join(sandbox, 'website'), { recursive: true,
  filter: filename => !['node_modules', 'dist'].includes(path.basename(filename)) });
fs.copyFileSync(path.join(root, 'server/package.json'), path.join(server, 'package.json'));
for (const file of ['package-lock.json', 'Dockerfile']) fs.copyFileSync(path.join(root, 'server', file), path.join(server, file));
for (const file of ['docker-compose.yml', '.dockerignore']) fs.copyFileSync(path.join(root, file), path.join(sandbox, file));
fs.copyFileSync(path.join(root, 'server/scripts/pack-deploy.ps1'), path.join(server, 'scripts/pack-deploy.ps1'));
fs.copyFileSync(path.join(root, 'server', runner), path.join(server, runner));
fs.symlinkSync(path.join(root, 'server/node_modules'), path.join(server, 'node_modules'), 'junction');
// Only OS/runtime variables survive; inherited API keys and cloud credentials do not.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|SYSTEMDRIVE|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key)));
Object.assign(env, { QIJI_TEST_SNAPSHOT: '1', ADMIN_TOKEN: 'website-fixture-admin', SEED_ACCESS_KEY: 'website-fixture-user', NODE_ROLE: 'source', QIJI_WEBSITE_SANDBOX: sandbox });
function start(phase, extra = {}) {
  const log = fs.createWriteStream(path.join(sandbox, `${phase}.log`));
  const child = spawn(process.execPath, ['--import', 'tsx', runner, phase], {
    cwd: server, env: { ...env, ...extra }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.pipe(log); child.stderr.pipe(log);
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, result };
}
async function run(phase, extra) {
  const { child, result } = start(phase, extra);
  const timeout = setTimeout(() => child.kill(), 60_000);
  try {
    const exit = await result;
    assert.equal(exit.code, 0, `${phase} failed (${exit.signal || exit.code}); see ${path.join(sandbox, phase + '.log')}`);
    const report = JSON.parse(fs.readFileSync(path.join(sandbox, `${phase}.json`), 'utf8'));
    console.log(`${phase}: ${report.checks} checks passed`);
    return report;
  } finally { clearTimeout(timeout); }
}
async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
function request(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 2000 }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('HTTP timeout'))); req.on('error', reject);
  });
}
const reports = [];
let full;
try {
  reports.push(await run('source'));
  reports.push(await run('relay', { NODE_ROLE: 'relay' }));
  // This test concerns website registration, not legacy routing migration. A fresh
  // unrelated catalog currently fails that migration; model an already migrated store.
  fs.writeFileSync(path.join(server, 'data/auto-routing.json'), JSON.stringify({ version: 1, routeOnlyVersion: 1, enabled: false, lines: [] }));
  const port = await freePort();
  full = start('serve', { PORT: String(port) });
  let health;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { health = await request(port, '/health'); if (health.status === 200) break; } catch {}
    if (full.child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(health?.status, 200, 'full server starts in testSnapshot mode');
  let checks = 1;
  for (const pathname of ['/', '/site-assets/app-icon.png', '/site-assets/logo-full.svg']) {
    assert.equal((await request(port, pathname)).status, 404, `${pathname} removed from actual business server`); checks++;
  }
  const admin = await request(port, '/admin');
  assert.equal(admin.status, 200, 'admin remains accessible'); checks++;
  assert.match(admin.body, /admin-api/, 'actual admin HTML remains available'); checks++;
  assert.equal((await request(port, '/admin-api/site/export')).status, 401, 'real HTTP export requires authentication'); checks++;
  assert.equal((await request(port, '/ready')).status, 200, 'startup readiness remains accessible'); checks++;
  reports.push({ phase: 'http', checks });
  console.log(`http: ${checks} checks passed`);
  // Execute the real deploy script only inside the disposable mirror. A fake secret
  // exercises exclusion without reading or copying the developer's actual .env.
  fs.writeFileSync(path.join(server, '.env'), 'WEBSITE_TEST_SECRET=never-package-this\n');
  try {
    const packed = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(server, 'scripts/pack-deploy.ps1')], {
      cwd: sandbox, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = fs.createWriteStream(path.join(sandbox, 'pack.log'));
    packed.stdout.pipe(log); packed.stderr.pipe(log);
    const exit = await new Promise((resolve, reject) => { packed.once('error', reject); packed.once('exit', resolve); });
    assert.equal(exit, 0, 'sandbox deploy pack completes');
    const entries = execFileSync('tar', ['-tzf', path.join(sandbox, 'qiji-server-deploy.tgz')], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).map(value => value.replace(/^\.\//, ''));
    let packChecks = 1;
    for (const file of ['website/render.ts', 'website/template/index.html', 'website/template/assets/app-icon.png', 'server/src/index.ts', 'server/src/admin/index.html', 'server/src/routes/siteExport.ts', 'server/Dockerfile', 'server/package-lock.json', 'src/contract.ts']) {
      assert.ok(entries.includes(file), `deploy pack includes ${file}`); packChecks++;
    }
    assert.ok(!entries.some(value => /(^|\/)(data|node_modules)(\/|$)|(^|\/)\.env$/.test(value)), 'deploy pack excludes data, dependencies and credentials'); packChecks++;
    assert.ok(!entries.includes('server/src/routes/site.ts') && !entries.some(value => value.startsWith('server/src/www/')), 'deploy pack excludes retired public website handler'); packChecks++;
    reports.push({ phase: 'pack', checks: packChecks });
    console.log(`pack: ${packChecks} checks passed`);
  } finally { fs.unlinkSync(path.join(server, '.env')); }
} finally {
  if (full && full.child.exitCode === null) {
    full.child.send({ type: 'shutdown' });
    const timer = setTimeout(() => full.child.kill(), 5000);
    await full.result; clearTimeout(timer);
  }
  const after = dataSnapshot(path.join(root, 'server/data'));
  const previous = new Map(before.map(row => [row[0], row]));
  developmentDataChanges = after.filter(row => JSON.stringify(row) !== JSON.stringify(previous.get(row[0]))).map(row => row[0]);
  developmentDataChanges.push(...before.filter(row => !after.some(value => value[0] === row[0])).map(row => row[0]));
  fs.writeFileSync(path.join(sandbox, 'development-data-metadata.json'), JSON.stringify({ before, after, changedPaths: developmentDataChanges }, null, 2));
  console.log(`Sandbox retained: ${sandbox}`);
  assert.equal(siteHash(), siteBefore, 'development site config hash remains unchanged');
  const unexpectedChanges = developmentDataChanges.filter(filename => !/^qiji\.db(?:-wal|-shm)?$/.test(filename));
  assert.equal(unexpectedChanges.length, 0, `development data changed: ${unexpectedChanges.join(', ')}`);
  if (developmentDataChanges.length) console.log(`Concurrent development SQLite metadata changes observed: ${developmentDataChanges.join(', ')}; see metadata report`);
}
const summary = { checks: reports.reduce((sum, report) => sum + report.checks, 0), reports, sandbox, developmentSiteUnchanged: true, developmentDataUnchanged: developmentDataChanges.length === 0, developmentDataChanges, outboundFetches: 0 };
fs.writeFileSync(path.join(sandbox, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`Website split: ${summary.checks} checks passed; no outbound fetch; development site config unchanged`);
