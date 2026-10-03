/**
 * A connection call failed. Settings' tile helper reads this type while
 * Connections is off, so it cannot live in the module that capability owns.
 */
export class ConnectionsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConnectionsError";
  }
}
