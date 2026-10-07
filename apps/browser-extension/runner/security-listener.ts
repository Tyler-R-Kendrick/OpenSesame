import type { ExtensionRealmBroker } from "@opensesame/app-core/browser/security/broker.js";
import type { MessageSender } from "./sender";
import type { RunnerService, RunnerStatus } from "./service";
interface RunnerMessage {
  type?: string;
  origin?: string;
  securityPermit?: string;
}
interface RunnerReply {
  result?: string;
  error?: string;
}

/** Production messages require a live owner permit minted in the trusted worker. */
export function runnerListener(
  runner: RunnerService,
  security: ExtensionRealmBroker,
  ownPage: (sender: MessageSender) => boolean,
) {
  return (
    message: RunnerMessage | undefined,
    sender: MessageSender,
    respond: (reply: RunnerReply | RunnerStatus) => void,
  ) => {
    if (
      !message ||
      ![
        "opensesame.runner.status",
        "opensesame.runner.arm",
        "opensesame.runner.disarm",
      ].includes(message.type ?? "")
    )
      return undefined;
    if (!ownPage(sender)) return undefined;
    void (async () => {
      if (!(await security.allows(message.securityPermit))) {
        respond({ error: "vault_locked" });
        return;
      }
      let reply: RunnerReply | RunnerStatus;
      if (message.type === "opensesame.runner.status")
        reply = await runner.status();
      else if (message.type === "opensesame.runner.arm") {
        const result = await runner.arm(message.origin ?? "");
        if (!(await security.allows(message.securityPermit))) {
          await runner.disarm(message.origin ?? "");
          respond({ error: "vault_locked" });
          return;
        }
        if (result === "armed") void runner.tick().catch(() => undefined);
        reply = { result };
      } else {
        await runner.disarm(message.origin ?? "");
        reply = { result: "disarmed" };
      }
      if (!(await security.allows(message.securityPermit))) {
        respond({ error: "vault_locked" });
        return;
      }
      respond(reply);
    })().catch(() => respond({ error: "runner_unavailable" }));
    return true;
  };
}
