import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

export interface RecoveryCandidate { logId: string; taskId?: string }
export function recoveryWorkers(count: number, requested = Number(process.env.QIJI_STARTUP_WORKERS ?? 4)): number {
  const limit = Number.isInteger(requested) && requested > 0 ? requested : 4;
  return Math.min(Math.ceil(count / 64), limit, availableParallelism(), 8);
}

/** Read only the frozen startup IDs, in bounded waves; never ship text to the parent. */
export async function* readRecoveryCandidates(database: string, ids: readonly string[], requested?: number): AsyncGenerator<RecoveryCandidate[]> {
  const count = recoveryWorkers(ids.length, requested);
  if (!count) return;
  for (let offset = 0; offset < ids.length; offset += count * 256) {
    const batchSize = Math.ceil(Math.min(ids.length - offset, count * 256) / count);
    const workers: Worker[] = [];
    try {
      const jobs = Array.from({length:count}, (_, i) => {
        const batch = ids.slice(offset + i * batchSize, Math.min(ids.length, offset + (i + 1) * batchSize));
        if (!batch.length) return Promise.resolve<RecoveryCandidate[]>([]);
        return new Promise<RecoveryCandidate[]>((resolve,reject) => {
          // Empty execArgv prevents inherited tsx/test preloads from starting stores.
          const worker = new Worker(new URL('./startupRecoveryWorker.mjs', import.meta.url), {
            execArgv: [], workerData:{database,ids:batch},
          });
          workers.push(worker);
          let result: RecoveryCandidate[] | undefined;
          const timer=setTimeout(() => { reject(new Error('启动恢复读取超时')); void worker.terminate(); },30_000);
          worker.once('message', message => { result=message; });
          worker.once('error', reject);
          worker.once('exit', code => {
            clearTimeout(timer);
            if (code !== 0 || !result) reject(new Error(`启动恢复工作线程退出 (${code})`));
            else resolve(result);
          });
        });
      });
      yield (await Promise.all(jobs)).flat();
    } finally { await Promise.all(workers.map(worker => worker.terminate())); }
  }
}
