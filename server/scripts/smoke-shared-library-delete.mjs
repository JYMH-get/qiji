import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';

// Run from a copied server tree: stores resolve their data directory from source paths.
const sandboxRoot = realpathSync.native(resolve(fileURLToPath(new URL('../../', import.meta.url))));
assert.ok(sandboxRoot.startsWith(realpathSync.native(tmpdir()) + sep) && /qiji-shared-delete-[^\\/]+$/.test(sandboxRoot), 'Sandbox copy required');
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('No external network in shared deletion tests'); };

const users = await import('../src/store/users.ts');
const teams = await import('../src/store/teams.ts');
const shared = await import('../src/store/sharedLibs.ts');
const assets = await import('../src/store/assets.ts');
const { default: Fastify } = await import('fastify');
const app = Fastify();
await app.register((await import('../src/routes.ts')).registerRoutes);
await app.ready();
const modelStats = await import('../src/channelAvailability.ts');
const lineStats = await import('../src/lineAvailability.ts');
modelStats.stopChannelAvailabilityBackground();
lineStats.stopLineAvailabilityBackground();

let checks = 0;
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const headers = user => ({ authorization: 'Bearer ' + user.accessKey, 'x-device-id': 'shared-delete-fixture' });
const request = (user, method, url, payload) => app.inject({ method, url, headers: user ? headers(user) : {}, ...(payload === undefined ? {} : { payload }) });
const deleteFolder = (user, id) => request(user, 'DELETE', '/v1/team/lib/folders/' + id);
const deleteAsset = (user, id) => request(user, 'DELETE', '/v1/team/lib/assets/' + id);
const newUser = name => users.createUser({ name, credits: 100 });
async function newTeam(leader, name) {
  const response = await request(leader, 'POST', '/v1/team', { code: teams.createTeamCodes(1)[0].code, name });
  eq(response.statusCode, 200, 'team created with linked library');
  const team = teams.getTeam(response.json().team.id);
  eq(shared.isMember(team.sharedLibId, leader.id), true, 'leader joined own library');
  return team;
}
async function addMember(team, member) {
  eq(teams.inviteToTeam(team.id, member.id).ok, true, 'member invited');
  eq((await request(member, 'POST', '/v1/team/invites/accept', { teamId: team.id })).statusCode, 200, 'member accepts invitation');
}
async function newFolder(user, libraryId, name) {
  const response = await request(user, 'POST', `/v1/shared/libraries/${libraryId}/folders`, { name });
  eq(response.statusCode, 200, 'member creates folder');
  return response.json().folder;
}
async function addAsset(user, folder, name) {
  const response = await request(user, 'POST', `/v1/shared/folders/${folder.id}/assets`, { items: [{ url: `https://fixture.invalid/${name}.png`, name, mime: 'image/png' }] });
  eq(response.statusCode, 200, 'member shares material');
  return shared.listFolderAssets(folder.id).find(asset => asset.name === name);
}

