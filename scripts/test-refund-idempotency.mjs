import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qiji-refund-idempotency-'));
for (const [name, phases] of [['async', ['async-prepare', 'async-resume']], ['orphan', ['orphan-prepare', 'orphan-crash', 'orphan-resume']],
  ['reuse-new', ['reuse-new-prepare', 'reuse-new-resume']], ['reuse-legacy', ['reuse-legacy-prepare', 'reuse-legacy-resume']], ['edges', ['edges']]]) {
  const sandbox = path.join(base, name);
  fs.mkdirSync(path.join(sandbox, 'src'), { recursive: true });
  fs.copyFileSync(path.join(root, 'src/contract.ts'), path.join(sandbox, 'src/contract.ts'));
  for (const dir of ['src', 'skills']) fs.cpSync(path.join(root, 'server', dir), path.join(sandbox, 'server', dir), { recursive: true });
  fs.copyFileSync(path.join(root, 'server/package.json'), path.join(sandbox, 'server/package.json'));
  fs.symlinkSync(path.join(root, 'server/node_modules'), path.join(sandbox, 'server/node_modules'), 'junction');
  fs.mkdirSync(path.join(sandbox, 'server/scripts'));
  fs.copyFileSync(path.join(root, 'server/scripts/smoke-refund-idempotency.mjs'), path.join(sandbox, 'server/scripts/smoke-refund-idempotency.mjs'));
  for (const phase of phases) execFileSync(process.execPath, ['--import', 'tsx', 'scripts/smoke-refund-idempotency.mjs', phase], {
    cwd: path.join(sandbox, 'server'), stdio: 'inherit', env: { ...process.env, QIJI_TEST_SNAPSHOT: '1', ADMIN_TOKEN: 'admin-dev' },
  });
}
console.log('Refund sandbox:', base);
