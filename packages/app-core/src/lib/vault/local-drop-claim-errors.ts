export class LocalDropClaimError extends Error {
  readonly code: "unreachable" | "refused";
  /**
   * The Identity API's error code for the same refusal, so a drop opened on
   * this device is read by the one wording (ceremony-kit `dropRefusal`).
   */
  readonly wire: string;
  constructor(
    code: "unreachable" | "refused",
    message: string,
    wire: string = code,
  ) {
    super(message);
    this.name = "LocalDropClaimError";
    this.code = code;
    this.wire = wire;
  }
}

export function refuseLocalDropClaim(
  wire: string,
  message: string,
): LocalDropClaimError {
  return new LocalDropClaimError("refused", message, wire);
}
