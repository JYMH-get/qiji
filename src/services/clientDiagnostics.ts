/** Best-effort diagnostics written by the native process, outside WebView memory. */
export type ClientDiagnosticKind =
  | "save_start" | "save_stage" | "save_serialized" | "save_success" | "save_failed"
  | "frontend_error" | "context";
export type ClientDiagnosticErrorClass =
  | "range_error" | "type_error" | "syntax_error" | "reference_error"
  | "abort_error" | "quota_exceeded" | "io_error" | "unknown";

export interface ClientDiagnosticEvent {
  kind: ClientDiagnosticKind;
  stage?: "snapshot" | "normalize" | "serialize" | "write" | "finish";
  source?: "autosave" | "manual" | "checkpoint" | "switch" | "unknown";
  mode?: "canvas" | "table" | "rtc" | "other";
  errorClass?: ClientDiagnosticErrorClass;
  saveId?: number;
  durationMs?: number;
  serializeMs?: number;
  writeMs?: number;
  bytes?: number;
  jsonChars?: number;
  nodeCount?: number;
  edgeCount?: number;
  historyCount?: number;
  pastCount?: number;
  futureCount?: number;
  heapUsedBytes?: number;
  heapTotalBytes?: number;
  heapLimitBytes?: number;
}

const RECORD_TIMEOUT_MS = 250;
const FAILURE_COOLDOWN_MS = 30_000;
const RATE_WINDOW_MS = 10_000;
const MAX_RECORDS_PER_WINDOW = 80;
const MAX_PENDING_RECORDS = 4;
const enumFields = {
  kind: ["save_start", "save_stage", "save_serialized", "save_success", "save_failed", "frontend_error", "context"],
  stage: ["snapshot", "normalize", "serialize", "write", "finish"],
  source: ["autosave", "manual", "checkpoint", "switch", "unknown"],
  mode: ["canvas", "table", "rtc", "other"],
  errorClass: ["range_error", "type_error", "syntax_error", "reference_error", "abort_error", "quota_exceeded", "io_error", "unknown"],
} as const;
const numberFields = [
  "saveId", "durationMs", "serializeMs", "writeMs", "bytes", "jsonChars", "nodeCount",
  "edgeCount", "historyCount", "pastCount", "futureCount", "heapUsedBytes", "heapTotalBytes", "heapLimitBytes",
] as const;
const metricLimits: Record<(typeof numberFields)[number], number> = {
  saveId: Number.MAX_SAFE_INTEGER,
  durationMs: 86_400_000,
  serializeMs: 86_400_000,
  writeMs: 86_400_000,
  bytes: 1_099_511_627_776,
  jsonChars: 1_099_511_627_776,
  nodeCount: 10_000_000,
  edgeCount: 10_000_000,
  historyCount: 10_000_000,
  pastCount: 10_000_000,
  futureCount: 10_000_000,
  heapUsedBytes: 1_099_511_627_776,
  heapTotalBytes: 1_099_511_627_776,
  heapLimitBytes: 1_099_511_627_776,
};

let cooldownUntil = 0;
let rateWindowStart = 0;
let rateCount = 0;
let pendingRecords = 0;
let errorWindowStart = 0;
let errorCount = 0;
let nativeCore: Promise<typeof import("@tauri-apps/api/core")> | null = null;

function loadNativeCore() {
  return nativeCore ??= import("@tauri-apps/api/core").catch((error) => {
    nativeCore = null;
    throw error;
  });
}

