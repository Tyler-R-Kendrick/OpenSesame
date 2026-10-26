/** Active webhook registrations admitted atomically by the repository. */
export const MAX_WEBHOOK_ENDPOINTS_PER_PRINCIPAL = 10;

export class WebhookEndpointLimitError extends Error {
  override readonly name = "WebhookEndpointLimitError";
}
