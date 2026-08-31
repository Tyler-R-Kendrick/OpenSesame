import { useCallback, useEffect, useState } from "react";
import { ApprovalError, type ChannelKind } from "../lib/approvals.js";
import {
  ASSURANCE_NOTE,
  type ChannelBindingView,
  type ChannelCapabilitiesView,
  type EffectiveRouteView,
  NOTIFICATION_CLASSES,
  type NotificationClass,
  type PreferenceView,
  type PreferencesByClass,
  beginBinding,
  bindingStateSentence,
  capabilitySentence,
  channelName,
  classLabel,
  confidentialitySentence,
  exclusionSentence,
  listBindings,
  listChannels,
  loadEffectiveRoute,
  loadPreferences,
  modeSentence,
  reorder,
  revokeBinding,
  savePreferences,
} from "../lib/notification-settings.js";

/**
 * Where you hear about things — and what that does not buy anyone (ADR 0084).
 *
 * This page is a preference screen with one unusual obligation: it has to keep
 * saying, in the plainest words available, that a preference is only a
 * preference. If a person comes away believing that adding Telegram made
 * Telegram able to approve production access, the screen has done real harm,
 * however accurate its lists were.
 *
 * So the honesty is structural rather than decorative:
 *
 * - the standing note is the first thing on the page and cannot be dismissed;
 * - a channel with no adapter reads as *not set up*, never as an option;
 * - the effective route is fetched from the server, not computed here, and its
 *   exclusions are printed with their reasons. Showing what a person asked for
 *   without showing what the server discarded is the polite kind of lie.
 *
 * Nothing on this page renders a provider secret or a provider subject id. A
 * binding is named by its display label, which is explicitly not authority.
 */

const BINDABLE: readonly ChannelKind[] = [
  "native_push",
  "slack",
  "teams",
  "telegram",
  "wechat",
  "sms",
  "webhook",
];

