/** Outbound MCP: tool names and schemas come from the selected resource server. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import type { JsonObject } from "@opensesame/os-domain";
import type { NativeMcpTransportPorts } from "./native-mcp-fetch.js";
import { nativeMcpFetch } from "./native-mcp-fetch.js";
import { NativeMcpSchemaValidator } from "./native-mcp-schema-validator.js";
import {
  type NativeMcpBinding,
  NativeMcpError,
  nativeMcpUrl,
} from "./native-mcp-target.js";

export type NativeMcpTool = Awaited<
  ReturnType<Client["listTools"]>
>["tools"][number];
export type NativeMcpToolResult = Awaited<ReturnType<Client["callTool"]>>;
export type NativeMcpDiscovery = {
  server: { name: string; version: string };
  tools: readonly NativeMcpTool[];
};

const TIMEOUT = 15_000;
const MAX_TOOLS = 500;
const MAX_PAGES = 20;

async function discoverTools(
  client: Client,
  signal: AbortSignal,
): Promise<NativeMcpTool[]> {
  const tools: NativeMcpTool[] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await client.listTools(cursor ? { cursor } : {}, {
      signal,
      timeout: TIMEOUT,
    });
    for (const tool of result.tools) {
      if (!tool.name || seen.has(tool.name) || tools.length >= MAX_TOOLS)
        throw new NativeMcpError("response");
      seen.add(tool.name);
      tools.push(tool);
    }
    cursor = result.nextCursor;
    if (!cursor) return tools;
    if (cursors.has(cursor)) throw new NativeMcpError("response");
    cursors.add(cursor);
  }
  throw new NativeMcpError("response");
}

export class NativeMcpSession {
  private readonly lifetime = new AbortController();
  private readonly inputValidator = new NativeMcpSchemaValidator();
  private readonly client = new Client(
    { name: "OpenSesame", version: "1.0.0" },
    { jsonSchemaValidator: this.inputValidator },
  );
  private readonly toolValidators = new Map<
    string,
    JsonSchemaValidator<JsonObject>
  >();
  private readonly outputValidators = new Map<
    string,
    JsonSchemaValidator<JsonObject>
  >();
  private readonly transport:
    | StreamableHTTPClientTransport
    | SSEClientTransport;
  private discovery: NativeMcpDiscovery | null = null;
  private connecting: Promise<NativeMcpDiscovery> | null = null;

  constructor(
    binding: NativeMcpBinding,
    private readonly ports: NativeMcpTransportPorts,
  ) {
    const admittedFetch = nativeMcpFetch(binding, ports, this.lifetime.signal);
    const url = nativeMcpUrl(binding.endpoint);
    this.transport =
      binding.transport === "sse"
        ? new SSEClientTransport(url, { fetch: admittedFetch })
        : new StreamableHTTPClientTransport(url, {
            fetch: admittedFetch,
            reconnectionOptions: {
              maxRetries: 0,
              initialReconnectionDelay: 1000,
              maxReconnectionDelay: 1000,
              reconnectionDelayGrowFactor: 1,
            },
          });
  }

  private assertLive(): void {
    this.ports.assertCurrent();
    if (this.lifetime.signal.aborted) throw new NativeMcpError("disposed");
  }

  async connect(): Promise<NativeMcpDiscovery> {
    this.assertLive();
    if (this.discovery) return this.discovery;
    if (this.connecting) return this.connecting;
    this.connecting = this.initialize();
    return this.connecting;
  }

  private async initialize(): Promise<NativeMcpDiscovery> {
    try {
      await this.client.connect(this.transport, {
        signal: this.lifetime.signal,
        timeout: TIMEOUT,
      });
      this.assertLive();
      const server = this.client.getServerVersion();
      if (!server || !this.client.getServerCapabilities()?.tools)
        throw new NativeMcpError("response");
      const tools = await discoverTools(this.client, this.lifetime.signal);
      for (const tool of tools) {
        this.toolValidators.set(
          tool.name,
          this.inputValidator.getValidator(tool.inputSchema),
        );
        if (tool.outputSchema)
          this.outputValidators.set(
            tool.name,
            this.inputValidator.getValidator(tool.outputSchema),
          );
      }
      this.assertLive();
      this.discovery = {
        server: { name: server.name, version: server.version },
        tools,
      };
      return this.discovery;
    } catch (error) {
      await this.dispose();
      if (error instanceof NativeMcpError) throw error;
      throw new NativeMcpError("response");
    }
  }

  async callTool(
    name: string,
    args: JsonObject,
    signal?: AbortSignal,
  ): Promise<NativeMcpToolResult> {
    this.assertLive();
    const validate = this.toolValidators.get(name);
    if (!this.discovery || !validate) throw new NativeMcpError("tool");
    if (!validate(args).valid) throw new NativeMcpError("arguments");
    try {
      const result = await this.client.callTool(
        { name, arguments: args },
        undefined,
        {
          signal: signal
            ? AbortSignal.any([signal, this.lifetime.signal])
            : this.lifetime.signal,
          timeout: TIMEOUT,
        },
      );
      this.assertLive();
      this.assertToolOutput(name, result);
      return result;
    } catch (error) {
      if (error instanceof NativeMcpError && error.code === "authorization")
        await this.dispose();
      if (error instanceof NativeMcpError) throw error;
      throw new NativeMcpError("response");
    }
  }

  private assertToolOutput(name: string, result: NativeMcpToolResult): void {
    const validate = this.outputValidators.get(name);
    if (!validate) return;
    if (!result.structuredContent && !result.isError)
      throw new NativeMcpError("response");
    if (result.structuredContent && !validate(result.structuredContent).valid)
      throw new NativeMcpError("response");
  }

  /** Abort first: retained references cannot issue requests after revocation or vault lock. */
  async dispose(): Promise<void> {
    this.lifetime.abort();
    this.discovery = null;
    this.toolValidators.clear();
    this.outputValidators.clear();
    await this.client.close().catch(() => undefined);
  }
}
