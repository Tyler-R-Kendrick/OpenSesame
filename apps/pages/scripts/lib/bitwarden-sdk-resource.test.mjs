import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import {
  isBitwardenSdkResource,
  observeBitwardenSdkResources,
} from "./bitwarden-sdk-resource.mjs";
const origin = "http://localhost:41901";
const base = "/OpenSesame/";
it.each([
  "bitwarden-secrets.worker-ChzlnMRS.js",
  "bitwarden-native.worker-BJ9yEAZF.js",
  "bitwarden_wasm_bg.wasm-B2_HqYUA.gz",
  "native-worker-bitwarden-worker-protocol-c9bedea4-DRh5Ivqv.js",
  "native-worker-bitwarden-native-worker-protocol-f491b626-BtEckadS.js",
  "native-worker-bitwarden-native-contract-4175b124-D49kksSQ.js",
  "native-worker-bitwarden-native-network-protocol-2ec12c2c-bL0AohEk.js",
])("recognizes the emitted worker/WASM/closed-leaf filename %s", (file) => {
  expect(
    isBitwardenSdkResource(`${origin}${base}assets/${file}`, origin, base),
  ).toBe(true);
});
it.each([
  "/OpenSesame/settings/connections/bitwarden-sm",
  "/OpenSesame/assets/not-bitwarden-worker.js",
  "/OpenSesame/assets/bitwarden-secrets.worker.js",
  "/OpenSesame/assets/bitwarden_wasm_bg.wasm-B2_HqYUA.gz/unowned",
  "/other/assets/bitwarden-secrets.worker-ChzlnMRS.js",
  "https://api.bitwarden.test/api/secrets",
  "https://elsewhere.test/OpenSesame/assets/bitwarden-secrets.worker-ChzlnMRS.js",
  "http://localhost:41902/OpenSesame/assets/bitwarden-secrets.worker-ChzlnMRS.js",
  "http://user:pass@localhost:41901/OpenSesame/assets/bitwarden-secrets.worker-ChzlnMRS.js",
])(
  "does not call an app document, provider URL, or unrelated path SDK bytes: %s",
  (path) => {
    expect(isBitwardenSdkResource(new URL(path, origin), origin, base)).toBe(
      false,
    );
  },
);

it.each([
  "bitwarden-secrets.worker-ChzlnMRS.js",
  "bitwarden_wasm_bg.wasm-B2_HqYUA.gz",
])(
  "keeps aborted SDK resource %s fatal while excluding the app document",
  (file) => {
    const context = new EventEmitter();
    const records = [];
    observeBitwardenSdkResources(context, origin, (kind, detail) =>
      records.push({ kind, detail }),
    );
    const sdk = `${origin}${base}assets/${file}`;
    const document = `${origin}${base}settings/connections/bitwarden-sm`;
    for (const url of [sdk, document]) {
      const request = {
        url: () => url,
        failure: () => ({ errorText: "net::ERR_ABORTED" }),
      };
      context.emit("request", request);
      context.emit("requestfailed", request);
    }
    expect(records).toEqual([
      {
        kind: "bws-sdk-resource",
        detail: `${base}assets/${file}`,
      },
      { kind: "worker-network-error", detail: `net::ERR_ABORTED: ${sdk}` },
    ]);
  },
);
