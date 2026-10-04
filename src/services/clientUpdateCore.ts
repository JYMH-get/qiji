export type UpdatePhase = "idle" | "checking" | "downloading" | "ready" | "installing" | "error";
export interface ClientUpdateState {
  phase: UpdatePhase;
  version: string;
  notes: string;
  downloaded: number;
  total?: number;
  message: string;
  visible: boolean;
}
export const INITIAL_UPDATE_STATE: ClientUpdateState = {
  phase: "idle", version: "", notes: "", downloaded: 0, message: "", visible: false,
};
export interface UpdateDownloadEvent {
  event: "Started" | "Progress" | "Finished";
  data?: { contentLength?: number; chunkLength?: number };
}
export interface PendingUpdate {
  version: string;
  body?: string;
  download: (onEvent: (event: UpdateDownloadEvent) => void) => Promise<void>;
  install: () => Promise<void>;
  close: () => Promise<void>;
}
export interface UpdatePorts {
  check: () => Promise<PendingUpdate | null>;
  prepare: () => Promise<void>;
  relaunch: () => Promise<void>;
  release?: () => Promise<void>;
}

/** 下载与安装分开：无论后台检查还是手动检查，安装只能从用户按钮进入。 */
export class ClientUpdateController {
  private pending: PendingUpdate | null = null;
  private busy = false;
  state = { ...INITIAL_UPDATE_STATE };
  constructor(private ports: UpdatePorts, private notify: (state: ClientUpdateState) => void) {}
  private patch(patch: Partial<ClientUpdateState>) {
    this.state = { ...this.state, ...patch };
    this.notify(this.state);
  }
  show() { this.patch({ visible: true }); }
  dismiss() { if (this.state.phase !== "installing") this.patch({ visible: false }); }
  async check(manual = false) {
    if (manual) this.show();
    if (this.busy || this.pending) return;
    this.busy = true;
    this.patch({ phase: "checking", message: "正在检查更新…" });
    let candidate: PendingUpdate | null = null;
    try {
      candidate = await this.ports.check();
      if (!candidate) {
        this.patch({ phase: "idle", message: "当前已是最新版本" });
        return;
      }
      this.patch({ phase: "downloading", version: candidate.version, notes: candidate.body || "",
        downloaded: 0, total: undefined, message: "正在后台下载更新…" });
      await candidate.download((e) => {
        if (e.event === "Started") this.patch({ total: e.data?.contentLength });
        if (e.event === "Progress") this.patch({ downloaded: this.state.downloaded + (e.data?.chunkLength || 0) });
      });
      this.pending = candidate;
      this.patch({ phase: "ready", visible: true, message: "更新已下载，可保存项目并重启安装" });
    } catch {
      await candidate?.close().catch(() => {});
      this.patch({ phase: "error", message: "更新检查或下载失败，请检查网络后重试" });
    } finally { this.busy = false; }
  }
  async install() {
    if (this.busy || !this.pending || this.state.phase !== "ready") return;
    this.busy = true;
    this.patch({ phase: "installing", visible: true, message: "正在保存项目并准备安装…" });
    let installStarted = false;
    try {
      await this.ports.prepare();
      installStarted = true;
      await this.pending.install(); // Windows installer terminates the process and restarts Qiji.
      await this.ports.relaunch(); // Other desktop platforms need explicit relaunch.
    } catch (e) {
      await this.ports.release?.().catch(() => {});
      if (installStarted) {
        await this.pending.close().catch(() => {});
        this.pending = null;
      }
      this.patch({ phase: installStarted ? "error" : "ready", message: installStarted
        ? "安装未完成，请重试更新" : (e instanceof Error ? e.message : "项目尚未保存，请稍后重试") });
    } finally { this.busy = false; }
  }
}
