export interface ProjectSaveRequest {
  instance: string;
  manual: boolean;
  history: boolean;
}

/** One writer and at most one follow-up; all callers wait for the drain, including checkpoints. */
export function createProjectSaveQueue() {
  let pending: ProjectSaveRequest | null = null;
  let running: Promise<void> | null = null;
  return {
    cancelPending() { pending = null; },
    enqueue(request: ProjectSaveRequest, save: (request: ProjectSaveRequest) => Promise<void>): Promise<void> {
      pending = pending?.instance === request.instance
        ? { ...request, manual: pending.manual || request.manual, history: pending.history || request.history }
        : request;
      if (running) return running;
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      running = completion;
      void (async () => {
        try {
          while (pending) {
            const next = pending;
            pending = null;
            await save(next);
          }
          running = null;
          resolve();
        } catch (error) {
          pending = null;
          running = null;
          reject(error);
        }
      })();
      return completion;
    },
  };
}
