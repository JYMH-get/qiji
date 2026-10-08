import type { RecentProject } from "@/store/projectStore";

const HEADER_BYTES = 64 * 1024;

/** Windows project identity; the displayed path keeps its original casing. */
export function projectPathKey(path: string): string {
  const slashes = path.replace(/\\/g, "/");
  const normalized = slashes.replace(/\/+/g, "/").replace(/\/+$/, "");
  return (slashes.startsWith("//") ? `/${normalized}` : normalized).toLowerCase();
}

function childPath(parent: string, name: string): string {
  return `${parent.replace(/[\\/]+$/, "")}/${name}`;
}

function stringEnd(text: string, start: number): number {
  if (text[start] !== '"') return -1;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i + 1;
  }
  return -1;
}

/** Find a whole top-level value without ever treating nested keys as header fields. */
function valueEnd(text: string, start: number): number {
  if (text[start] === '"') return stringEnd(text, start);
  const stack: string[] = [];
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      const end = stringEnd(text, i);
      if (end < 0) return -1;
      i = end - 1;
    } else if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
    } else if (char === "}" || char === "]") {
      if (!stack.length) return char === "}" ? i : -1;
      if (stack.pop() !== char) return -1;
      if (!stack.length) return i + 1;
    } else if (char === "," && !stack.length) {
      return i;
    }
  }
  return -1;
}

function readHeader(text: string): { name?: string; savedAt?: string } {
  const header: { name?: string; savedAt?: string } = {};
  let cursor = 0;
  const whitespace = () => { while (/\s/.test(text[cursor] ?? "") && cursor < text.length) cursor++; };
  whitespace();
  if (text[cursor++] !== "{") return header;
  try {
    while (cursor < text.length) {
      whitespace();
      const keyEnd = stringEnd(text, cursor);
      if (keyEnd < 0) break;
      const key: unknown = JSON.parse(text.slice(cursor, keyEnd));
      cursor = keyEnd;
      whitespace();
      if (text[cursor++] !== ":") break;
      whitespace();
      const end = valueEnd(text, cursor);
      if (end < 0) break;
      const value: unknown = JSON.parse(text.slice(cursor, end));
      if ((key === "name" || key === "savedAt") && typeof value === "string") header[key] = value;
      cursor = end;
      whitespace();
      if (header.name !== undefined && header.savedAt !== undefined) break;
      if (text[cursor++] !== ",") break;
    }
  } catch { /* A damaged/truncated header still permits a filename-based entry. */ }
  return header;
}

function fallbackName(path: string, nested: boolean): string {
  const parts = path.replace(/\\/g, "/").split("/");
  const fileName = (parts.pop() ?? "").replace(/\.qiji$/i, "");
  const directoryName = (parts.pop() ?? "").replace(/_\d{8}_\d{6}$/, "");
  return (nested ? directoryName : fileName) || fileName || "未命名项目";
}

function timestamp(value: string | Date | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/** Scan only project roots and one child directory level, never project asset trees. */
export async function discoverLocalProjects(roots: string[], knownPaths: string[]): Promise<RecentProject[]> {
  const fs = await import("@tauri-apps/plugin-fs");
  const seen = new Set(knownPaths.map(projectPathKey));
  const visited = new Set<string>();
  const projects: RecentProject[] = [];

  async function addFile(path: string, nested: boolean): Promise<void> {
    const key = projectPathKey(path);
    if (seen.has(key)) return;
    seen.add(key);
    try {
      const info = await fs.lstat(path);
      if (info.isSymlink || !info.isFile) return;
      let header: ReturnType<typeof readHeader> = {};
      try {
        const file = await fs.open(path, { read: true });
        try {
          const bytes = new Uint8Array(HEADER_BYTES);
          let length = 0;
          while (length < bytes.length) {
            const count = await file.read(bytes.subarray(length));
            if (count === null || count <= 0) break;
            length += count;
          }
          header = readHeader(new TextDecoder().decode(bytes.subarray(0, length)));
        } finally {
          await file.close();
        }
      } catch { /* Unreadable files remain discoverable, with safe fallback metadata. */ }
      projects.push({
        path,
        name: header.name?.trim() || fallbackName(path, nested),
        openedAt: timestamp(header.savedAt) ?? timestamp(info.mtime) ?? new Date(0).toISOString(),
      });
    } catch { /* A removed/inaccessible file must not prevent finding its siblings. */ }
  }

  async function scan(directory: string, nested: boolean): Promise<void> {
    const key = projectPathKey(directory);
    if (visited.has(key)) return;
    visited.add(key);
    try {
      const info = await fs.lstat(directory);
      if (info.isSymlink || !info.isDirectory) return;
      const entries = await fs.readDir(directory);
      for (const entry of entries) {
        if (entry.isSymlink) continue;
        const path = childPath(directory, entry.name);
        if (entry.isFile && /\.qiji$/i.test(entry.name)) await addFile(path, nested);
        else if (!nested && entry.isDirectory && entry.name.toLowerCase() !== "assets") await scan(path, true);
      }
    } catch { /* Missing roots and one broken directory do not abort the scan. */ }
  }

  for (const root of roots) {
    if (root.trim()) await scan(root, false);
  }
  return projects;
}
