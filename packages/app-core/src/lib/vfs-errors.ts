/** Typed failures shared by the encrypted VFS and its session-authority seam. */
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
