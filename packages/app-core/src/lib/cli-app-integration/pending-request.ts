/** Wire shape for a pending CLI integration request (daemon `/pending`). */

export interface PendingRequest {
  requestId: string;
  terminalSessionId: string;
  verb: string;
  reference?: string | undefined;
  createdAtMs: number;
}