export function NotificationSettings() {
  const [channels, setChannels] = useState<ChannelCapabilitiesView[] | null>(
    null,
  );
  const [bindings, setBindings] = useState<ChannelBindingView[]>([]);
  const [preferences, setPreferences] = useState<PreferencesByClass>({});
  const [route, setRoute] = useState<EffectiveRouteView | null>(null);
  const [routeClass, setRouteClass] = useState<NotificationClass>(
    "authorization_request",
  );
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const say = useCallback((e: Error) => {
    setError(
      e instanceof ApprovalError
        ? e.message
        : `Something went wrong: ${e.message}`,
    );
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      setChannels(await listChannels());
      setBindings(await listBindings());
      setPreferences(await loadPreferences());
    } catch (e) {
      setChannels([]);
      say(e instanceof Error ? e : new Error(String(e)));
    }
  }, [say]);

  const loadRoute = useCallback(
    async (cls: NotificationClass) => {
      try {
        setRoute(await loadEffectiveRoute(cls));
      } catch (e) {
        setRoute(null);
        say(e instanceof Error ? e : new Error(String(e)));
      }
    },
    [say],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadRoute(routeClass);
  }, [loadRoute, routeClass]);

  async function persist(next: PreferencesByClass, note: string) {
    setBusy("preferences");
    setError(null);
    setStatus(null);
    const previous = preferences;
    setPreferences(next);
    try {
      await savePreferences(next);
      setStatus(note);
      await loadRoute(routeClass);
    } catch (e) {
      // A save that did not land must not leave the screen claiming it did.
      setPreferences(previous);
      say(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setBusy(null);
    }
  }

  /** The inbox is the floor: a class nobody has configured still routes here. */
  function preferenceFor(cls: NotificationClass): PreferenceView {
    return preferences[cls] ?? { channels: ["in_app"], fanOut: false };
  }

  async function move(cls: NotificationClass, index: number, step: -1 | 1) {
    const current = preferenceFor(cls);
    const channelsNext = reorder(current.channels, index, step);
    await persist(
      { ...preferences, [cls]: { ...current, channels: channelsNext } },
      "Order saved.",
    );
  }

  async function toggleChannel(cls: NotificationClass, kind: ChannelKind) {
    const current = preferenceFor(cls);
    const has = current.channels.includes(kind);
    const channelsNext = has
      ? current.channels.filter((c) => c !== kind)
      : [...current.channels, kind];
    await persist(
      { ...preferences, [cls]: { ...current, channels: channelsNext } },
      has ? "Removed from your order." : "Added to your order.",
    );
  }

  async function toggleFanOut(cls: NotificationClass, fanOut: boolean) {
    const current = preferenceFor(cls);
    await persist(
      { ...preferences, [cls]: { ...current, fanOut } },
      fanOut
        ? "Security events will go to every destination that works."
        : "Security events will stop at the first destination that works.",
    );
  }

  async function bind(kind: ChannelKind) {
    setBusy(`bind:${kind}`);
    setError(null);
    setStatus(null);
    try {
      const started = await beginBinding(kind, channelName(kind));
      setPending(
        started.authorizeUrl
          ? `Finish connecting ${channelName(kind)} where it just opened. Until you do, nothing is delivered there.`
          : `${channelName(kind)} is waiting to be confirmed from the other side. Until that happens, nothing is delivered there.`,
      );
      if (started.authorizeUrl) {
        window.open(started.authorizeUrl, "_blank", "noopener,noreferrer");
      }
      setBindings(await listBindings());
    } catch (e) {
      say(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setBusy(null);
    }
  }

  async function unbind(binding: ChannelBindingView) {
    setBusy(`unbind:${binding.id}`);
    setError(null);
    setStatus(null);
    try {
      await revokeBinding(binding.id);
      setBindings(await listBindings());
      setStatus(
        `Disconnected. Nothing else will be delivered to that ${channelName(binding.kind)} destination.`,
      );
      await loadRoute(routeClass);
    } catch (e) {
      say(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel" aria-labelledby="notif-title">
      <div className="badge">Notifications</div>
      <h1 id="notif-title">Where you hear about requests</h1>

      <p className="note">{ASSURANCE_NOTE}</p>

      <section aria-labelledby="notif-channels">
        <h2 id="notif-channels" className="sub">
          Channels this deployment has
        </h2>
        {channels === null ? (
          <output className="lede" aria-busy="true">
            Loading channels…
          </output>
        ) : null}
        <ul className="index">
          {channels?.map((channel) => (
            <li key={channel.kind}>
              <strong>{channelName(channel.kind)}</strong>
              {channel.configured ? "" : " — not set up"}
              <br />
              <span className="fine">{capabilitySentence(channel)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="notif-bindings">
        <h2 id="notif-bindings" className="sub">
          Your destinations
        </h2>
        {bindings.length === 0 ? (
          <p className="fine">
            You have not connected anything yet. Requests still wait for you in
            the OpenSesame inbox — that is where they are decided in any case.
          </p>
        ) : null}
        <ul className="index">
          {bindings.map((binding) => (
            <li key={binding.id} className="row">
              <span>
                <strong>{channelName(binding.kind)}</strong>
                {binding.displayLabel ? ` · ${binding.displayLabel}` : ""}
                <br />
                <span className="fine">
                  {bindingStateSentence(binding.state)}
                </span>
              </span>
              <button
                type="button"
                disabled={busy !== null}
                aria-busy={busy === `unbind:${binding.id}`}
                onClick={() => void unbind(binding)}
              >
                Disconnect
              </button>
            </li>
          ))}
        </ul>
        <div className="actions">
          {BINDABLE.filter((kind) =>
            channels?.some((c) => c.kind === kind && c.configured),
          ).map((kind) => (
            <button
              key={kind}
              type="button"
              disabled={busy !== null}
              aria-busy={busy === `bind:${kind}`}
              onClick={() => void bind(kind)}
            >
              Connect {channelName(kind)}
            </button>
          ))}
        </div>
        {pending ? <output className="ok">{pending}</output> : null}
      </section>

      {NOTIFICATION_CLASSES.map((cls) => {
        const preference = preferenceFor(cls);
        return (
          <section key={cls} aria-labelledby={`notif-order-${cls}`}>
            <h2 id={`notif-order-${cls}`} className="sub">
              {classLabel(cls)}
            </h2>
            <p className="fine">
              Tried in this order. If the first cannot be reached, the next one
              is.
            </p>
            <ul className="index">
              {preference.channels.map((kind, index) => (
                <li key={`${cls}-${kind}`} className="row">
                  <span>
                    {index + 1}. {channelName(kind)}
                  </span>
                  <span className="actions">
                    <button
                      type="button"
                      aria-label={`Move ${channelName(kind)} earlier for ${classLabel(cls)}`}
                      disabled={index === 0 || busy !== null}
                      onClick={() => void move(cls, index, -1)}
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${channelName(kind)} later for ${classLabel(cls)}`}
                      disabled={
                        index === preference.channels.length - 1 ||
                        busy !== null
                      }
                      onClick={() => void move(cls, index, 1)}
                    >
                      Down
                    </button>
                    {kind === "in_app" ? null : (
                      <button
                        type="button"
                        aria-label={`Remove ${channelName(kind)} from ${classLabel(cls)}`}
                        disabled={busy !== null}
                        onClick={() => void toggleChannel(cls, kind)}
                      >
                        Remove
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <div className="actions">
              {(channels ?? [])
                .filter(
                  (channel) =>
                    channel.configured &&
                    !preference.channels.includes(channel.kind),
                )
                .map((channel) => (
                  <button
                    key={`${cls}-add-${channel.kind}`}
                    type="button"
                    aria-label={`Add ${channelName(channel.kind)} to ${classLabel(cls)}`}
                    disabled={busy !== null}
                    onClick={() => void toggleChannel(cls, channel.kind)}
                  >
                    Add {channelName(channel.kind)}
                  </button>
                ))}
            </div>
            {cls === "security_event" ? (
              <label className="confirm" htmlFor="notif-fanout">
                <input
                  id="notif-fanout"
                  type="checkbox"
                  checked={preference.fanOut}
                  disabled={busy !== null}
                  onChange={(e) => void toggleFanOut(cls, e.target.checked)}
                />
                <span>
                  Tell me on every destination that works, not just the first.
                  Sensible for security events; noisy for approvals.
                </span>
              </label>
            ) : null}
          </section>
        );
      })}

      <section aria-labelledby="notif-effective">
        <h2 id="notif-effective" className="sub">
          What would actually happen
        </h2>
        <div className="field">
          <label htmlFor="notif-route-class">Show the route for</label>
          <select
            id="notif-route-class"
            value={routeClass}
            onChange={(e) => {
              const next = NOTIFICATION_CLASSES.find(
                (cls) => cls === e.target.value,
              );
              if (next) setRouteClass(next);
            }}
          >
            {NOTIFICATION_CLASSES.map((cls) => (
              <option key={cls} value={cls}>
                {classLabel(cls)}
              </option>
            ))}
          </select>
        </div>
        {route ? (
          <>
            <ul className="index">
              {route.steps.map((step, index) => (
                <li key={`${step.kind}-${step.mode}`}>
                  {index + 1}. <strong>{channelName(step.kind)}</strong> —{" "}
                  {modeSentence(step.mode)}, and{" "}
                  {confidentialitySentence(step.confidentiality)}.
                </li>
              ))}
            </ul>
            <p className="fine">
              {route.fanOut
                ? "Every step above is used."
                : "Steps below the first are only tried if the one above fails."}
            </p>
            {route.excluded.length > 0 ? (
              <>
                <p className="fine">Not used, and why:</p>
                <ul className="index">
                  {route.excluded.map((entry) => (
                    <li key={`${entry.kind}-${entry.reason}`}>
                      <strong>{channelName(entry.kind)}</strong> —{" "}
                      {exclusionSentence(entry.reason)}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        ) : null}
      </section>

      {status ? <output className="ok">{status}</output> : null}

      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}

      <p className="fine">
        The OpenSesame inbox is always in the route and cannot be turned off. It
        is the surface a decision is actually made on; everything else is a way
        of telling you to go and look at it.
      </p>
    </section>
  );
}
