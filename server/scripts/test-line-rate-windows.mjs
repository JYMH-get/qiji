import assert from 'node:assert/strict';
import { aggregateLineRateWindows } from '../src/lineRateWindows.ts';

const now = Date.UTC(2026, 9, 8, 12), hour = 3_600_000;
const log = (hours, status = 'success', model = 'route:a', finishedAt) => ({
  model, startedAt: new Date(now - hours * hour).toISOString(), status,
  finishedAt: finishedAt ?? new Date(now).toISOString(),
});
let checks = 0;
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const counts = windows => windows.map(w => [w.hours, w.success, w.failed, w.running, w.successRate, w.insufficientSamples]);
const logs = [
  ...Array.from({ length: 9 }, () => log(.5)),
  log(2, 'failed'),
  ...Array.from({ length: 10 }, () => log(7, 'failed')),
  ...Array.from({ length: 10 }, () => log(20)),
  log(.2, 'running'), log(25), log(-1), log(1, 'success', 'route:unknown'), log(1, 'success', 'raw-model'),
];
let rows = aggregateLineRateWindows(logs, { a: { since: 0 }, empty: { since: 0 } }, now);
eq(counts(rows.get('a')), [[1,9,0,1,null,true],[5,9,1,1,.9,false],[10,9,11,1,.45,false],[24,19,11,1,19/30,false]], 'true per-request windows, in-flight excluded from denominator');
eq(rows.get('a').map(w => w.requests), [10,11,21,31], 'requests include in-flight but not outside each window');
eq(rows.get('empty').every(w => w.requests === 0 && w.successRate === null && w.insufficientSamples), true, 'empty lines cannot fabricate a rate');
rows = aggregateLineRateWindows(logs, { a: { since: now - hour } }, now);
eq(rows.get('a').map(w => w.successRate), [null,null,null,null], 'new line identity excludes old requests from every window');
rows = aggregateLineRateWindows(Array.from({length:10}, () => log(.2, 'failed')), {a:{since:0}}, now);
eq(rows.get('a').map(w => w.successRate), [0,0,0,0], 'zero percent is a valid sample');
rows = aggregateLineRateWindows(Array.from({length:10}, () => log(.2)), {a:{since:0}}, now);
eq(rows.get('a').map(w => w.successRate), [1,1,1,1], 'exactly ten completed requests reaches threshold');
rows = aggregateLineRateWindows([log(1),log(5),log(10),log(24),log(24.0001)], {a:{since:0}}, now);
eq(rows.get('a').map(w => w.success), [1,2,3,4], 'inclusive lower bounds and 24h cutoff');
rows = aggregateLineRateWindows([log(.5, 'success', 'route:a', new Date(now+1).toISOString()),log(.5,'queued'),{...log(.5),startedAt:'bad'}], {a:{since:0}}, now);
eq(rows.get('a').map(w => [w.success,w.running,w.requests]), [[0,1,1],[0,1,1],[0,1,1],[0,1,1]], 'future completion stays in-flight, invalid dates and unsupported statuses excluded');
console.log(`LINE_RATE_WINDOWS ${checks} checks passed`);
