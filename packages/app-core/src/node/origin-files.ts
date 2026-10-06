/** Native files implementing the origin-file port; KV supplies the at-rest seals. */
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { z } from "zod";
const paths = new WeakMap<FileSystemHandle, string>();
const nodeError = z.object({ code: z.string() });
function convert(error: Error): never {
  const code = nodeError.safeParse(error);
  if (code.success && code.data.code === "ENOENT")
    throw new DOMException("File not found.", "NotFoundError");
  if (code.success && code.data.code === "ELOOP")
    throw new DOMException("Symbolic links are not allowed.", "SecurityError");
  throw error;
}
function childPath(parent: string, name: string): string {
  if (!name || name === "." || name === ".." || /[/\\\0]/.test(name))
    throw new DOMException("Invalid file name.", "TypeMismatchError");
  return join(parent, name);
}
async function fileBytes(path: string): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
}
async function checkedFile(path: string, create: boolean): Promise<void> {
  if (create) {
    try {
      const fd = await open(path, "wx", 0o600);
      await fd.close();
    } catch (error) {
      if (
        !nodeError.safeParse(error).success ||
        nodeError.parse(error).code !== "EEXIST"
      )
        throw error;
    }
  }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new DOMException("Not a regular file.", "TypeMismatchError");
}
class NodeWritable
  extends WritableStream<FileSystemWriteChunkType>
  implements FileSystemWritableFileStream
{
  private position = 0;
  private bytes: Uint8Array;
  constructor(
    private readonly path: string,
    initial: Uint8Array,
  ) {
    super({ write: (data) => this.accept(data), close: () => this.persist() });
    this.bytes = initial;
  }
  async write(data: FileSystemWriteChunkType): Promise<void> {
    const writer = this.getWriter();
    try {
      await writer.write(data);
    } finally {
      writer.releaseLock();
    }
  }
  async seek(position: number): Promise<void> {
    this.checkedSize(position);
    this.position = position;
  }
  async truncate(size: number): Promise<void> {
    this.checkedSize(size);
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, size));
    this.bytes = next;
    this.position = Math.min(this.position, size);
  }
  private checkedSize(size: number): void {
    if (!Number.isSafeInteger(size) || size < 0 || size > 128 * 1024 * 1024)
      throw new Error("File exceeds the native storage limit.");
  }
  private async accept(data: FileSystemWriteChunkType): Promise<void> {
    const text = z.string().safeParse(data);
    let bytes: Uint8Array;
    if (text.success) bytes = new TextEncoder().encode(text.data);
    else if (data instanceof Blob)
      bytes = new Uint8Array(await data.arrayBuffer());
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data))
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else
      throw new Error(
        "Use write, seek and truncate methods instead of command objects.",
      );
    const end = this.position + bytes.byteLength;
    this.checkedSize(end);
    const next = new Uint8Array(Math.max(this.bytes.byteLength, end));
    next.set(this.bytes);
    next.set(bytes, this.position);
    this.bytes = next;
    this.position = end;
  }
  private async persist(): Promise<void> {
    const temp = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const fd = await open(temp, "wx", 0o600);
    try {
      await fd.writeFile(this.bytes);
      await fd.sync();
    } finally {
      await fd.close();
    }
    try {
      await rename(temp, this.path);
      // Windows does not expose directory fsync; the committed file was synced above.
      if (process.platform !== "win32") {
        const directory = await open(dirname(this.path), constants.O_RDONLY);
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await rm(temp, { force: true });
    }
  }
}
class NodeFile implements FileSystemFileHandle {
  readonly kind = "file";
  readonly name: string;
  constructor(private readonly path: string) {
    this.name = basename(path);
    paths.set(this, path);
  }
  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return paths.get(other) === this.path;
  }
  async getFile(): Promise<File> {
    try {
      const bytes = await fileBytes(this.path);
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      return new File([buffer], this.name);
    } catch (error) {
      return convert(
        error instanceof Error ? error : new Error("Native file read failed."),
      );
    }
  }
  async createSyncAccessHandle(): Promise<never> {
    throw new DOMException(
      "Use asynchronous native file access.",
      "NotSupportedError",
    );
  }
  async createWritable(
    options: FileSystemCreateWritableOptions = {},
  ): Promise<FileSystemWritableFileStream> {
    await checkedFile(this.path, false);
    return new NodeWritable(
      this.path,
      options.keepExistingData ? await fileBytes(this.path) : new Uint8Array(),
    );
  }
}
class NodeDirectory implements FileSystemDirectoryHandle {
  readonly kind = "directory";
  readonly name: string;
  constructor(private readonly path: string) {
    this.name = basename(path);
    paths.set(this, path);
  }
  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return paths.get(other) === this.path;
  }
  async getFileHandle(
    name: string,
    options: FileSystemGetFileOptions = {},
  ): Promise<FileSystemFileHandle> {
    const path = childPath(this.path, name);
    try {
      await checkedFile(path, options.create ?? false);
      return new NodeFile(path);
    } catch (error) {
      return convert(
        error instanceof Error ? error : new Error("Native file open failed."),
      );
    }
  }
  async getDirectoryHandle(
    name: string,
    options: FileSystemGetDirectoryOptions = {},
  ): Promise<FileSystemDirectoryHandle> {
    const path = childPath(this.path, name);
    try {
      if (options.create) await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (
        !nodeError.safeParse(error).success ||
        nodeError.parse(error).code !== "EEXIST"
      )
        return convert(
          error instanceof Error
            ? error
            : new Error("Native directory creation failed."),
        );
    }
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new DOMException("Not a directory.", "TypeMismatchError");
      return new NodeDirectory(path);
    } catch (error) {
      return convert(
        error instanceof Error
          ? error
          : new Error("Native directory open failed."),
      );
    }
  }
  async removeEntry(
    name: string,
    options: FileSystemRemoveOptions = {},
  ): Promise<void> {
    const path = childPath(this.path, name);
    try {
      const info = await lstat(path);
      if (info.isDirectory() && !options.recursive) await rmdir(path);
      else await rm(path, { recursive: options.recursive ?? false });
    } catch (error) {
      return convert(
        error instanceof Error
          ? error
          : new Error("Native file removal failed."),
      );
    }
  }
  async resolve(other: FileSystemHandle): Promise<string[] | null> {
    const path = paths.get(other);
    if (!path) return null;
    const rel = relative(this.path, path);
    return rel === "" ? [] : rel.startsWith("..") ? null : rel.split(/[\\/]/);
  }
  async *entries(): AsyncGenerator<
    [string, FileSystemHandle],
    undefined,
    void
  > {
    for (const entry of await readdir(this.path, { withFileTypes: true })) {
      if (entry.name.endsWith(".tmp") || entry.isSymbolicLink()) continue;
      if (entry.isDirectory())
        yield [entry.name, new NodeDirectory(join(this.path, entry.name))];
      else if (entry.isFile())
        yield [entry.name, new NodeFile(join(this.path, entry.name))];
    }
  }
  async *keys(): AsyncGenerator<string, undefined, void> {
    for await (const [name] of this.entries()) yield name;
  }
  async *values(): AsyncGenerator<FileSystemHandle, undefined, void> {
    for await (const [, handle] of this.entries()) yield handle;
  }
  [Symbol.asyncIterator](): AsyncGenerator<
    [string, FileSystemHandle],
    undefined,
    void
  > {
    return this.entries();
  }
}
export function nodeOriginFiles(
  directory: string,
): () => Promise<FileSystemDirectoryHandle> {
  return async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    return new NodeDirectory(directory);
  };
}
