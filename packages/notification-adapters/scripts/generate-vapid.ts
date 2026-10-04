/**
 * Generate a VAPID application server key pair for Web Push (RFC 8292).
 *
 *   pnpm --filter @opensesame/notification-adapters generate:vapid [contact]
 *
 * Prints the three environment lines the Identity API and the identity worker
 * read (see `src/webpush-env.ts`). The private key goes to stdout because that
 * is where an operator pipes it into a secret store; a reminder goes to stderr
 * so it never lands in the file. Run it once: replacing the pair invalidates
 * every browser subscription made under the old public key.
 */

import { generateVapidKeyPair } from "../src/adapters/web-push-vapid.js";
import {
  WEBPUSH_PRIVATE_KEY_ENV,
  WEBPUSH_PUBLIC_KEY_ENV,
  WEBPUSH_SUBJECT_ENV,
} from "../src/webpush-env.js";

const contact = process.argv[2] ?? "mailto:ops@example.invalid";
const { publicKey, privateKey } = generateVapidKeyPair();

process.stdout.write(
  [
    `${WEBPUSH_PUBLIC_KEY_ENV}=${publicKey}`,
    `${WEBPUSH_PRIVATE_KEY_ENV}=${privateKey}`,
    `${WEBPUSH_SUBJECT_ENV}=${contact}`,
    "",
  ].join("\n"),
);
process.stderr.write(
  `Keep ${WEBPUSH_PRIVATE_KEY_ENV} secret (the Identity API only needs the public key). Replacing this pair invalidates every existing browser subscription.\n`,
);
