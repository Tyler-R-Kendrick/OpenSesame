/**
 * `opensesame-id host health` and `host discover`: the Host API (:8787) as
 * the api-client sees it.
 */
import { createApiClient } from "@opensesame/api-client";
import { type JsonValue, overlapCast } from "@opensesame/os-domain";
import { emit } from "./output.js";
import type { ParsedCommand } from "./parse.js";

type HostCommand = Extract<
  ParsedCommand,
  { name: "host-health" | "host-discover" }
>;

export async function runHostCommand(
  command: HostCommand,
  fetchImpl: typeof fetch,
): Promise<number> {
  switch (command.name) {
    case "host-health": {
      const host = createApiClient({
        baseUrl: command.hostUrl,
        fetchImpl,
      });
      const health = await host.health();
      const daemon = await host.probeDaemon();
      const daemonHealth: JsonValue | undefined = overlapCast(daemon.health);
      emit(
        command.flags,
        health.ok
          ? `Host API up. Daemon ${daemon.available ? "available" : "unavailable"}.`
          : "Host API unreachable.",
        {
          health: { ok: health.ok, body: health.body },
          daemon: {
            available: daemon.available,
            url: daemon.url,
            ...(daemonHealth === undefined
              ? undefined
              : { health: daemonHealth }),
          },
        },
      );
      return health.ok ? 0 : 1;
    }

    case "host-discover": {
      const host = createApiClient({
        baseUrl: command.hostUrl,
        fetchImpl,
      });
      const discovery = await host.discover();
      emit(command.flags, `Discovery source: ${discovery.source}`, {
        source: discovery.source,
        ...(discovery.resource === undefined
          ? undefined
          : { resource: discovery.resource }),
        ...(discovery.authorizationServers === undefined
          ? undefined
          : { authorizationServers: discovery.authorizationServers }),
        ...(discovery.dpopBound === undefined
          ? undefined
          : { dpopBound: discovery.dpopBound }),
        ...(discovery.ready === undefined
          ? undefined
          : { ready: discovery.ready }),
      });
      return discovery.source === "none" ? 1 : 0;
    }
  }
}
