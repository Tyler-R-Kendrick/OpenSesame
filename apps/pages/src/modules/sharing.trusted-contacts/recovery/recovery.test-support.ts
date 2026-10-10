/**
 * What the Recovery panel's tests stand on: a circle that is armed, a
 * recipient's device with its own in-memory stores, the contacts' own
 * devices answering with virtual security keys, and the packets that pass
 * between them as text.
 */

import type { Json } from "@opensesame/app-core/lib/quorum/canonical.js";
import { RecoveryBundleSchema } from "@opensesame/app-core/lib/quorum/circle.js";
import {
  type Armed,
  type ArmedOptions,
  Clock,
  type Device,
  armedCircle,
  device,
  who,
} from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import {
  type DeskPorts,
  type RecoveryView,
  approvalsPacket,
  approveRequest,
  ingest,
  releaseShare,
  startRecoveryFlow,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import {
  decodePacket,
  encodePacket,
} from "@opensesame/app-core/lib/quorum/packets.js";
import { isJsonObject, isString } from "@opensesame/os-domain";

export type Recovering = Readonly<{
  clock: Clock;
  armed: Armed;
  recipient: Device;
  started: RecoveryView;
  /** The recovery file the owner saved. */
  bundleText: string;
}>;

/** A circle armed, and a recipient who has raised the request for it. */
export async function recovering(
  options: ArmedOptions = {},
): Promise<Recovering> {
  const clock = new Clock();
  const armed = await armedCircle(clock, options);
  const recipient = device(clock);
  const bundleText = armed.dealt.bundleFile ?? "";
  const started = await startRecoveryFlow(recipient, {
    bundleText,
    recipientLabel: "New laptop",
  });
  return { clock, armed, recipient, started, bundleText };
}

/** What a contact's own device sends back for the request: their approval. */
export function approvalOf(env: Recovering, name: string): Promise<string> {
  return approveRequest(who(env.armed, name), env.started.request);
}

/** What a contact's own device sends back once the delay has passed: their release. */
export function releaseOf(
  env: Recovering,
  name: string,
  approvals: string,
): Promise<string> {
  return releaseShare(who(env.armed, name), {
    request: env.started.request,
    approvals,
  });
}

/** The delay the circle's owner set, and a second more. */
export const AFTER_THE_DELAY = 24 * 3600 + 1;

/** Approvals from `names`, then the delay, as the recipient's desk has them. */
export async function approvedBy(
  env: Recovering,
  names: readonly string[],
): Promise<string> {
  for (const name of names) {
    await ingest(
      env.recipient,
      env.started.requestId,
      await approvalOf(env, name),
    );
  }
  env.clock.at(AFTER_THE_DELAY);
  return approvalsPacket(env.recipient, env.started.requestId);
}

/** A recovery with everything in: approvals, the delay, and releases from `names`. */
export async function released(
  env: Recovering,
  names: readonly string[] = ["Ada", "Cy"],
): Promise<void> {
  const approvals = await approvedBy(env, names);
  for (const name of names) {
    await ingest(
      env.recipient,
      env.started.requestId,
      await releaseOf(env, name, approvals),
    );
  }
}

/** The recipient's secret key as a device's pending store holds it, to prove it is never drawn. */
export async function recipientSecret(
  from: DeskPorts,
  requestId: string,
): Promise<string> {
  const stored = await from.pending.read(`recovery:${requestId}`);
  const key =
    stored !== undefined && isJsonObject(stored)
      ? stored.recipientSecretKey
      : undefined;
  if (key === undefined || !isString(key)) {
    throw new Error("no recipient key stored");
  }
  return key;
}

/** A release with its sealed share damaged, as anyone relaying it could leave it. */
export function damaged(release: string): string {
  const packet = decodePacket(release);
  if (packet.kind !== "release") throw new Error("not a release");
  const { sealed } = packet.value;
  const flipped = sealed.ciphertext.replace(/^./, (c) =>
    c === "A" ? "B" : "A",
  );
  return encodePacket({
    kind: "release",
    value: { ...packet.value, sealed: { ...sealed, ciphertext: flipped } },
  });
}

/** The recovery file with the policy's label changed, so the owner's signature no longer holds. */
export function forged(bundleText: string): string {
  const bundle = RecoveryBundleSchema.parse(JSON.parse(bundleText));
  return JSON.stringify({
    ...bundle,
    signedPolicy: {
      ...bundle.signedPolicy,
      policy: { ...bundle.signedPolicy.policy, label: "Not the owner's" },
    },
  });
}

/** A password inside the recovered document, to prove it is never drawn. */
export const PASSWORD = "hunter2-recovered";

/** A document in the format other managers write, so the vault's own importer recognises it. */
export const CXF: Json = {
  version: 1,
  exporter: "OpenSesame",
  timestamp: 1_772_600_767,
  accounts: [
    {
      id: "acct",
      username: "ada",
      email: "ada@example.com",
      collections: [],
      items: [
        {
          id: "i1",
          creationAt: 1_767_324_245,
          modifiedAt: 1_770_090_306,
          title: "Recovered bank",
          scope: { urls: ["https://bank.example.com"], androidApps: [] },
          credentials: [
            {
              type: "basic-auth",
              username: { fieldType: "email", value: "ada@example.com" },
              password: { fieldType: "concealed-string", value: PASSWORD },
            },
          ],
        },
      ],
    },
  ],
};

/** A blob's text, as the browser's own reader gives it. */
export function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob);
  });
}
