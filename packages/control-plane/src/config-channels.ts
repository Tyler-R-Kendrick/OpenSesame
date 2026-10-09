import {
  type WebPushEnv,
  loadVapidIdentity,
  readVapidPublicKey,
} from "@opensesame/notification-adapters";
import {
  NOTIFICATION_CHANNEL_KINDS,
  type NotificationChannelKind,
} from "@opensesame/os-domain";

/** What the environment decides about notification channels. */
export interface NotificationChannelConfig {
  availableChannels: NotificationChannelKind[];
  pushPublicKey: string;
}

export function parseChannelKinds(
  raw: string | undefined,
  fallback: NotificationChannelKind[],
): NotificationChannelKind[] {
  if (raw === undefined || raw.trim() === "") return [...fallback];
  const wanted = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return NOTIFICATION_CHANNEL_KINDS.filter((kind) => wanted.includes(kind));
}

/**
 * The channels this deployment offers, and the Web Push key browsers subscribe
 * under.
 *
 * `OPENSESAME_NOTIFICATION_CHANNELS` is the operator's list and defaults to
 * the inbox alone. `native_push` joins it by itself when Web Push is fully
 * configured here (public key, private key and contact, all valid and
 * matching): saying "push is not available" next to a working VAPID identity
 * would make the setting something an operator has to know to add. The other
 * adapters stay opt-in.
 *
 * A deployment where only the worker holds the private key lists `native_push`
 * itself, and then needs the public key here, because the enrolment route
 * serves it and a listed channel with no key could never be enrolled. A
 * malformed key, or a private key that does not match, refuses the boot
 * (`WebPushConfigError`).
 */
export function notificationChannelsFromEnv(
  env: WebPushEnv,
): NotificationChannelConfig {
  const listed = parseChannelKinds(env.OPENSESAME_NOTIFICATION_CHANNELS, [
    "in_app",
  ]);
  const pushPublicKey = readVapidPublicKey(env);
  const offersPush = loadVapidIdentity(env) !== undefined;
  const availableChannels =
    offersPush && !listed.includes("native_push")
      ? NOTIFICATION_CHANNEL_KINDS.filter(
          (kind) => kind === "native_push" || listed.includes(kind),
        )
      : listed;
  if (availableChannels.includes("native_push") && !pushPublicKey) {
    throw new Error(
      "native_push is an available notification channel but OPENSESAME_WEBPUSH_PUBLIC_KEY is not set",
    );
  }
  return { availableChannels, pushPublicKey };
}
