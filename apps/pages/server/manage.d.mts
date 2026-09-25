import type { RelayOutcome } from "./callback.mjs";

export function handleManage(req: {
  method: string;
  path: string;
  origin: string;
  body?: Record<string, unknown>;
  authorization?: string;
  requestHost?: string;
}): Promise<RelayOutcome>;
