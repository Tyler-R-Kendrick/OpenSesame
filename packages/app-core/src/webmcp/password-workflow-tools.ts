import { type JsonObject, isString } from "@opensesame/os-domain";
import { parseAssignment, renderEnv } from "../lib/password-agent/env.js";
import {
  passwordWorkflowAudit,
  passwordWorkflowFind,
  passwordWorkflowInventory,
} from "../lib/vault/password-workflows.js";
import { continueToolRead } from "./tool-shared.js";
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
    execute: async (args, ceiling) => {
      requireUnlocked();
      if (
        !Array.isArray(args.queries) ||
        args.queries.some((query) => !isString(query))
      )
        throw new Error("queries must be an array of title queries");
      const queries = args.queries.map((query) => {
        if (!isString(query)) throw new Error("Invalid query");
        return query;
      });
      const found = await continueToolRead(
        () => passwordWorkflowFind(queries),
        ceiling,
      );
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
    execute: async (_args, ceiling) => {
      requireUnlocked();
      return {
        items: (
          await continueToolRead(() => passwordWorkflowInventory(), ceiling)
        ).map((item) => ({ ...item })),
      };
    },
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
    execute: (_args, ceiling) => {
      requireUnlocked();
      return continueToolRead(() => passwordWorkflowAudit(), ceiling);
    },
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
      "Open the local human password workflow for private credential creation, password comparison or update, explicit credential read, or env resolution. Only the human UI accepts private values and plaintext-download consent; this tool never accepts or returns secrets.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "compare", "update", "read", "env-resolve"],
        },
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
      if (Object.keys(args).some((key) => key !== "action"))
        throw new Error(
          "Human password workflows accept an action only; private input stays in the UI",
        );
      return ceremonyOpened(
        `/vault?workflow=password&workflowAction=${action}`,
      );
    },
  },
];
