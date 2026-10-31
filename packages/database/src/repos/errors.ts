export class ConflictError extends Error {
  override readonly name = "ConflictError";
  // biome-ignore lint/complexity/noUselessConstructor: Error needs the message passed to super.
  constructor(message: string) {
    super(message);
  }
}

export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
  // biome-ignore lint/complexity/noUselessConstructor: Error needs the message passed to super.
  constructor(message: string) {
    super(message);
  }
}
