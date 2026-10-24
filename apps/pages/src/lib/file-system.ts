/**
 * User-chosen files through the browser's file system APIs.
 *
 * Internal vault data already lives in the origin private file system
 * (`app-core/lib/kv.ts`, `file-parts-store.ts`, travel). This module is for
 * the other direction: handing the person a file, or taking one they chose.
 * Where the File System Access API is available it opens the browser's own
 * save dialog; everywhere else it falls back to an anchor download.
 */

export type SaveOutcome = "saved" | "downloaded" | "cancelled";

type SavePickerOptions = {
  suggestedName?: string;
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
};

type PickerHost = {
  showSaveFilePicker?: (
    options?: SavePickerOptions,
  ) => Promise<FileSystemFileHandle>;
  showOpenFilePicker?: () => Promise<FileSystemFileHandle[]>;
  showDirectoryPicker?: (options?: {
    mode?: "read" | "readwrite";
  }) => Promise<FileSystemDirectoryHandle>;
};

function pickerHost(): PickerHost {
  // SAFETY: every PickerHost member is optional, so the global matches it whether or not this browser has the File System Access API; each caller checks its picker before using it.
  return globalThis as PickerHost;
}

function picker(): PickerHost["showSaveFilePicker"] {
  const host = pickerHost();
  return host.showSaveFilePicker?.bind(host);
}

function openPicker(): PickerHost["showOpenFilePicker"] {
  const host = pickerHost();
  return host.showOpenFilePicker?.bind(host);
}

function directoryPicker(): PickerHost["showDirectoryPicker"] {
  const host = pickerHost();
  return host.showDirectoryPicker?.bind(host);
}

function extensionOf(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  if (dot < 1 || dot === fileName.length - 1) return null;
  return fileName.slice(dot + 1);
}

function pickerOptions(
  fileName: string,
  description: string,
): SavePickerOptions {
  const extension = extensionOf(fileName);
  if (extension === null) return { suggestedName: fileName };
  return {
    suggestedName: fileName,
    types: [
      {
        description,
        accept: { "application/octet-stream": [`.${extension}`] },
      },
    ],
  };
}

function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Some engines cancel a download when the URL is revoked in the same task.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function cancelled(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}

/**
 * Save a Blob. Returns `"saved"` only when the picker wrote and closed the
 * file; `"downloaded"` when the anchor fallback was used; `"cancelled"` when
 * the person dismissed the picker. A picker failure other than cancellation
 * falls back to the download rather than losing the file.
 */
export async function saveBlob(
  blob: Blob,
  fileName: string,
  description = "File",
): Promise<SaveOutcome> {
  const choose = picker();
  if (choose !== undefined) {
    try {
      const handle = await choose(pickerOptions(fileName, description));
      const writable = await handle.createWritable();
      try {
        await writable.write(blob);
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => undefined);
        throw error;
      }
      return "saved";
    } catch (error) {
      if (cancelled(error)) return "cancelled";
    }
  }
  download(blob, fileName);
  return "downloaded";
}

/**
 * Files chosen in the browser's open dialog. Returns `null` where the File
 * System Access open picker is unavailable, so the caller can fall back to an
 * `<input type="file">`; an empty array means the person dismissed it.
 */
export async function pickFiles(): Promise<File[] | null> {
  const choose = openPicker();
  if (choose === undefined) return null;
  try {
    const handles = await choose();
    return Promise.all(handles.map((handle) => handle.getFile()));
  } catch (error) {
    if (cancelled(error)) return [];
    throw error;
  }
}

export async function saveTextFile(
  fileName: string,
  text: string,
  type = "text/plain",
  description = "File",
): Promise<SaveOutcome> {
  return saveBlob(new Blob([text], { type }), fileName, description);
}

/**
 * Choose a directory for one reviewed export. `null` when this browser has no
 * directory picker or the person dismissed it; a picker failure is not treated
 * as a successful save.
 */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const choose = directoryPicker();
  if (choose === undefined) return null;
  try {
    return await choose({ mode: "readwrite" });
  } catch (error) {
    if (cancelled(error)) return null;
    throw error;
  }
}

/** Whether the browser can hand us a writable directory. */
export function directoryPickerAvailable(): boolean {
  return directoryPicker() !== undefined;
}

function versionedName(fileName: string, version: number): string {
  if (version === 0) return fileName;
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return `${fileName}-${version}`;
  return `${fileName.slice(0, dot)}-${version}${fileName.slice(dot)}`;
}

async function unusedName(
  directory: FileSystemDirectoryHandle,
  fileName: string,
): Promise<string> {
  for (let version = 0; version < 100; version += 1) {
    const candidate = versionedName(fileName, version);
    try {
      await directory.getFileHandle(candidate);
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError")
        return candidate;
      throw error;
    }
  }
  throw new Error("That folder already holds too many backups with this name.");
}

/** Write one file into a directory the person explicitly chose. */
export async function saveBlobToDirectory(
  directory: FileSystemDirectoryHandle,
  fileName: string,
  blob: Blob,
): Promise<void> {
  const name = await unusedName(directory, fileName);
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

export async function saveTextToDirectory(
  directory: FileSystemDirectoryHandle,
  fileName: string,
  text: string,
  type = "text/plain",
): Promise<void> {
  await saveBlobToDirectory(directory, fileName, new Blob([text], { type }));
}

/** Whether this context exposes the browser's origin private file system. */
export function originPrivateFilesAvailable(): boolean {
  return (
    "navigator" in globalThis &&
    globalThis.navigator.storage?.getDirectory instanceof Function
  );
}
