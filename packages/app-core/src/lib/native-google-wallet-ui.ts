import type { NativeKeyUi } from "./native-key-types.js";

/** The existing native key form and action surface, with public-only output. */
export const googleWalletUi: NativeKeyUi = {
  name: "Google Wallet",
  methodLabel: "Issuer service account",
  instructions:
    "Add your service account as a Developer on the Google Wallet issuer, then supply its JSON key and an existing Generic pass class. The approved browser connection reaches Google directly; configured native networking is optional. Verification checks that exact class. Prepare a public pass, then choose Save to Google Wallet to open Google's save flow. A prepared link does not mean a pass has been saved.",
  fields: [
    {
      id: "issuer_id",
      label: "Issuer ID",
      kind: "text",
      secret: false,
      required: true,
    },
    {
      id: "class_id",
      label: "Generic class ID",
      kind: "text",
      secret: false,
      required: true,
    },
    {
      id: "origin",
      label: "Presenting HTTPS origin",
      kind: "url",
      secret: false,
      required: true,
    },
    {
      id: "service_account_json",
      label: "Service account JSON key",
      kind: "text",
      secret: true,
      required: true,
    },
  ],
  links: [
    {
      label: "Google Wallet web passes",
      url: "https://developers.google.com/wallet/generic/web",
    },
  ],
  disconnectExplanation:
    "Disconnect forgets this device's issuer key. It does not revoke the service-account key or remove passes saved to Google Wallet.",
  actions: [
    {
      id: "provider.pass.prepare",
      label: "Prepare a Google Wallet pass",
      resultOrigins: ["https://pay.google.com"],
      fields: [
        {
          id: "title",
          label: "Public pass title",
          kind: "text",
          secret: false,
          required: true,
        },
        {
          id: "header",
          label: "Public pass header",
          kind: "text",
          secret: false,
          required: true,
        },
      ],
    },
  ],
};
