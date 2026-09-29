/**
 * The registry's types. Split out of `index` for the 400-line module budget
 * (ADR 0093); `index` re-exports every one unchanged.
 */

export type Surface =
  | "cli"
  | "pwa"
  | "mcp_host"
  | "mcp_client"
  | "webmcp"
  | "extension"
  | "android";

export type AgentSurface = "mcp_host" | "mcp_client" | "webmcp";

export interface CapabilityExclusion {
  /** Why this capability is deliberately withheld from the surface. */
  readonly reason: string;
  /** ADR file name under docs/adr/ that records the decision. */
  readonly adr: string;
}

export interface Capability {
  readonly id: string;
  readonly title: string;
  readonly plane: "host" | "identity" | "client_local";
  readonly kind: "read" | "act" | "admin" | "ceremony";
  readonly surfaces: {
    readonly cli: string | null;
    readonly pwa: string | null;
    readonly mcp_host: string | null;
    readonly mcp_client: string | null;
    readonly webmcp: string | null;
    /**
     * `message:<type>` the browser extension's background handles — the
     * default extension's, or, when `plugin` names a browser-extension
     * plugin, that companion's.
     */
    readonly extension?: string | null;
    /** The Android app's intent or screen; absent means not built there. */
    readonly android?: string | null;
  };
  /**
   * null on a surface means "not applicable"; an entry here means
   * "deliberately withheld" and must cite a real ADR. The registry self-test
   * requires every host/identity capability to be mapped or excluded on MCP,
   * and every capability with a pwa surface to be mapped or excluded on
   * WebMCP.
   */
  readonly excluded?: Partial<Record<Surface, CapabilityExclusion>>;
  /**
   * The optional runtime plugin (`spec/plugins/catalog.json` id) whose
   * install carries this capability's surfaces (ADR 0150 §7). Absent means
   * the capability ships in the default build of every surface it maps.
   */
  readonly plugin?: string;
}
