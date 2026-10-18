import { setStatusNotice } from "@opensesame/app-core/lib/notices.js";
import type {
  LocalCanaryCommand,
  LocalCanaryResult,
  LocalVaultOperation,
  LocalVaultPrimary,
  LocalVaultSecurityPort,
} from "@opensesame/vault-core/local-vault-security.js";
import { useEffect, useRef, useState } from "react";

/** A sheet owns its exact local operation and aborts it when its presentation ends. */
export function useCanaryOperation(
  port: Pick<LocalVaultSecurityPort, "beginCanary" | "isCanaryResultCurrent">,
) {
  const [result, setResult] = useState<LocalCanaryResult | null>(null);
  const [challenge, setChallenge] =
    useState<LocalVaultOperation<LocalCanaryResult> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [delivery, setDelivery] = useState("");
  const lifetime = useRef(new AbortController());
  const pending = useRef<LocalVaultOperation<LocalCanaryResult> | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      void pending.current?.cancel().catch(() => {
        setStatusNotice({
          id: "canary-operation-close",
          tone: "err",
          title: "Agent canaries",
          body: "The operation could not finish closing. Lock the vault before continuing.",
        });
      });
    };
  }, []);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch {
      if (!lifetime.current.signal.aborted)
        setError(
          "The operation could not be completed. Check your current key and second step, then try again.",
        );
    } finally {
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  }
  function publish(value: LocalCanaryResult) {
    if (lifetime.current.signal.aborted || !port.isCanaryResultCurrent(value))
      return;
    pending.current = null;
    setChallenge(null);
    setResult(value);
  }
  return {
    result: result && port.isCanaryResultCurrent(result) ? result : null,
    challenge,
    busy,
    error,
    delivery,
    begin: (primary: LocalVaultPrimary, command: LocalCanaryCommand) =>
      run(async () => {
        setResult(null);
        const started = await port.beginCanary(
          primary,
          command,
          lifetime.current.signal,
        );
        if (lifetime.current.signal.aborted) {
          if (started.kind === "challenge") await started.cancel();
          return;
        }
        if (started.kind === "complete") publish(started.result);
        else {
          pending.current = started;
          setChallenge(started);
        }
      }),
    complete: (
      factor: Parameters<LocalVaultOperation<LocalCanaryResult>["complete"]>[0],
    ) =>
      run(async () => {
        if (!pending.current) throw new Error("Local operation ended.");
        publish(await pending.current.complete(factor));
      }),
    send: (channel: "email" | "sms") =>
      run(async () => {
        if (!pending.current) throw new Error("Local operation ended.");
        const status = await pending.current.requestCode(channel);
        if (!lifetime.current.signal.aborted)
          setDelivery(
            `Code sent by ${status.channel === "email" ? "email" : "text"}. Expires ${new Date(status.expiresAt).toLocaleTimeString()}.`,
          );
      }),
  };
}
