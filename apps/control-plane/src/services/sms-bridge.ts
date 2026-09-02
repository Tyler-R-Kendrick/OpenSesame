import {
  type ChannelAdapter,
  createSmsAdapter,
} from "@opensesame/notification-adapters";

/**
 * The deployment's text-message sender.
 *
 * Built on the same SMS adapter the notification router uses, so an operator
 * configures one bridge, once: `OPENSESAME_SMS_BRIDGE_URL` (an HTTPS endpoint
 * they run) and `OPENSESAME_SMS_BRIDGE_SECRET` (a Standard Webhooks signing
 * secret). Nothing here talks to a carrier; the bridge does, with the
 * operator's own credential. Unset, the adapter's `isConfigured()` is false
 * and a request to send a text is refused before anything is built.
 */
export function createSmsBridge(env: NodeJS.ProcessEnv): ChannelAdapter {
  const bridgeUrl = env.OPENSESAME_SMS_BRIDGE_URL?.trim();
  const bridgeSecret = env.OPENSESAME_SMS_BRIDGE_SECRET?.trim();
  const senderId = env.OPENSESAME_SMS_SENDER_ID?.trim();
  return createSmsAdapter({
    ...(bridgeUrl ? { bridgeUrl } : undefined),
    ...(bridgeSecret ? { bridgeSecret } : undefined),
    ...(senderId ? { senderId } : undefined),
  });
}
