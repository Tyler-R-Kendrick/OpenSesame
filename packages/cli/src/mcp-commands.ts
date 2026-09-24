/**
 * `opensesame-id mcp host|client`: the two MCP servers are packages
 * (`@opensesame/mcp-host`, `@opensesame/mcp-client`) served by this CLI, not
 * programs of their own. Loaded on demand so the rest of the CLI never pays
 * for the MCP SDK.
 */
export const MCP_USAGE = "usage: opensesame-id mcp host|client";

export async function runMcp(
  args: readonly string[],
  load: (which: "host" | "client") => Promise<{ main(): Promise<void> }> = (
    which,
  ) =>
    which === "host"
      ? import("@opensesame/mcp-host")
      : import("@opensesame/mcp-client"),
): Promise<number | undefined> {
  const [which, ...rest] = args;
  if ((which !== "host" && which !== "client") || rest.length > 0) {
    process.stderr.write(`${MCP_USAGE}\n`);
    return 2;
  }
  await (await load(which)).main();
  return undefined;
}
