/**
 * File paths from an HTML drag-and-drop, for the Home screen. Inside the Tauri app the webview
 * delivers drops with real paths through `attachFileDrop` (state); a browser's `File` objects
 * carry no path, so this only finds paths a drag gives as `file:` URIs or as a `path` field.
 */

/** Minimal view of a DataTransfer, so the function can be tested without a browser drag. */
export interface DroppedData {
  readonly files?: ArrayLike<unknown> | null;
  getData(format: string): string;
}

/** A `file:` URI as a Windows path: "file:///C:/A%20B/x.mp4" -> "C:\\A B\\x.mp4". Null if not a file URI. */
export function pathFromFileUri(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "file:") return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (url.host !== "") return `\\\\${url.host}${path.replace(/\//g, "\\")}`;
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  return path.replace(/\//g, "\\");
}

/** Every distinct path a drop carries, in drop order. Empty when it has none. */
export function droppedPaths(data: DroppedData | null | undefined): string[] {
  if (!data) return [];
  const out: string[] = [];
  const add = (p: string | null) => {
    if (p && !out.includes(p)) out.push(p);
  };
  const files = data.files;
  if (files) {
    for (let i = 0; i < files.length; i++) {
      const f = files[i] as { path?: unknown } | undefined;
      if (f && typeof f.path === "string" && f.path !== "") add(f.path);
    }
  }
  if (out.length === 0) {
    let list = "";
    try {
      list = data.getData("text/uri-list");
    } catch {
      list = "";
    }
    for (const line of list.split(/\r?\n/)) {
      if (line.trim() === "" || line.startsWith("#")) continue;
      add(pathFromFileUri(line));
    }
  }
  return out;
}

/** True inside the Tauri app, where drops reach the store through `attachFileDrop`. */
export function insideTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
