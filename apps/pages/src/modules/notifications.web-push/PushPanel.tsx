/**
 * Settings › General › Push on this device (ADR 0084): the enrolment row the
 * `notifications.web-push` capability brings. One row, one key: turn push on
 * for this browser (the browser asks for the `notifications` permission when,
 * and only when, the key is pressed) or turn it off.
 *
 * It is drawn only where it can act. To turn push on: a browser that can
 * receive push, an Identity API to register with, and a session on it. To turn
 * it off, only the subscription itself: a browser still subscribed keeps the
 * row (and its one key) even with no Identity API or session, because the
 * subscription is the browser's and ends locally; the service is told too when
 * there is one to tell. Otherwise there is nothing to press, so there is no row
 * (ADR 0158) — never a disabled key. A refusal, or a service that could not be
 * told, is a notice in the tray; the row's own mark is the state.
 */

import { kvDelete, kvGet, kvSet } from "@opensesame/app-core/lib/kv.js";
import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import { PUSH_SUBSCRIPTION_KEY } from "@opensesame/app-core/lib/web-push-ledger.js";
import { useEffect, useRef, useState } from "react";
import { useIdentitySession } from "../../bindings/identity.js";
import { IconKey } from "../../components/IconKey.js";
import { IconBell, IconPlus, IconX } from "../../components/Icons.js";
import {
  disablePush,
  enablePush,
  flushPendingForgets,
  keepToForget,
  pushSubscribed,
  pushSupported,
} from "../../lib/push-enrolment.js";
import { useIdentityConfigured } from "../../lib/use-configured.js";
import { CeremonyRow } from "../../sections/settings/CeremonyRow.js";

const NOTICE_ID = "push-on-this-device";
export { PUSH_SUBSCRIPTION_KEY };

type Credentials = { baseUrl: string; accessToken: string } | null;

/**
 * Turn push off (always possible: the subscription is the browser's) or on
 * (needs an Identity API and a session). Resolves to whether it is on after.
 */
async function turnPush(
  on: boolean,
  credentials: Credentials,
): Promise<boolean> {
  if (on) {
    const held = kvGet(PUSH_SUBSCRIPTION_KEY);
    let told = false;
    try {
      told = (
        await disablePush({ ...credentials, subscriptionId: held ?? undefined })
      ).server;
    } finally {
      // Whether or not the service was told (a refusal throws), the browser's
      // subscription is gone and the live slot is empty; an id the service may
      // still list is kept to forget when it can be, never lost.
      kvDelete(PUSH_SUBSCRIPTION_KEY);
      if (!told) keepToForget(held);
    }
    if (!told) {
      setStatusNotice({
        id: NOTICE_ID,
        tone: "warn",
        title: "Push on this device",
        body: "Push is off on this device. The sign-in service was not told, so it may still list it.",
      });
    }
    return false;
  }
  if (credentials === null) return false;
  const stale = kvGet(PUSH_SUBSCRIPTION_KEY);
  const record = await enablePush(credentials);
  // The browser lost the subscription the stored id named (a cleared site, an
  // expired one): the service still lists it. The id is kept to forget before
  // it is overwritten, so a forget that fails is retried, not lost.
  if (stale && record.id && stale !== record.id) keepToForget(stale);
  if (record.id) kvSet(PUSH_SUBSCRIPTION_KEY, record.id);
  await flushPendingForgets(credentials, record.id || null);
  return true;
}

export function PushPanel({ baseUrl }: { baseUrl: () => string }) {
  const configured = useIdentityConfigured();
  const session = useIdentitySession();
  const supported = pushSupported();
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  // State lags a render behind a second press; a ref does not.
  const pressed = useRef(false);
  const live = configured && session !== null && supported;

  useEffect(() => {
    if (!supported) return;
    let current = true;
    void pushSubscribed().then(
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
  }, [supported]);

  // Whenever the row can reach the service, tell it about ids this browser
  // stopped using (a removed capability's subscription, a failed withdrawal).
  const accessToken = session?.accessToken ?? null;
  useEffect(() => {
    if (!live || accessToken === null) return;
    void flushPendingForgets(
      { baseUrl: baseUrl(), accessToken },
      kvGet(PUSH_SUBSCRIPTION_KEY),
    );
  }, [live, accessToken, baseUrl]);

  // Off is drawn only where it can be turned on; On is drawn wherever the
  // browser holds a subscription, so it can always be ended.
  if (on === null || (!on && !live)) return null;

  const turn = async () => {
    if (pressed.current) return;
    pressed.current = true;
    dismissNotice(NOTICE_ID);
    setBusy(true);
    try {
      const credentials =
        live && session !== null
          ? { baseUrl: baseUrl(), accessToken: session.accessToken }
          : null;
      setOn(await turnPush(on, credentials));
    } catch (caught) {
      setStatusNotice({
        id: NOTICE_ID,
        tone: "err",
        title: "Push on this device",
        body: caught instanceof Error ? caught.message : String(caught),
      });
      setOn(await pushSubscribed().catch(() => false));
    } finally {
      pressed.current = false;
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
              onClick={() => void turn()}
            >
              {on ? <IconX size={16} /> : <IconPlus size={16} />}
            </IconKey>
          }
        />
      </div>
    </section>
  );
}
