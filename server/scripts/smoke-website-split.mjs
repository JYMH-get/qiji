import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const sandbox = process.env.QIJI_WEBSITE_SANDBOX;
assert.ok(sandbox && path.basename(sandbox).startsWith('qiji-website-split-'), 'sandbox required');
assert.equal(path.resolve(import.meta.dirname, '../..'), path.resolve(sandbox), 'never run against source tree');
assert.equal(fs.existsSync(path.join(sandbox, 'server/.env')), false, 'no copied credentials');
let outboundFetches = 0;
globalThis.fetch = async () => { outboundFetches++; throw new Error('Sandbox forbids outbound fetch'); };
const phase = process.argv[2];
if (phase === 'serve') {
  process.on('message', message => { if (message?.type === 'shutdown') process.emit('SIGTERM'); });
  await import('../src/index.ts');
} else {
  let checks = 0;
  const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
  const ok = (value, message) => { assert.ok(value, message); checks++; };
  const { default: Fastify } = await import('fastify');
  const { registerAdminRoutes } = await import('../src/routes/admin.ts');
  const { getSiteConfig, updateSiteConfig, SITE_IMAGE_SLOTS } = await import('../src/store/site.ts');
  const { flushPendingSaves, DATA_DIR } = await import('../src/store/db.ts');
  const { closeSqlite } = await import('../src/store/sqlite.ts');
  eq(path.resolve(DATA_DIR), path.join(sandbox, 'server/data'), 'all writes target sandbox');
  const app = Fastify({ logger: false });
  await app.register(registerAdminRoutes);
  await app.ready();
  const auth = { authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
  const call = (url, options = {}) => app.inject({ method: 'GET', url, headers: auth, ...options });
  try {
    for (const [method, url] of [['GET', '/admin-api/site'], ['PUT', '/admin-api/site'], ['GET', '/admin-api/site/preview'], ['GET', '/admin-api/site/export']]) {
      const base = { method, ...(method === 'PUT' ? { payload: {} } : {}) };
      eq((await call(url, { ...base, headers: {} })).statusCode, 401, `${method} ${url} rejects absent token`);
      eq((await call(url, { ...base, headers: { authorization: 'Bearer wrong' } })).statusCode, 401, `${method} ${url} rejects wrong token`);
      if (phase === 'relay') eq((await call(url, base)).statusCode, 403, `${method} ${url} source-only`);
    }
    if (phase === 'source') {
      const { default: JSZip } = await import('jszip');
      const { buildWebsiteFiles, renderWebsitePreview, builtinWebsiteImages } = await import('../../website/render.ts');
      const site = await call('/admin-api/site');
      eq(site.statusCode, 200, 'admin site config accessible');
      const payload = site.json();
      eq(payload.imageSlots.length, Object.keys(SITE_IMAGE_SLOTS).length, 'all image slots preserved');
      const builtins = await builtinWebsiteImages();
      for (const [slot, definition] of Object.entries(SITE_IMAGE_SLOTS)) {
        const entry = payload.imageSlots.find(entry => entry.slot === slot);
        ok(entry && /^data:image\//.test(entry.builtin), `admin built-in image ${slot} self-contained`);
        eq(entry.builtin, builtins[definition.file], `admin built-in ${slot} matches asset`);
      }
      const odd = '原样 $& $` $\' \\" </script><script>globalThis.WEBSITE_ATTACK=1</script> \u2028 \u2029';
      const fixture = {
        enabled: true, version: '9.9.9-fixture', sizeNote: odd, downloadUrl: 'https://downloads.example.invalid/Qiji.exe', backupUrl: '',
        contacts: { bd: odd, support: 'support@example.invalid', wechat: '', qq: '' }, icp: '沪ICP备12345678号-1',
        images: {}, showStats: false, showChannels: false,
        announcements: [{ id: 'published', title: '已发布 $&', body: odd, date: '2026-10-07', enabled: true },
          { id: 'draft', title: 'PRIVATE_DISABLED_TITLE', body: 'PRIVATE_DISABLED_BODY', date: '', enabled: false }],
        releases: [{ version: 'v9.9.9', date: '2026-10-07', title: odd, items: ['更新 $&', odd] }],
        _adminSecret: 'PRIVATE_TOP_LEVEL',
      };
      const put = await call('/admin-api/site', { method: 'PUT', payload: fixture });
      eq(put.statusCode, 200, 'existing save API succeeds');
      const saved = put.json().config;
      eq(saved.sizeNote, odd, 'save keeps special strings');
      eq(saved.announcements.length, 2, 'private draft remains in admin config');
      function inspectHtml(html, label) {
        const match = /\bvar SITE\s*=\s*([^\n]+);/.exec(html);
        ok(match, `${label} embeds static config`);
        const config = JSON.parse(match[1]);
        eq(config.sizeNote, odd, `${label} replacement metacharacters preserved`);
        eq(config.contacts.bd, odd, `${label} dangerous text round trips safely`);
        eq(config.announcements.map(item => item.id), ['published'], `${label} excludes disabled announcement`);
        ok(!html.includes('PRIVATE_DISABLED_') && !html.includes('PRIVATE_TOP_LEVEL'), `${label} private fields absent from bytes`);
        ok(!html.includes('</script><script>globalThis.WEBSITE_ATTACK'), `${label} script breakout escaped`);
        ok(!html.includes('"__SITE_CONFIG__"'), `${label} no unresolved config token`);
        ok(html.includes('https://beian.miit.gov.cn/'), `${label} official ICP link`);
        ok(!/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/.test(html), `${label} no runtime API requests`);
        ok(!/\/admin-api\/|\/v1\/|localhost:8787/.test(html), `${label} no business endpoint dependency`);
        for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(script[1]);
        checks++;
        return config;
      }
      const preview = await call('/admin-api/site/preview');
      eq(preview.statusCode, 200, 'authenticated preview succeeds');
      inspectHtml(preview.json().html, 'preview');
      ok(!/(["'])\/?site-assets\//.test(preview.json().html), 'preview contains no source-host image references');
      const exported = await call('/admin-api/site/export');
      eq(exported.statusCode, 200, 'authenticated export succeeds');
      ok(exported.headers['content-type'].includes('application/zip'), 'export ZIP content type');
      ok(/attachment/.test(exported.headers['content-disposition'] || ''), 'export downloads attachment');
      const zip = await JSZip.loadAsync(exported.rawPayload);
      const names = Object.values(zip.files).filter(entry => !entry.dir).map(entry => entry.name).sort();
      ok(names.includes('index.html'), 'ZIP contains homepage');
      ok(names.every(name => name === 'index.html' || /^site-assets\/[a-zA-Z0-9_.-]+$/.test(name)), 'ZIP contains only public static files');
      const html = await zip.file('index.html').async('string');
      inspectHtml(html, 'export');
      for (const filename of Object.keys(builtins)) {
        const entry = zip.file(`site-assets/${filename}`);
        ok(entry, `ZIP includes ${filename}`);
        const bytes = await entry.async('nodebuffer');
        eq(bytes.toString('base64'), builtins[filename].split(',')[1], `${filename} exported without corruption`);
      }
      // Mutating a server config must not change an already exported deployment snapshot.
      updateSiteConfig({ version: '10.0.0-later' });
      eq(JSON.parse(/\bvar SITE\s*=\s*([^\n]+);/.exec(html)[1]).version, fixture.version, 'export freezes saved configuration');
      const rawInput = { ...saved, _adminSecret: 'PRIVATE_TOP_LEVEL' };
      const files = await buildWebsiteFiles(rawInput);
      inspectHtml(files.find(file => file.path === 'index.html').data.toString('utf8'), 'direct build');
      const disabled = { ...rawInput, enabled: false };
      const maintenance = await renderWebsitePreview(disabled);
      ok(maintenance.includes('维护'), 'disabled config produces maintenance page');
      ok(maintenance.includes(fixture.icp) && maintenance.includes('https://beian.miit.gov.cn/'), 'maintenance preserves ICP number and official link');
      ok(!maintenance.includes('PRIVATE_DISABLED_'), 'maintenance excludes private announcements');
      updateSiteConfig({ enabled: false });
      const closedExport = await call('/admin-api/site/export');
      const closedZip = await JSZip.loadAsync(closedExport.rawPayload);
      ok((await closedZip.file('index.html').async('string')).includes('维护'), 'export respects disabled state');
      // Retain a clean, realistic fixture and export for browser QA, without test attack text.
      const qa = updateSiteConfig({ ...fixture, sizeNote: '约 320 MB · Windows 10 / 11 (64-bit)', contacts: { bd: '商务合作', support: 'support@example.invalid', wechat: 'qiji-demo', qq: '' },
        announcements: [{ id: 'qa', title: '官网独立部署测试', body: '这是隔离测试数据。', date: '2026-10-07', enabled: true }],
        releases: [{ version: 'v9.9.9', date: '2026-10-07', title: '独立官网', items: ['官网与业务服务独立部署'] }] });
      fs.writeFileSync(path.join(sandbox, 'preview.html'), await renderWebsitePreview(qa));
      for (const file of await buildWebsiteFiles(qa)) {
        const output = path.join(sandbox, 'static', file.path);
        fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, file.data);
      }
    }
    eq(outboundFetches, 0, 'no real upstream fetch attempted');
  } finally {
    await app.close(); await flushPendingSaves(); closeSqlite();
  }
  fs.writeFileSync(path.join(sandbox, `${phase}.json`), JSON.stringify({ phase, checks, outboundFetches }, null, 2));
  console.log(`${phase}: ${checks} checks passed`);
}
