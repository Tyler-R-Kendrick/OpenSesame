import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import { forAgent } from "./agent-payload.js";

/** Host API MCP tools removed with the authority plane. */
export const hostTools = [] as const;

export function assertsNoSecretTools(names: readonly string[]): void {
  if (
    names.some((n) =>
      /secret|materialize|pass_show|sealed_store_show|password_store_read|pepper|oprf|^show$/i.test(
        n,
      ),
    )
  ) {
    throw new Error("secret_tools_forbidden");
  }
}

export const safeTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9:._/-]{1,512}$/, "invalid opaque identifier");

export const errorResponseSchema = z.object({ error: safeTokenSchema });

export function registerHostTools(_server: McpServer): void {
  assertsNoSecretTools(hostTools);
}

export function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

export function agentJson(
  body: BoundaryValue,
  ok: boolean,
  successSchema: z.ZodType,
) {
  forAgent(JSON.stringify(body));
  const parsed = (ok ? successSchema : errorResponseSchema).safeParse(body);
  return forAgent(
    JSON.stringify(
      parsed.success ? parsed.data : { error: "upstream_response_invalid" },
    ),
  );
}

export function toolError(label: string, e: Error | string) {
  const message = e instanceof Error ? e.message : String(e);
  try {
    return {
      content: textContent(forAgent(`${label}: ${message}`)),
      isError: true,
    };
  } catch {
    return {
      content: textContent(`${label}: refused`),
      isError: true,
    };
  }
}

export function agentJsonProjected(
  body: BoundaryValue,
  ok: boolean,
  successSchema: z.ZodType,
) {
  const parsed = (ok ? successSchema : errorResponseSchema).safeParse(body);
  return forAgent(
    JSON.stringify(
      parsed.success ? parsed.data : { error: "upstream_response_invalid" },
    ),
  );
}
