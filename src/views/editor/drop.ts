/**
 * Files dragged onto the editor. Inside Tauri the window's own drop handler (`attachFileDrop`
 * in state) delivers the paths; these helpers serve the web page's own drag events, which only
 * carry paths when the browser exposes them (a `file://` URI list, or a `path` on the File).
 */

/** The subset of DataTransfer the helpers read. */
export interface DropData {
  types: readonly string[] | DOMStringList;
  files?: ArrayLike<File> | null;
  getData(format: string): string;
}

/** True when the drag carries files (not text or a link from the page). */
export function carriesFiles(data: Pick<DropData, "types"> | null | undefined): boolean {
  if (!data) return false;
  return Array.from(data.types as ArrayLike<string>).includes("Files");
}

/** "file:///D:/Footage/A%20B.mp4" to "D:\Footage\A B.mp4"; other URIs give null. */
export function pathFromFileUri(uri: string): string | null {
  const m = /^file:\/\/([^/]*)(\/.*)$/i.exec(uri.trim());
  if (!m) return null;
  let path: string;
  try {
    path = decodeURIComponent(m[2]!);
  } catch {
    return null;
  }
  const host = m[1]!;
  if (host && host.toLowerCase() !== "localhost") return `\\\\${host}${path.replace(/\//g, "\\")}`;
  if (/^\/[A-Za-z]:/.test(path)) return path.slice(1).replace(/\//g, "\\");
  return path;
}

/** The file paths a drop carries, without duplicates; empty when the browser gives none. */
export function droppedPaths(data: DropData): string[] {
  const out: string[] = [];
  const add = (p: string | null | undefined) => {
    if (p && !out.includes(p)) out.push(p);
  };
  for (const file of Array.from(data.files ?? [])) {
    const path = (file as File & { path?: unknown }).path;
    if (typeof path === "string") add(path);
  }
  if (out.length === 0) {
    let list = "";
    try {
      list = data.getData("text/uri-list");
    } catch {
      list = "";
    }
    for (const line of list.split(/\r?\n/)) {
      if (line && !line.startsWith("#")) add(pathFromFileUri(line));
    }
  }
  return out;
}
