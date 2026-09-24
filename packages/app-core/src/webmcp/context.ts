export const WEBMCP_CONTEXTS = [
  "vault",
  "login_form",
  "settings",
  "access",
  "connections",
  "identity",
] as const;

export type WebMcpContextId = (typeof WEBMCP_CONTEXTS)[number];

/** Session tools registered only while this surface is the one on screen. */
export const SESSION_TOOL_CONTEXTS = {
  opensesame_vault_search: ["vault"],
  opensesame_vault_item_read: ["vault"],
  opensesame_vault_item_write: ["vault"],
  opensesame_totp_code: ["vault"],
  opensesame_open_reveal: ["vault"],
  opensesame_login_draft: ["login_form"],
  opensesame_settings_read: ["settings"],
  opensesame_connections_read: ["connections"],
  opensesame_open_connect_ceremony: ["connections"],
  opensesame_identity_read: ["identity"],
  opensesame_help: WEBMCP_CONTEXTS,
  opensesame_guide_start: WEBMCP_CONTEXTS,
  opensesame_wallet_budgets_read: ["vault", "access", "settings"],
  opensesame_wallet_allocations_read: ["vault", "access", "settings"],
  opensesame_wallet_payment_propose: ["vault", "access", "settings"],
  opensesame_wallet_payment_execute_approved: ["vault", "access", "settings"],
  opensesame_wallet_payment_status: ["vault", "access", "settings"],
  opensesame_wallet_lease_request: ["vault", "access", "settings"],
  opensesame_wallet_lease_status: ["vault", "access", "settings"],
  opensesame_wallet_lease_request_stop: ["vault", "access", "settings"],
} satisfies Record<string, readonly WebMcpContextId[]>;

let editorKind: string | null = null;
const listeners = new Set<() => void>();

export function setWebMcpEditorKind(kind: string | null): void {
  if (editorKind === kind) return;
  editorKind = kind;
  for (const listener of [...listeners]) listener();
}

export function subscribeWebMcpEditorKind(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getWebMcpEditorKind(): string | null {
  return editorKind;
}

function vaultEditorPath(pathname: string): boolean {
  return /\/vault\/(?:new(?:\/[^/]+)?|[^/]+\/edit)\/?$/.test(pathname);
}

export function webmcpContext(
  pathname: string,
  kind: string | null,
): WebMcpContextId {
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname.startsWith("/access")) return "access";
  if (pathname.startsWith("/connections")) return "connections";
  if (pathname.startsWith("/identity")) return "identity";
  const path = pathname.split("?")[0] ?? pathname;
  if (kind === "login" && vaultEditorPath(path)) return "login_form";
  if (kind && vaultEditorPath(path)) return "vault";
  if (/\/vault\/new(?:\/login)?\/?$/.test(path)) return "login_form";
  return "vault";
}

export function sessionToolsFor<T extends { name: string; scope: string }>(
  tools: readonly T[],
  context: WebMcpContextId,
): T[] {
  return tools.filter((tool) => {
    if (tool.scope !== "session") return false;
    if (!Object.hasOwn(SESSION_TOOL_CONTEXTS, tool.name)) return false;
    // SAFETY: Object.hasOwn established tool.name is a key of SESSION_TOOL_CONTEXTS.
    const allowed =
      SESSION_TOOL_CONTEXTS[tool.name as keyof typeof SESSION_TOOL_CONTEXTS];
    // SAFETY: SESSION_TOOL_CONTEXTS values are checked-in readonly context string arrays.
    return (allowed as readonly string[]).includes(context);
  });
}
