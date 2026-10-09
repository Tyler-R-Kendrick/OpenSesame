import { type JsonObject, isString } from "@opensesame/os-domain";
import { parseAssignment, renderEnv } from "../lib/password-agent/env.js";
import {
  passwordWorkflowAudit,
  passwordWorkflowFind,
  passwordWorkflowInventory,
} from "../lib/vault/password-workflows.js";
import {
  type PagesWebMcpTool,
  ceremonyOpened,
  requireUnlocked,
  str,
} from "./tool-shared.js";

export const PASSWORD_WORKFLOW_TOOLS: readonly PagesWebMcpTool[] = [
  {
    name: "opensesame_vault_find_references",
    capabilityIds: ["vault.workflow.find_references"],
    scope: "session",
    readOnly: true,
    description:
      "Find secret references in this local vault for several title queries. Returns os:// references and metadata only; never secret values. 1Password op:// discovery requires the native CLI.",
    inputSchema: {
      type: "object",
      properties: {
        queries: { type: "array", items: { type: "string" }, minItems: 1 },
      },
      required: ["queries"],
      additionalProperties: false,
    },
    execute: async (args) => {
      if (
        !Array.isArray(args.queries) ||
        args.queries.some((query) => !isString(query))
      )
        throw new Error("queries must be an array of title queries");
      const queries = args.queries.map((query) => {
        if (!isString(query)) throw new Error("Invalid query");
        return query;
      });
      const found = await passwordWorkflowFind(queries);
      const result: JsonObject = {
        matches: found.matches.map((match) => ({ ...match })),
      };
      if (found.suggestions)
        result.suggestions = found.suggestions.map((match) => ({ ...match }));
      return result;
    },
  },
  {
    name: "opensesame_vault_inventory",
    capabilityIds: ["vault.workflow.inventory"],
    scope: "session",
    readOnly: true,
    description:
      "List audit-safe local vault inventory: metadata and references only.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async () => ({
      items: (await passwordWorkflowInventory()).map((item) => ({ ...item })),
    }),
  },
  {
    name: "opensesame_vault_audit_organization",
    capabilityIds: ["vault.workflow.audit_organization"],
    scope: "session",
    readOnly: true,
    description:
      "Audit local vault duplicate titles, untagged machine credentials, old logins and URLs to review, without secret values.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: () => passwordWorkflowAudit(),
  },
  {
    name: "opensesame_vault_env_template",
    capabilityIds: ["vault.workflow.env_template"],
    scope: "session",
    readOnly: true,
    description:
      "Build a reference-only env template from newline-separated NAME=os:// or NAME=op:// assignments. Never resolves values or executes a process.",
    inputSchema: {
      type: "object",
      properties: { assignments: { type: "string" } },
      required: ["assignments"],
      additionalProperties: false,
    },
    execute: (args) => {
      requireUnlocked();
      const assignments = str(args, "assignments")
        .split(/\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map(parseAssignment);
      return { template: renderEnv(assignments) };
    },
  },
  {
    name: "opensesame_open_password_workflow",
    capabilityIds: [
      "vault.workflow.create_private",
      "vault.workflow.compare_private",
      "vault.workflow.update_private",
      "password_provider.read",
      "password_provider.env_resolve",
    ],
    scope: "session",
    description:
      "Take the person to where they do a private credential task themselves: a new API credential, or an item's own page for comparing or replacing a password, copying a reference, reading a value or writing a plaintext .env. Takes an action and, optionally, an item id; never accepts or returns a secret.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "compare", "update", "read", "env-resolve"],
        },
        item: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    execute: (args) => {
      requireUnlocked();
      const action = str(args, "action");
      if (
        !["create", "compare", "update", "read", "env-resolve"].includes(action)
      )
        throw new Error("Unknown human password workflow");
      if (Object.keys(args).some((key) => key !== "action" && key !== "item"))
        throw new Error(
          "Human password workflows accept an action and an item id only; private input stays in the UI",
        );
      const item = args.item === undefined ? "" : str(args, "item");
      if (item && !/^[A-Za-z0-9_-]{1,128}$/.test(item))
        throw new Error("Unknown item");
      if (action === "create") return ceremonyOpened("/vault/new/secret");
      return ceremonyOpened(item ? `/vault/${item}` : "/vault");
    },
  },
];
