import type { NativeKeyUi } from "./native-key-types.js";

/** What the Let's Encrypt connection form and its two actions draw. */
export function nativeAcmeUi(): NativeKeyUi {
  return {
    name: "Let's Encrypt",
    methodLabel: "ACME account",
    instructions:
      "Creates an ACME account with a key made in this browser and sealed on this device; no key is asked for. Open an order for your DNS names to get the TXT records to publish, then finish it once they resolve: the certificate chain and a new private key come back once and are not kept. Only DNS validation is offered, because a page cannot answer an HTTP request. Use staging while you test; it has far higher limits and issues untrusted certificates.",
    fields: [
      {
        id: "environment",
        label: "Environment",
        kind: "choice",
        secret: false,
        required: true,
        defaultValue: "production",
        choices: [
          { id: "production", label: "Production (trusted certificates)" },
          { id: "staging", label: "Staging (for testing)" },
        ],
      },
      {
        id: "accept_terms",
        label: "Subscriber Agreement",
        kind: "choice",
        secret: false,
        required: true,
        choices: [
          {
            id: "yes",
            label: "I agree to the Let's Encrypt Subscriber Agreement",
          },
        ],
      },
    ],
    links: [
      {
        label: "Let's Encrypt Subscriber Agreement",
        url: "https://letsencrypt.org/repository/",
      },
      {
        label: "Challenge types",
        url: "https://letsencrypt.org/docs/challenge-types/",
      },
      {
        label: "ACME (RFC 8555)",
        url: "https://www.rfc-editor.org/rfc/rfc8555",
      },
    ],
    disconnectExplanation:
      "Disconnect forgets this device's ACME account key. It deactivates nothing at Let's Encrypt, and certificates already issued stay valid until they expire.",
    actions: [
      {
        id: "certificate.issue",
        label: "Open an order and get the DNS records",
        fields: [
          {
            id: "domains",
            label: "DNS names",
            kind: "text",
            secret: false,
            required: true,
            placeholder: "example.com, *.example.com",
          },
        ],
      },
      {
        id: "certificate.finish",
        label: "Finish an order and download the certificate",
        fields: [
          {
            id: "order_url",
            label: "Order address",
            kind: "text",
            secret: false,
            required: true,
            placeholder: "https://acme-v02.api.letsencrypt.org/acme/order/…",
          },
        ],
      },
    ],
  };
}
