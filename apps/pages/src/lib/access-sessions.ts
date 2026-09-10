import { isJsonObject, isNumber, isString } from "@opensesame/os-domain";
import { call } from "./access.js";

export type SessionCapability = { action: string; resource: string };

/** Derive the actor and organization from validated Host claims, never a form. */
export async function createAccessSession(
  capabilities: SessionCapability[],
  ttlSeconds: number,
) {
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > 86400 ||
    capabilities.length < 1 ||
    capabilities.length > 64 ||
    capabilities.some((cap) => !cap.action.trim() || !cap.resource.trim())
  )
    throw new Error(
      "A session needs an explicit scope and a lifetime of at most one day.",
    );
  const owner = await call("/whoami", {}, (body) => {
    if (
      !isJsonObject(body) ||
      !isString(body.principal_id) ||
      !isString(body.organization_id)
    )
      throw new Error(
        "Authenticate this browser with Identity before starting a session.",
      );
    return {
      principal_id: body.principal_id,
      organization_id: body.organization_id,
    };
  });
  return call(
    "/tasks",
    {
      method: "POST",
      body: JSON.stringify({ ...owner, capabilities, ttl_seconds: ttlSeconds }),
    },
    (body) => {
      if (
        !isJsonObject(body) ||
        !isString(body.task_run_id) ||
        !isNumber(body.state_version) ||
        !isString(body.status)
      )
        throw new Error("Host returned an invalid session.");
      return {
        taskRunId: body.task_run_id,
        stateVersion: body.state_version,
        status: body.status,
      };
    },
  );
}
