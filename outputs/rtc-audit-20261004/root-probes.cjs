// Read-only audit probes. Actual source is compiled in memory; storage and network are mocked.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
function load(relative, mocks = {}) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  const code = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
  const exports = {};
  new Function('require', 'exports', code)((id) => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    throw new Error(`Unexpected dependency: ${id}`);
  }, exports);
  return exports;
}
async function main() {
  const events = [];
  let project = 'A';
  let releaseBytes;
  const bytes = new Promise((resolve) => { releaseBytes = resolve; });
  const projectStore = {getState: () => ({
    projectInstanceId: project,
    assetBlobs: {},
    registerAssetBlob: (blob) => events.push({action: 'registerAssetBlob', project, id: blob.id}),
  })};
  const upload = load('src/canvas/nodeUpload.ts', {
    '@/services/fileStorage': {}, '@/store/libraryStore': {}, '@/store/canvasStore': {},
    '@/store/projectStore': {useProjectStore: projectStore},
    '@/services/assetPersist': {saveUploadedLocal: async (file, id, url, name, options) => {
      events.push({action: 'saveUploadedLocal', project, hasOwnerGuard: !!options?.shouldContinue});
      return {id, localUri: `asset:///${project}/clip.mp4`, localPath: `${project}/clip.mp4`};
    }},
  });
  const pending = upload.uploadMediaToCanvasAsset({name: 'clip.mp4', type: 'video/mp4', arrayBuffer: () => bytes});
  project = 'B';
  releaseBytes(new Uint8Array([1, 2, 3]).buffer);
  const result = await pending;
  if (!events.some((e) => e.action === 'registerAssetBlob' && e.project === 'B')) throw new Error('Cross-project issue not reproduced');
  const core = load('src/lib/projectSyncCore.ts');
  const initial = {rtcDocs: {ep1: {name: 'original-1'}, ep2: {name: 'original-2'}}};
  const localA = {rtcDocs: {...initial.rtcDocs, ep1: {name: 'edited-1'}}};
  const localB = {rtcDocs: {...initial.rtcDocs, ep2: {name: 'edited-2'}}};
  const keysA = core.diffByRef(initial, localA, core.SHARED_PROJECT_FIELDS);
  const keysB = core.diffByRef(initial, localB, core.SHARED_PROJECT_FIELDS);
  const packetA = Object.fromEntries(keysA.map((key) => [key, localA[key]]));
  const packetB = Object.fromEntries(keysB.map((key) => [key, localB[key]]));
  // projectSync.ts fields applies a top-level setState patch; this simulates that documented merge.
  const writerAfterPackets = {...initial, ...packetA, ...packetB};
  if (writerAfterPackets.rtcDocs.ep1.name !== 'original-1') throw new Error('Whole-map overwrite not reproduced');
  const genParams = load('src/lib/genParams.ts');
  const videoMethods = load('src/lib/videoMethods.ts', {'./genParams': genParams});
  const advertisedDurations = [10, 15, 20];
  const durationSent = videoMethods.clampDurationTo(genParams.clampDuration(20), advertisedDurations);
  if (durationSent !== 15) throw new Error('Explicit duration rewrite not reproduced');
  const output = {
    note: 'Zero network, zero real project writes. Import uses actual nodeUpload.ts with mocked persistence. Sync uses actual diffByRef and a model of the fields shallow merge; this is not a real two-window acceptance test.',
    importDuringProjectSwitch: {startedIn: 'A', switchedTo: 'B', events, result},
    separateEpisodeConcurrentEdits: {keysA, keysB, expected: ['edited-1', 'edited-2'], actual: Object.values(writerAfterPackets.rtcDocs).map((d) => d.name)},
    explicitDuration: {advertisedDurations, userSelected: 20, durationSent, caller: 'RtcShotAiWorkbench.tsx:313 and shotGenActions.ts:197'},
  };
  fs.writeFileSync(path.join(__dirname, 'root-probe-results.json'), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
}
main().catch((error) => {console.error(error); process.exitCode = 1;});
