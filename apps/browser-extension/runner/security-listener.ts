import type { ExtensionRealmBroker } from "@opensesame/app-core/browser/security/broker.js";
import type { MessageSender } from "./sender";
import type { RunnerService, RunnerStatus } from "./service";
import { RunnerAuthorityEnded } from "./worker-authority";
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
  runner.bindSecurity?.(security);
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
        reply = await runner.status(message.securityPermit);
      else if (message.type === "opensesame.runner.arm") {
        const result = await runner.arm(
          message.origin ?? "",
          message.securityPermit,
        );
        if (!(await security.allows(message.securityPermit))) {
          await runner.disarm(message.origin ?? "", message.securityPermit);
          respond({ error: "vault_locked" });
          return;
        }
        if (result === "armed") void runner.tick().catch(() => undefined);
        reply = { result };
      } else {
        await runner.disarm(message.origin ?? "", message.securityPermit);
        reply = { result: "disarmed" };
      }
      if (!(await security.allows(message.securityPermit))) {
        respond({ error: "vault_locked" });
        return;
      }
      respond(reply);
    })().catch((error: unknown) =>
      respond({
        error:
          error instanceof RunnerAuthorityEnded
            ? "vault_locked"
            : "runner_unavailable",
      }),
    );
    return true;
  };
}
