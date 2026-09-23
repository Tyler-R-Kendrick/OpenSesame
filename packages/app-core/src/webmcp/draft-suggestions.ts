import { type JsonObject, isString } from "@opensesame/os-domain";
import { suggestDraftLabels } from "../lib/vault/draft-suggestions.js";
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
      ? await suggestDraftLabels(
          {
            typeId: args.kind,
            website: isString(args.url) ? args.url : undefined,
          },
          AbortSignal.timeout(30_000),
        )
      : generateDraftLabels(args.kind);
  return { status: "suggested", source: args.source ?? "random", ...labels };
}
