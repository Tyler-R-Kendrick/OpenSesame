import type { CommitResult } from "./types.js";
import { isPresentationOnlyChange } from "./yaml-patch.js";
import { parseConfigYaml } from "./yaml-profile.js";

export type LocalApplicationPorts = {
  revision: () => number;
  configure: (registration: Record<string, unknown>, revision: number) => void;
};

/**
 * Source writes go through configureLocalApplication. Comment-only edits skip
 * the mutation so grants stay valid.
 */
export function commitLocalApplicationSource(
  ports: LocalApplicationPorts,
  input: {
    previousSource: string;
    source: string;
    expectedRevision: number;
  },
): CommitResult {
  if (input.expectedRevision !== ports.revision()) {
    return {
      status: "conflict",
      message: "This registration changed in another session.",
    };
  }
  const parsed = parseConfigYaml(input.source);
  if (!parsed.ok) {
    return {
      status: "refused",
      message: parsed.diagnostics[0]?.message ?? "Invalid application source.",
    };
  }
  if (isPresentationOnlyChange(input.previousSource, input.source)) {
    return {
      status: "applied_durable",
      message: "Saved comments. Application grants were not invalidated.",
    };
  }
  ports.configure(parsed.value, input.expectedRevision);
  return {
    status: "applied_durable",
    message: "Application registration saved.",
  };
}
