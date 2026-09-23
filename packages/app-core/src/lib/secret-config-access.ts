import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { hostFetch } from "./identity.js";

export type ConfigAccess = {
  metadata: boolean;
  keys: boolean;
  manage: boolean;
};
export const NO_CONFIG_ACCESS: ConfigAccess = {
  metadata: false,
  keys: false,
  manage: false,
};

async function load(project: string): Promise<ConfigAccess> {
  const response = await hostFetch(
    `/api/v1/projects/${encodeURIComponent(project)}/config-access`,
  );
  if (response.status === 404) return { ...NO_CONFIG_ACCESS };
  if (!response.ok || !response.body)
    throw new Error("Could not read project permissions");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let bytes = 0;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel();
  }, 8000);
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 16384) throw new Error("Invalid project permissions");
      text += decoder.decode(part.value, { stream: true });
    }
    if (expired) throw new Error("Project permissions timed out");
  } finally {
    clearTimeout(timer);
    await reader.cancel();
  }
  let value: BoundaryValue;
  try {
    value = JSON.parse(text + decoder.decode());
  } catch {
    throw new Error("Invalid project permissions");
  }
  if (!isJsonObject(value) || !Array.isArray(value.capabilities))
    throw new Error("Invalid project permissions");
  const capabilities = value.capabilities;
  if (
    capabilities.some(
      (capability) =>
        !isString(capability) ||
        !["config.metadata.read", "config.keys.read", "config.manage"].includes(
          capability,
        ),
    )
  )
    throw new Error("Invalid project permissions");
  return {
    metadata: capabilities.includes("config.metadata.read"),
    keys: capabilities.includes("config.keys.read"),
    manage: capabilities.includes("config.manage"),
  };
}

export const configAccessSeams = { load };
export function loadConfigAccess(project: string) {
  return configAccessSeams.load(project);
}
