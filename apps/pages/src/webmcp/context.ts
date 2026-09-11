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
export const SESSION_TOOL_CONTEXTS: Record<string, readonly WebMcpContextId[]> =
  {
    opensesame_vault_search: ["vault"],
    opensesame_vault_item_read: ["vault"],
    opensesame_vault_item_write: ["vault"],
    opensesame_totp_code: ["vault"],
    opensesame_open_reveal: ["vault"],
    opensesame_login_draft: ["login_form"],
    opensesame_settings_read: ["settings"],
    opensesame_connections_read: ["connections"],
    opensesame_open_connect_ceremony: ["connections"],
    opensesame_access_read: ["access"],
    opensesame_task_terminate: ["access"],
    opensesame_delegation_narrow: ["access"],
    opensesame_delegation_revoke: ["access"],
    opensesame_open_relay_approval: ["access"],
    opensesame_open_delegation_claim: ["access"],
    opensesame_identity_read: ["identity"],
    opensesame_help: WEBMCP_CONTEXTS,
    opensesame_guide_start: WEBMCP_CONTEXTS,
  };

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
  return tools.filter(
    (tool) =>
      tool.scope === "session" &&
      SESSION_TOOL_CONTEXTS[tool.name]?.includes(context),
  );
}
