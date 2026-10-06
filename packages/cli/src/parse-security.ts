import type { GlobalFlags } from "./parse.js";

export type CanaryKind =
  | "connection_ref"
  | "mcp_configuration"
  | "token_generation"
  | "agent_lease";
type SimpleName =
  | "security-canary-status"
  | "security-canary-clear"
  | "security-receiver-status"
  | "security-receiver-test"
  | "security-receiver-remove";
type SimpleCommand = {
  [N in SimpleName]: { name: N; flags: GlobalFlags };
}[SimpleName];
type DetectorName =
  | "canary-serve"
  | "canary-install"
  | "canary-uninstall"
  | "canary-events";
type DetectorCommand = {
  [N in DetectorName]: { name: N; configFile: string; flags: GlobalFlags };
}[DetectorName];
export type SecurityCommand =
  | SimpleCommand
  | {
      name: "security-canary-create";
      kind: CanaryKind;
      output: string;
      flags: GlobalFlags;
    }
  | { name: "security-canary-export"; output: string; flags: GlobalFlags }
  | {
      name: "security-canary-retire";
      issuerRecordRef: string;
      flags: GlobalFlags;
    }
  | { name: "security-canary-remove"; artifactId: string; flags: GlobalFlags }
  | { name: "security-receiver-enabled"; enabled: boolean; flags: GlobalFlags }
  | {
      name: "security-receiver-configure";
      pairingFile: string;
      flags: GlobalFlags;
    }
  | DetectorCommand;

function single(args: string[], name: string): string {
  const value = args.shift();
  if (!value || args.length)
    throw new Error(
      `${name} requires exactly one file path or public artifact ID.`,
    );
  return value;
}
function output(args: string[]): string {
  if (args.shift() !== "--output")
    throw new Error("An owner-only output file is required: --output FILE.");
  return single(args, "--output");
}
function parseCanary(
  verb: string | undefined,
  args: string[],
  flags: GlobalFlags,
): SecurityCommand {
  if (verb === "retire")
    return {
      name: "security-canary-retire",
      issuerRecordRef: single(args, "retire"),
      flags,
    };

  if (verb === "create") {
    if (args.shift() !== "--kind")
      throw new Error("Canary creation requires --kind.");
    const kind = args.shift();
    if (
      kind !== "connection_ref" &&
      kind !== "mcp_configuration" &&
      kind !== "token_generation" &&
      kind !== "agent_lease"
    )
      throw new Error("Unknown controlled canary kind.");
    return {
      name: "security-canary-create",
      kind,
      output: output(args),
      flags,
    };
  }
  if (verb === "export-mcp")
    return { name: "security-canary-export", output: output(args), flags };
  if (verb === "remove")
    return {
      name: "security-canary-remove",
      artifactId: single(args, "remove"),
      flags,
    };
  if ((verb === "status" || verb === "clear-events") && !args.length)
    return {
      name:
        verb === "status" ? "security-canary-status" : "security-canary-clear",
      flags,
    };
  throw new Error("Unknown canary command.");
}
function parseReceiver(
  verb: string | undefined,
  args: string[],
  flags: GlobalFlags,
): SecurityCommand {
  if (verb === "configure") {
    const confirmation = args.indexOf("--confirm-destination");
    if (confirmation < 0)
      throw new Error(
        "Review the paired receiver destination and pass --confirm-destination.",
      );
    args.splice(confirmation, 1);
    return {
      name: "security-receiver-configure",
      pairingFile: single(args, "configure"),
      flags,
    };
  }
  if (!args.length && (verb === "enable" || verb === "disable"))
    return {
      name: "security-receiver-enabled",
      enabled: verb === "enable",
      flags,
    };
  if (
    !args.length &&
    (verb === "status" || verb === "test" || verb === "remove")
  )
    return {
      name:
        verb === "status"
          ? "security-receiver-status"
          : verb === "test"
            ? "security-receiver-test"
            : "security-receiver-remove",
      flags,
    };
  throw new Error("Unknown receiver command.");
}
export function parseSecurity(
  args: string[],
  flags: GlobalFlags,
): SecurityCommand {
  const section = args.shift();
  const verb = args.shift();
  if (section === "canary") return parseCanary(verb, args, flags);
  if (section === "receiver") return parseReceiver(verb, args, flags);
  throw new Error(
    "Choose canary or receiver management. Secrets are read only from the terminal or owner-only files.",
  );
}
export function parseCanaryServe(
  args: string[],
  flags: GlobalFlags,
): SecurityCommand {
  const verb = args.shift();
  if (
    verb !== "serve" &&
    verb !== "install" &&
    verb !== "uninstall" &&
    verb !== "events"
  )
    throw new Error("Choose canary install, serve, events, or uninstall.");
  if (verb === "install") {
    const trust = args.indexOf("--trust-configuration");
    if (trust < 0)
      throw new Error(
        "Review the private canary export and pass --trust-configuration to install this synthetic detector.",
      );
    args.splice(trust, 1);
  }
  if (args.shift() !== "--config")
    throw new Error("A private canary file is required: --config FILE.");
  const configFile = single(args, "canary detector");
  return {
    name:
      verb === "serve"
        ? "canary-serve"
        : verb === "install"
          ? "canary-install"
          : verb === "uninstall"
            ? "canary-uninstall"
            : "canary-events",
    configFile,
    flags,
  };
}
