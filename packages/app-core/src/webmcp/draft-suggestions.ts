import { type JsonObject, isString } from "@opensesame/os-domain";
import { resolveTypeId } from "@opensesame/vault-item-types";
import { contributionsSnapshot } from "../lib/contributions.js";
import { generateDraftLabels } from "../lib/vault/new-draft.js";

export function assertMetadataOnlyWrite(args: JsonObject): void {
  const keys = ["itemId", "kind", "name", "folderId", "favorite", "url"];
  const rejected = Object.keys(args).filter((key) => !keys.includes(key));
  if (rejected.length > 0) {
    throw new Error(
      `non_metadata_fields_rejected:${rejected.sort().join(",")} — WebMCP writes carry title, folder, favorite and url only; secret fields stay in the vault UI`,
    );
  }
}

/** The metadata tool can suggest labels, but can never return generated credentials. */
export async function suggestItemMetadata(args: JsonObject) {
  if (
    Object.keys(args).some(
      (key) => !["action", "kind", "source", "url"].includes(key),
    ) ||
    !isString(args.kind) ||
    (args.url !== undefined &&
      (!isString(args.url) || args.url.length > 120)) ||
    (args.source !== undefined &&
      args.source !== "random" &&
      args.source !== "browser")
  )
    throw new Error("invalid_suggestion_arguments");
  const labels =
    args.source === "browser"
      ? await suggestOnDevice(
          args.kind,
          isString(args.url) ? args.url : undefined,
        )
      : generateDraftLabels(args.kind);
  return { status: "suggested", source: args.source ?? "random", ...labels };
}

/**
 * The on-device model is `support.local-ai`'s, reached only through what it
 * contributed: without that capability a caller is refused, and its code is
 * never imported here.
 */
async function suggestOnDevice(typeId: string, website: string | undefined) {
  const [assist] = contributionsSnapshot("item-draft-assist");
  if (!assist) throw new Error("on_device_model_not_enabled");
  // The retired `login` name suggests for an account (ADR 0168).
  return assist.suggest(
    { typeId: resolveTypeId(typeId), website },
    AbortSignal.timeout(30_000),
  );
}
