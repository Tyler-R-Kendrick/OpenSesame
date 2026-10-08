import type { GlobalFlags } from "./parse.js";

export type LegacyConnectorCommand =
  | { name: "security-connectors-legacy-status"; flags: GlobalFlags }
  | { name: "security-connectors-legacy-discard-all"; flags: GlobalFlags }
  | {
      name: "security-connectors-legacy-resolve";
      decision: "import" | "discard";
      connectionIds: string[];
      flags: GlobalFlags;
    };

export function parseLegacyConnectors(
  verb: string | undefined,
  args: string[],
  flags: GlobalFlags,
): LegacyConnectorCommand {
  if (verb === "legacy-discard-all") {
    if (
      args.length !== 1 ||
      args[0] !== "--acknowledge-irrecoverable-legacy-discard"
    )
      throw new Error(
        "Discarding every legacy device credential requires --acknowledge-irrecoverable-legacy-discard and fresh owner authentication.",
      );
    return { name: "security-connectors-legacy-discard-all", flags };
  }
  if (verb === "legacy-status" && args.length === 0)
    return { name: "security-connectors-legacy-status", flags };
  if (verb !== "legacy-import" && verb !== "legacy-discard")
    throw new Error(
      "Choose connectors legacy-status, legacy-import, or legacy-discard.",
    );
  const acknowledge = args.indexOf("--acknowledge-ownership-ambiguity");
  if (acknowledge < 0)
    throw new Error(
      "Review the selected legacy records and pass --acknowledge-ownership-ambiguity. These device records cannot prove their original vault owner.",
    );
  args.splice(acknowledge, 1);
  if (
    args.length === 0 ||
    args.length > 16 ||
    new Set(args).size !== args.length ||
    args.some(
      (id) =>
        id.startsWith("--") ||
        id.length > 256 ||
        id.trim() !== id ||
        id.length === 0,
    )
  )
    throw new Error(
      "Select between one and sixteen distinct public legacy connection IDs.",
    );
  return {
    name: "security-connectors-legacy-resolve",
    decision: verb === "legacy-import" ? "import" : "discard",
    connectionIds: args,
    flags,
  };
}
