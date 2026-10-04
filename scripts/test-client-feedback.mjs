import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = path.resolve(import.meta.dirname, '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qiji-client-feedback-'));
const fingerprints = () => Object.fromEntries(fs.readdirSync(path.join(root, 'server/data'), { withFileTypes:true })
  .filter(f => f.isFile()).map(f => [f.name, createHash('sha256').update(fs.readFileSync(path.join(root, 'server/data', f.name))).digest('hex')]));
const before = fingerprints();
fs.mkdirSync(path.join(sandbox, 'src'));
fs.mkdirSync(path.join(sandbox, 'server/scripts'), { recursive:true });
fs.copyFileSync(path.join(root, 'src/contract.ts'), path.join(sandbox, 'src/contract.ts'));
for (const dir of ['src', 'skills']) fs.cpSync(path.join(root, 'server', dir), path.join(sandbox, 'server', dir), { recursive:true });
fs.copyFileSync(path.join(root, 'server/package.json'), path.join(sandbox, 'server/package.json'));
fs.copyFileSync(path.join(root, 'server/scripts/smoke-client-feedback.mjs'), path.join(sandbox, 'server/scripts/smoke-client-feedback.mjs'));
fs.symlinkSync(path.join(root, 'server/node_modules'), path.join(sandbox, 'server/node_modules'), 'junction');
const reportDir = path.join(root, 'outputs/client-feedback-20260929');
fs.mkdirSync(reportDir, { recursive:true });
fs.writeFileSync(path.join(reportDir, 'sandbox.txt'), sandbox);
try {
  const output = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/smoke-client-feedback.mjs'], {
    cwd:path.join(sandbox, 'server'), encoding:'utf8', env:{ ...process.env, QIJI_TEST_SNAPSHOT:'1', ADMIN_TOKEN:'admin-dev' },
  });
  fs.writeFileSync(path.join(reportDir, 'smoke.txt'), output); console.log(output);
  for(let i=0;i<2;i++) console.log(execFileSync(process.execPath,['--import','tsx','scripts/smoke-client-feedback.mjs','restart'],{cwd:path.join(sandbox,'server'),encoding:'utf8',env:{...process.env,QIJI_TEST_SNAPSHOT:'1',ADMIN_TOKEN:'admin-dev'}}));
} finally {
  const after = fingerprints();
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => before[k] !== after[k]);
  fs.writeFileSync(path.join(reportDir, 'data-check.json'), JSON.stringify({ files:Object.keys(before).length, changed }, null, 2));
  console.log('Real data files changed:', changed.length);
  if (changed.length) throw Error('Real data changed during verification: ' + changed.join(', '));
}
