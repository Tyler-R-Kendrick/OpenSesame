import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import McpHostStructuralProvider, { type RedteamVars } from "./mcp-provider.js";

type ToolResponse = {
  isError?: boolean;
  content?: unknown;
};

export type Probe = {
  bootstrapExchanges?: number;
  calls: Array<{
    tool: string;
    params: JsonObject;
    response: ToolResponse;
  }>;
  tools?: Array<{
    name: string;
    inputSchema: { properties?: JsonObject };
  }>;
  upstreamRequests?: Array<{
    url: string;
    body: string;
    headers: Record<string, string | string[] | undefined>;
  }>;
};

export async function probe(vars: RedteamVars): Promise<Probe> {
  const provider = new McpHostStructuralProvider();
  const result = await provider.callApi("", {
    vars: overlapCast(vars),
  });
  if (result.error) throw new Error(result.error);
  if (!result.output) throw new Error("empty structural probe output");
  return overlapCast(JSON.parse(result.output));
}

export function dump(data: Probe): string {
  return JSON.stringify(data);
}
