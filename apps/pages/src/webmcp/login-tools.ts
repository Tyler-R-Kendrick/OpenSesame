import type { WebMcpToolSpec } from "@opensesame/webmcp";
import { isBoolean } from "@opensesame/os-domain";
import { requireLoginDraft } from "../lib/vault/login-draft.js";
import { suggestItemMetadata } from "./draft-suggestions.js";

type LoginTool = WebMcpToolSpec & {
  capabilityIds: readonly string[];
  scope: "boot" | "session";
};

function optStr(
  args: Record<string, unknown>,
  key: string,
): string | null {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export const LOGIN_DRAFT_TOOLS: readonly LoginTool[] = [
  {
    name: "opensesame_login_draft",
    capabilityIds: ["vault.login_draft"],
    scope: "session",
    description:
      "Read or fill the on-screen login editor. Metadata only: name, username, website, folder, favorite. Never reads or writes the password, TOTP seed, or other secrets. Write patches the form; the person saves.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "suggest", "write"] },
        source: {
          type: "string",
          enum: ["random", "browser"],
          description: "Only with action=suggest.",
        },
        name: { type: "string" },
        username: { type: "string" },
        url: { type: "string" },
        folderId: { type: "string" },
        favorite: { type: "boolean" },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const action = optStr(args, "action") ?? "read";
      if (action === "suggest") {
        return suggestItemMetadata({
          ...args,
          kind: "login",
          action: "suggest",
        });
      }
      const draft = requireLoginDraft();
      if (action === "read") return draft.read();
      if (action !== "write") throw new Error(`unknown_action:${action}`);
      const folderId =
        args.folderId === null ? null : (optStr(args, "folderId") ?? undefined);
      return draft.patch({
        name: optStr(args, "name") ?? undefined,
        username: optStr(args, "username") ?? undefined,
        url: optStr(args, "url") ?? undefined,
        folderId,
        favorite: isBoolean(args.favorite) ? args.favorite : undefined,
      });
    },
  },
];