export function canExportClientDiagnostics(): boolean {
  return typeof window !== "undefined"
    && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/** Rebuild the payload so project paths, content, URLs and arbitrary errors cannot leak. */
function sanitizeEvent(event: ClientDiagnosticEvent): ClientDiagnosticEvent | null {
  if (!enumFields.kind.includes(event.kind)) return null;
  const result: Record<string, string | number> = { kind: event.kind };
  for (const key of Object.keys(enumFields) as (keyof typeof enumFields)[]) {
    const value = event[key];
    if (typeof value === "string" && (enumFields[key] as readonly string[]).includes(value)) {
      result[key] = value;
    }
  }
  for (const key of numberFields) {
    const value = event[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= metricLimits[key]) {
      result[key] = Math.round(value);
    }
  }
  return result as unknown as ClientDiagnosticEvent;
}

/**
 * Await before expensive save work to leave a breadcrumb even if WebView crashes there.
 * Logging failure never rejects or indefinitely delays saving. Timed-out IPC stays counted
 * until it settles, preventing a stalled native bridge from accumulating a hidden queue.
 */
export async function recordClientDiagnostic(event: ClientDiagnosticEvent): Promise<void> {
  if (!canExportClientDiagnostics()) return;
  try {
    const now = Date.now();
    if (now < cooldownUntil || pendingRecords >= MAX_PENDING_RECORDS) return;
    // A noisy component must not consume the budget needed for save breadcrumbs.
    if (event.kind === "frontend_error") {
      if (now - errorWindowStart >= RATE_WINDOW_MS) {
        errorWindowStart = now;
        errorCount = 0;
      }
      if (errorCount >= 10) return;
      errorCount += 1;
    }
    if (now - rateWindowStart >= RATE_WINDOW_MS) {
      rateWindowStart = now;
      rateCount = 0;
    }
    if (rateCount >= MAX_RECORDS_PER_WINDOW) return;
    const safeEvent = sanitizeEvent(event.kind.startsWith("save_") ? { ...event, ...heapMetrics() } : event);
    if (!safeEvent) return;
    rateCount += 1;
    pendingRecords += 1;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
        resolve();
      }, RECORD_TIMEOUT_MS);
      void loadNativeCore()
        .then(({ invoke }) => invoke("record_client_diagnostic", { event: safeEvent }))
        .catch(() => { cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS; })
        .finally(() => {
          pendingRecords -= 1;
          clearTimeout(timer);
          resolve();
        });
    });
  } catch {
    // Diagnostics must not become another failure path for the user's project save.
  }
}

/** Classify by standard exception name only; do not read error message, stack or cause. */
export function classifyClientDiagnosticError(error: unknown): ClientDiagnosticErrorClass {
  try {
    if (!error || typeof error !== "object") return "unknown";
    switch ((error as { name?: unknown }).name) {
      case "RangeError": return "range_error";
      case "TypeError": return "type_error";
      case "SyntaxError": return "syntax_error";
      case "ReferenceError": return "reference_error";
      case "AbortError": return "abort_error";
      case "QuotaExceededError": return "quota_exceeded";
      default: return "unknown";
    }
  } catch {
    return "unknown";
  }
}

function currentMode(): ClientDiagnosticEvent["mode"] {
  const pathname = window.location.pathname;
  if (pathname === "/frame-canvas") return "canvas";
  if (pathname === "/frame-editor") return "rtc";
  if (["/frame1693", "/frame16285", "/frame-group", "/frame16550", "/frame16780", "/frame161000", "/frame161195"].includes(pathname)) return "table";
  return "other";
}

function heapMetrics(): Pick<ClientDiagnosticEvent, "heapUsedBytes" | "heapTotalBytes" | "heapLimitBytes"> {
  try {
    const memory = (window.performance as Performance & {
      memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number };
    }).memory;
    return {
      heapUsedBytes: memory?.usedJSHeapSize,
      heapTotalBytes: memory?.totalJSHeapSize,
      heapLimitBytes: memory?.jsHeapSizeLimit,
    };
  } catch {
    return {};
  }
}

export function recordClientError(error: unknown): Promise<void> {
  return recordClientDiagnostic({
    kind: "frontend_error",
    errorClass: classifyClientDiagnosticError(error),
    ...(typeof window === "undefined" ? {} : { mode: currentMode(), ...heapMetrics() }),
  });
}

let stopDiagnostics: (() => void) | null = null;

/** Install once per WebView, including login and pop-out windows; safe under StrictMode. */
export function startClientDiagnostics(): () => void {
  if (!canExportClientDiagnostics()) return () => {};
  if (stopDiagnostics) return stopDiagnostics;
  const onError = (event: ErrorEvent) => { void recordClientError(event.error); };
  const onRejection = (event: PromiseRejectionEvent) => { void recordClientError(event.reason); };
  const sample = () => { void recordClientDiagnostic({ kind: "context", mode: currentMode(), ...heapMetrics() }); };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  const timer = setInterval(sample, 30_000);
  sample();
  const stop = () => {
    clearInterval(timer);
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    if (stopDiagnostics === stop) stopDiagnostics = null;
  };
  stopDiagnostics = stop;
  return stop;
}

let exportInFlight: Promise<string | null> | null = null;

/** Native code streams the ZIP directly to disk; no crash dump is copied into JS memory. */
export function exportClientDiagnostics(): Promise<string | null> {
  if (exportInFlight) return exportInFlight;
  const exportPackage = async () => {
    if (!canExportClientDiagnostics()) throw new Error("诊断包仅支持桌面客户端");
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      title: "导出诊断包",
      defaultPath: `Qiji-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`,
      filters: [{ name: "诊断包", extensions: ["zip"] }],
    });
    if (!path) return null;
    const { invoke } = await loadNativeCore();
    return invoke<string>("export_client_diagnostics", { path });
  };
  exportInFlight = exportPackage().finally(() => { exportInFlight = null; });
  return exportInFlight;
}
