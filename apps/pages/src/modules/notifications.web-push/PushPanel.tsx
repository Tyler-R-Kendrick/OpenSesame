/**
 * Settings › General › Push on this device (ADR 0084): the enrolment row the
 * `notifications.web-push` capability brings. One row, one key: turn push on
 * for this browser (the browser asks for the `notifications` permission when,
 * and only when, the key is pressed) or turn it off.
 *
 * It is drawn only where it can act: a browser that can receive push, an
 * Identity API to register with, and a session on it. Without those there is
 * nothing to press, so there is no row (ADR 0158) — never a disabled key.
 * A refusal is a notice in the tray; the row's own mark is the state.
 */

import { kvDelete, kvGet, kvSet } from "@opensesame/app-core/lib/kv.js";
import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import { useEffect, useState } from "react";
import { useIdentitySession } from "../../bindings/identity.js";
import { IconKey } from "../../components/IconKey.js";
import { IconBell, IconPlus, IconX } from "../../components/Icons.js";
import {
  disablePush,
  enablePush,
  pushSeams,
  pushSupported,
} from "../../lib/push.js";
import { useIdentityConfigured } from "../../lib/use-configured.js";
import { CeremonyRow } from "../../sections/settings/CeremonyRow.js";

const NOTICE_ID = "push-on-this-device";
/** The id the Identity API gave this browser's subscription, so it can be withdrawn. */
export const PUSH_SUBSCRIPTION_KEY = "push.subscription.id";

/** Whether this browser holds a push subscription now. */
async function subscribed(): Promise<boolean> {
  const container = pushSeams.serviceWorkerContainer();
  if (!container) return false;
  const worker = await container.ready;
  return (await worker.pushManager.getSubscription()) !== null;
}

export function PushPanel({ baseUrl }: { baseUrl: () => string }) {
  const configured = useIdentityConfigured();
  const session = useIdentitySession();
  const supported = pushSupported();
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const live = configured && session !== null && supported;

  useEffect(() => {
    if (!live) return;
    let current = true;
    void subscribed().then(
      (value) => {
        if (current) setOn(value);
      },
      () => {
        if (current) setOn(false);
      },
    );
    return () => {
      current = false;
    };
  }, [live]);

  if (!live || on === null) return null;

  const turn = async () => {
    dismissNotice(NOTICE_ID);
    setBusy(true);
    try {
      const credentials = {
        baseUrl: baseUrl(),
        accessToken: session.accessToken,
      };
      if (on) {
        await disablePush({
          ...credentials,
          subscriptionId: kvGet(PUSH_SUBSCRIPTION_KEY) ?? "",
        });
        kvDelete(PUSH_SUBSCRIPTION_KEY);
        setOn(false);
      } else {
        const record = await enablePush(credentials);
        if (record.id) kvSet(PUSH_SUBSCRIPTION_KEY, record.id);
        setOn(true);
      }
    } catch (caught) {
      setStatusNotice({
        id: NOTICE_ID,
        tone: "err",
        title: "Push on this device",
        body: caught instanceof Error ? caught.message : String(caught),
      });
      setOn(await subscribed().catch(() => false));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" id="push-on-this-device">
      <div className="panel__head">
        <h2>Push</h2>
      </div>
      <div className="panel__body">
        <CeremonyRow
          icon={<IconBell size={16} />}
          label="Push on this device"
          mark={
            on ? { tone: "ok", label: "On" } : { tone: "idle", label: "Off" }
          }
          sub=""
          action={
            <IconKey
              small
              label={
                on
                  ? "Turn off push on this device"
                  : "Turn on push on this device"
              }
              aria-busy={busy || undefined}
              onClick={() => {
                if (!busy) void turn();
              }}
            >
              {on ? <IconX size={16} /> : <IconPlus size={16} />}
            </IconKey>
          }
        />
      </div>
    </section>
  );
}
