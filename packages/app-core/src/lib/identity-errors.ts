export class IdentityError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "IdentityError";
    this.status = status;
  }
}

export class HostSessionError extends Error {
  constructor(
    readonly code: "setup_required" | "identity_changed" | "invalid_host",
    message: string,
  ) {
    super(message);
    this.name = "HostSessionError";
  }
}
