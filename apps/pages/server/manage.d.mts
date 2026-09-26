import type { JsonObject } from "@opensesame/os-domain";
import type { RelayOutcome } from "./callback.mjs";

export function handleManage(req: {
  method: string;
  path: string;
  origin: string;
  body?: JsonObject;
  authorization?: string;
  requestHost?: string;
}): Promise<RelayOutcome>;
