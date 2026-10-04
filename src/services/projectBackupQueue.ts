import type { WebdavConfig } from "./webdavSync";

export interface ProjectBackupStatus {
  phase: "waiting" | "uploading" | "success" | "error";
  lastSuccessAt?: number;
  error?: string;
}
type Snapshot = { json: string; revision: number; generation: number; config: WebdavConfig };
type Job = {
  pending?: Snapshot;
  failed?: Snapshot;
  timer?: ReturnType<typeof setTimeout>;
  running: boolean;
  ready: boolean;
  revision: number;
  status?: ProjectBackupStatus;
};

/** Each project has its own debounce window and serial upload lane. */
export function createProjectBackupQueue(
  upload: (config: WebdavConfig, fileName: string, json: string) => Promise<void>,
  publish: (id: string, status: ProjectBackupStatus) => void,
) {
  const jobs = new Map<string, Job>();
  let config: WebdavConfig | null = null;
  let generation = 0;

  function status(id: string, job: Job, patch: ProjectBackupStatus) {
    job.status = { lastSuccessAt: job.status?.lastSuccessAt, ...patch };
    publish(id, job.status);
  }
  async function drain(id: string, job: Job): Promise<void> {
    if (job.running || !job.ready || !job.pending) return;
    const snapshot = job.pending;
    job.pending = undefined;
    job.ready = false;
    job.running = true;
    status(id, job, { phase: "uploading" });
    try {
      await upload(snapshot.config, `${id}.Qiji`, snapshot.json);
      if (snapshot.generation === generation) {
        status(id, job, { phase: job.pending ? "waiting" : "success", lastSuccessAt: Date.now() });
      }
    } catch (error) {
      if (snapshot.generation === generation && snapshot.revision === job.revision) {
        job.failed = snapshot;
        status(id, job, { phase: "error", error: error instanceof Error ? error.message : "云备份失败" });
      }
    } finally {
      job.running = false;
      void drain(id, job);
    }
  }
  function enqueue(id: string, json: string, immediate = false): void {
    if (!config) return;
    // Only generated, opaque ASCII identities may become remote object keys.
    if (!/^backup-[a-zA-Z0-9-]+$/.test(id)) throw new Error("无效项目备份标识");
    let job = jobs.get(id);
    if (!job) { job = { running: false, ready: false, revision: 0 }; jobs.set(id, job); }
    if (job.timer) clearTimeout(job.timer);
    job.failed = undefined;
    job.pending = { json, config: { ...config }, generation, revision: ++job.revision };
    job.ready = immediate;
    status(id, job, { phase: "waiting" });
    if (immediate) void drain(id, job);
    else {
      const target = job;
      job.timer = setTimeout(() => { target.timer = undefined; target.ready = true; void drain(id, target); }, 2000);
    }
  }
  return {
    configure(next: WebdavConfig | null) {
      config = next ? { ...next } : null;
      generation++;
      for (const [id, job] of jobs) {
        if (job.timer) clearTimeout(job.timer);
        job.timer = undefined;
        job.pending = job.failed = undefined;
        job.status = undefined;
        job.ready = false;
        // Keep the lane while an old PUT finishes, so a new PUT cannot overtake it.
        if (!job.running) jobs.delete(id);
      }
    },
    enqueue,
    retry(id: string) {
      const failed = jobs.get(id)?.failed;
      if (failed?.generation === generation) enqueue(id, failed.json, true);
    },
  };
}
