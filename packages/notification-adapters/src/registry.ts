/**
 * The set of adapters a deployment actually has.
 *
 * `availableChannels()` is the input `planNotificationRoute` calls
 * `availableChannels`, and it lists only the channels whose operator
 * configuration is present and well-formed. That is why `isConfigured()`
 * exists at all: without it the router cannot distinguish "the person did
 * not choose Slack" from "Slack is not set up", and the settings screen ends
 * up claiming a channel works because somebody typed its name into a config
 * file. The domain reports the difference as `adapter_unavailable`, and this
 * is where that fact comes from.
 *
 * `in_app` is always in the list and has no adapter here. The durable inbox
 * is not a delivery integration — it is the surface every other channel
 * points at, it cannot be turned off, and a deployment whose every external
 * channel is broken must still be able to show a person what is waiting.
 */

import type { NotificationChannelKind } from "@opensesame/os-domain";
import { NOTIFICATION_CHANNEL_KINDS } from "@opensesame/os-domain";

import {
  type GenericWebhookConfig,
  createGenericWebhookAdapter,
} from "./adapters/generic-webhook.js";
import { type SlackConfig, createSlackAdapter } from "./adapters/slack.js";
import { type SmsConfig, createSmsAdapter } from "./adapters/sms.js";
import { type TeamsConfig, createTeamsAdapter } from "./adapters/teams.js";
import {
  type TelegramConfig,
  createTelegramAdapter,
} from "./adapters/telegram.js";
import {
  type WebPushConfig,
  createWebPushAdapter,
} from "./adapters/web-push.js";
import { type WeChatConfig, createWeChatAdapter } from "./adapters/wechat.js";
import type { ChannelAdapter } from "./contract.js";

export interface AdapterRegistryConfig {
  slack?: SlackConfig;
  telegram?: TelegramConfig;
  teams?: TeamsConfig;
  wechat?: WeChatConfig;
  sms?: SmsConfig;
  webPush?: WebPushConfig;
  webhook?: GenericWebhookConfig;
}

export interface AdapterRegistry {
  /** Every adapter that was constructed, configured or not. */
  adapters: readonly ChannelAdapter[];
  get(kind: NotificationChannelKind): ChannelAdapter | undefined;
  /** Channels a route may actually use, in catalogue order. */
  availableChannels(): NotificationChannelKind[];
}

export function createAdapterRegistry(
  config: AdapterRegistryConfig,
): AdapterRegistry {
  const adapters: ChannelAdapter[] = [];
  // Only construct what the operator supplied. An adapter built from an
  // absent config would be an adapter reporting `unconfigured` at delivery
  // time, one round trip and one failed row later than necessary.
  if (config.slack) adapters.push(createSlackAdapter(config.slack));
  if (config.telegram) adapters.push(createTelegramAdapter(config.telegram));
  if (config.teams) adapters.push(createTeamsAdapter(config.teams));
  if (config.wechat) adapters.push(createWeChatAdapter(config.wechat));
  if (config.sms) adapters.push(createSmsAdapter(config.sms));
  if (config.webPush) adapters.push(createWebPushAdapter(config.webPush));
  if (config.webhook) {
    adapters.push(createGenericWebhookAdapter(config.webhook));
  }

  const byKind = new Map<NotificationChannelKind, ChannelAdapter>();
  for (const adapter of adapters) byKind.set(adapter.kind, adapter);

  return {
    adapters,
    get: (kind) => byKind.get(kind),
    availableChannels: () =>
      NOTIFICATION_CHANNEL_KINDS.filter((kind) => {
        if (kind === "in_app") return true;
        return byKind.get(kind)?.isConfigured() ?? false;
      }),
  };
}
