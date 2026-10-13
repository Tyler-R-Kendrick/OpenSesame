/** Typed VFS error data only; no owner or admission. */
export type VfsErrorCode = "locked" | "not-found" | "invalid-path" | "corrupt";

/** Typed failure for every VFS boundary: locked tomb, bad path, tampered file. */
export class VfsError extends Error {
  readonly code: VfsErrorCode;

  constructor(code: VfsErrorCode, message: string) {
    super(message);
    this.name = "VfsError";
    this.code = code;
  }
}