try {
  const leader = newUser('团长甲'), member = newUser('团员甲'), outsider = newUser('非团队用户'), otherLeader = newUser('团长乙');
  const team = await newTeam(leader, '共享删除甲团'), otherTeam = await newTeam(otherLeader, '共享删除乙团');
  await addMember(team, member);
  const folder = await newFolder(member, team.sharedLibId, '团员建的文件夹');
  const first = await addAsset(member, folder, 'first'), second = await addAsset(member, folder, 'second');
  const siblingFolder = await newFolder(member, team.sharedLibId, '保留文件夹');
  const sibling = await addAsset(member, siblingFolder, 'sibling');
  const otherFolder = await newFolder(otherLeader, otherTeam.sharedLibId, '乙团文件夹');
  const otherAsset = await addAsset(otherLeader, otherFolder, 'other');

  for (const [user, label] of [[member, 'ordinary member'], [outsider, 'non-member'], [otherLeader, 'other team leader']]) {
    eq((await deleteAsset(user, first.id)).statusCode, 404, `${label} cannot delete shared asset`);
    eq((await deleteFolder(user, folder.id)).statusCode, 404, `${label} cannot delete shared folder`);
  }
  // Library membership is deliberately global; joining another team library grants no delete authority.
  shared.joinLibrary(team.sharedLibId, otherLeader.id);
  eq((await deleteAsset(otherLeader, first.id)).statusCode, 404, 'joined outsider leader cannot delete shared asset');
  eq((await deleteFolder(otherLeader, folder.id)).statusCode, 404, 'joined outsider leader cannot delete shared folder');
  eq(shared.listFolderAssets(folder.id).map(asset => asset.id), [first.id, second.id], 'denied deletions preserve all target materials');
  eq((await deleteAsset(null, first.id)).statusCode, 401, 'anonymous material deletion rejected');
  eq((await deleteFolder(null, folder.id)).statusCode, 401, 'anonymous folder deletion rejected');

  const platform = shared.createLibrary({ name: '平台共享库', password: 'fixture-pass', ownerAudience: 'platform' }).library;
  shared.joinLibrary(platform.id, leader.id);
  const platformFolder = await newFolder(leader, platform.id, '平台文件夹');
  const platformAsset = await addAsset(leader, platformFolder, 'platform');
  eq((await deleteAsset(leader, platformAsset.id)).statusCode, 404, 'team leader cannot delete platform library material');
  eq((await deleteFolder(leader, platformFolder.id)).statusCode, 404, 'team leader cannot delete platform library folder');

  let response = await deleteAsset(leader, first.id);
  eq(response.statusCode, 200, 'own leader can delete member material');
  eq(response.json(), { ok: true }, 'material deletion response');
  eq(shared.listFolderAssets(folder.id).map(asset => asset.id), [second.id], 'single deletion preserves sibling material');
  eq((await deleteAsset(leader, first.id)).statusCode, 404, 'repeated material deletion reports missing target');

  // Shared deletion must preserve the original asset and its bytes in the asset ledger.
  const originalBytes = Buffer.from('fixture original image');
  const original = await assets.createAsset(originalBytes, 'image/png', 'image', { saveToOss: false });
  eq(shared.addFolderAssets(shared.getFolder(folder.id), [{ assetId: original.id, url: 'https://fixture.invalid/original.png', name: 'original' }], member.name).ok, true, 'register ledger-backed shared material');
  response = await deleteFolder(leader, folder.id);
  eq(response.statusCode, 200, 'own leader can delete member folder');
  eq(response.json(), { ok: true }, 'folder deletion response');
  eq(shared.getFolder(folder.id), undefined, 'folder removed');
  eq(shared.listFolderAssets(folder.id), [], 'folder materials removed together');
  eq(assets.getAsset(original.id), original, 'original asset ledger retained');
  eq(assets.getAssetBytes(original.id), originalBytes, 'original material bytes retained');
  eq(shared.getAssetRec(sibling.id)?.id, sibling.id, 'other folder material retained');
  eq(shared.getAssetRec(otherAsset.id)?.id, otherAsset.id, 'other team material retained');
  eq(shared.getAssetRec(platformAsset.id)?.id, platformAsset.id, 'platform material retained');
  eq((await deleteFolder(leader, folder.id)).statusCode, 404, 'repeated folder deletion reports missing target');

  eq((await request(member, 'POST', '/v1/team/leave')).statusCode, 200, 'member can leave');
  eq(shared.isMember(team.sharedLibId, member.id), false, 'leave revokes library membership');
  eq((await request(member, 'GET', `/v1/shared/folders/${siblingFolder.id}/assets`)).statusCode, 404, 'former member cannot browse team library');
  eq((await deleteAsset(member, sibling.id)).statusCode, 404, 'former member cannot delete shared asset');
  await addMember(team, member);
  eq((await request(leader, 'DELETE', `/v1/team/members/${member.id}`)).statusCode, 200, 'leader can remove member');
  eq(shared.isMember(team.sharedLibId, member.id), false, 'removal revokes library membership');
  eq((await deleteFolder(member, siblingFolder.id)).statusCode, 404, 'removed member cannot delete shared folder');

  eq((await request(leader, 'POST', '/v1/team/dissolve')).statusCode, 200, 'leader dissolves team');
  eq(shared.getLibrary(team.sharedLibId), undefined, 'dissolve removes team library');
  eq(shared.getFolder(siblingFolder.id), undefined, 'dissolve removes team folders');
  eq(shared.getAssetRec(sibling.id), undefined, 'dissolve removes shared materials');
  eq((await deleteAsset(leader, sibling.id)).statusCode, 404, 'former leader cannot delete after dissolution');
  eq((await deleteFolder(leader, otherFolder.id)).statusCode, 404, 'former leader cannot target other team');
  eq(networkCalls, 0, 'no upstream or object storage network calls');
  console.log(`SHARED_LIBRARY_DELETE ${checks} checks passed`);
} finally {
  await app.close();
  modelStats.stopChannelAvailabilityBackground();
  lineStats.stopLineAvailabilityBackground();
  (await import('../src/store/db.ts')).flushPendingSaves();
  (await import('../src/store/sqlite.ts')).closeSqlite();
}
