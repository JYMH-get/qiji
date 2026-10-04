// Deliberately imports no application stores: workers can only read the ledger.
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(workerData.database, {readOnly:true});
try {
  db.exec('PRAGMA query_only=ON');
  db.exec('PRAGMA busy_timeout=5000');
  const query = db.prepare('SELECT data FROM text_billing WHERE log_id=?');
  const entries=[];
  for (const logId of workerData.ids) {
    const row=query.get(logId);
    if (!row) continue;
    const entry=JSON.parse(row.data);
    if (entry.result) entries.push({logId,taskId:entry.taskId});
  }
  parentPort.postMessage(entries);
} finally { db.close(); }
