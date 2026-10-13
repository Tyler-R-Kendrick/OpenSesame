/**
 * The ACME exchanges a certificate is made of (RFC 8555), in a browser (ADR
 * 0198): register or find the account, open an order and read the DNS-01
 * records it asks for, then — once the person has published them — answer the
 * challenges, finalize with a request signed here, and download the chain. The
 * certificate's private key is generated in this page, handed over once, and
 * kept nowhere. Only DNS-01 is offered: a page cannot answer an HTTP request.
 */
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { buildCsr, isCertificateName } from "./native-acme-csr.js";
import {
  type AcmeAccountKey,
  type AcmeClient,
  type AcmeEnvironment,
  acmeDnsTxtValue,
  acmeObject,
  acmeOwn,
} from "./native-acme-protocol.js";
import { NativeApiError } from "./native-api-http.js";
import { bytesToBase64, bytesToBase64Url } from "./native-base64.js";

export const MAX_ACME_NAMES = 20;
const POLLS = 20;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const CHAIN =
  /^(?:-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----\r?\n?){1,8}$/;

const REJECTED =
  "Let's Encrypt rejected this order, usually because a DNS record was not found in time. Publish the TXT records, wait for them to appear, then start again with Issue.";
const WAITING =
  "Let's Encrypt has not finished checking yet. Try Finish again in a minute.";
const FINISHED =
  "That order has already been finished or was interrupted, and its private key is shown only once. Start a new order with Issue.";

export type AcmeRecord = { name: string; value: string };

export type AcmeWait = (ms: number) => Promise<void>;

const pause: AcmeWait = (ms) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The account URL for this key, created on first use and found again after: the same call does both. */
export async function registerAcmeAccount(client: AcmeClient): Promise<string> {
  const reply = await client.post(
    client.directory.newAccount,
    { termsOfServiceAgreed: true },
    { kind: "jwk" },
  );
  const location = reply.location;
  if (
    !client.own(location) ||
    !/^\/acme\/acct\/\d{1,20}$/.test(new URL(location).pathname)
  )
    throw new NativeApiError("response");
  if (acmeObject(reply).status !== "valid")
    throw new NativeApiError("authorization");
  return location;
}

/** An order address is the CA's own and has the shape the CA gives orders. */
export function isAcmeOrderUrl(
  environment: AcmeEnvironment,
  value: BoundaryValue | undefined,
): value is string {
  return (
    acmeOwn(environment)(value) &&
    /^\/acme\/order\/\d{1,20}\/\d{1,20}$/.test(new URL(value).pathname)
  );
}

function urls(
  client: AcmeClient,
  value: BoundaryValue | undefined,
  max: number,
) {
  if (!Array.isArray(value) || !value.length || value.length > max)
    throw new NativeApiError("response");
  return value.map((entry) => {
    if (!client.own(entry)) throw new NativeApiError("response");
    return entry;
  });
}

/** The one DNS-01 challenge an authorization offers. */
function dnsChallenge(authorization: Record<string, BoundaryValue>) {
  const list = Array.isArray(authorization.challenges)
    ? authorization.challenges
    : [];
  for (const entry of list) {
    if (isJsonObject(entry) && entry.type === "dns-01") return entry;
  }
  throw new NativeApiError("response");
}

/** Opens an order and reads off the TXT records that would prove control of each name. */
export async function beginAcmeOrder(
  client: AcmeClient,
  key: AcmeAccountKey,
  account: string,
  names: readonly string[],
) {
  const who = { kind: "kid", url: account } as const;
  const reply = await client.post(
    client.directory.newOrder,
    { identifiers: names.map((value) => ({ type: "dns", value })) },
    who,
  );
  const orderUrl = reply.location;
  if (!isAcmeOrderUrl(client.environment, orderUrl))
    throw new NativeApiError("response");
  const order = acmeObject(reply);
  const records: AcmeRecord[] = [];
  const alreadyValid: string[] = [];
  for (const url of urls(client, order.authorizations, names.length)) {
    const authorization = acmeObject(await client.post(url, null, who));
    const identifier = isJsonObject(authorization.identifier)
      ? authorization.identifier.value
      : undefined;
    if (!isString(identifier) || !isCertificateName(identifier))
      throw new NativeApiError("response");
    if (authorization.status === "valid") {
      alreadyValid.push(identifier);
      continue;
    }
    if (authorization.status !== "pending")
      throw new NativeApiError("response");
    const token = dnsChallenge(authorization).token;
    if (!isString(token) || !TOKEN.test(token))
      throw new NativeApiError("response");
    records.push({
      name: `_acme-challenge.${identifier}`,
      value: await acmeDnsTxtValue(token, key),
    });
  }
  return { orderUrl, records, alreadyValid };
}

/** Tell the CA each pending challenge is ready to be checked; one that is already being checked is left alone. */
async function answerChallenges(
  client: AcmeClient,
  account: string,
  order: Record<string, BoundaryValue>,
) {
  const who = { kind: "kid", url: account } as const;
  for (const url of urls(client, order.authorizations, MAX_ACME_NAMES)) {
    const authorization = acmeObject(await client.post(url, null, who));
    if (authorization.status === "valid") continue;
    if (authorization.status !== "pending") throw new Error(REJECTED);
    const challenge = dnsChallenge(authorization);
    if (challenge.status !== "pending") continue;
    if (!client.own(challenge.url)) throw new NativeApiError("response");
    await client.post(challenge.url, {}, who);
  }
}

/** Reads the order until it reaches a status the caller wants; an order the CA gave up on ends the wait. */
async function awaitOrder(
  client: AcmeClient,
  account: string,
  orderUrl: string,
  wanted: string,
  wait: AcmeWait,
): Promise<Record<string, BoundaryValue>> {
  for (let poll = 0; poll < POLLS; poll += 1) {
    const reply = await client.post(orderUrl, null, {
      kind: "kid",
      url: account,
    });
    const order = acmeObject(reply);
    if (order.status === "invalid") throw new Error(REJECTED);
    if (order.status === wanted) return order;
    await wait(reply.retryAfterMs ?? 2000);
  }
  throw new Error(WAITING);
}

function lines(bytes: Uint8Array, label: string): string {
  const body =
    bytesToBase64(bytes)
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** Finishes an order the person opened: the chain, and the key generated for it, for one display. */
export async function finishAcmeOrder(
  client: AcmeClient,
  account: string,
  orderUrl: string,
  wait: AcmeWait = pause,
) {
  const who = { kind: "kid", url: account } as const;
  let order = acmeObject(await client.post(orderUrl, null, who));
  if (order.status === "invalid") throw new Error(REJECTED);
  if (["valid", "processing"].includes(String(order.status)))
    throw new Error(FINISHED);
  if (order.status === "pending") {
    await answerChallenges(client, account, order);
    order = await awaitOrder(client, account, orderUrl, "ready", wait);
  } else if (order.status !== "ready") {
    throw new NativeApiError("response");
  }
  const identifiers = Array.isArray(order.identifiers) ? order.identifiers : [];
  const names = identifiers.map((entry) =>
    isJsonObject(entry) ? entry.value : undefined,
  );
  if (
    !names.length ||
    names.length > MAX_ACME_NAMES ||
    !names.every(
      (name): name is string => isString(name) && isCertificateName(name),
    ) ||
    !client.own(order.finalize)
  )
    throw new NativeApiError("response");
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const csr = await buildCsr(names, keys);
  await client.post(order.finalize, { csr: bytesToBase64Url(csr) }, who);
  const done = await awaitOrder(client, account, orderUrl, "valid", wait);
  if (!client.own(done.certificate)) throw new NativeApiError("response");
  const download = await client.post(
    done.certificate,
    null,
    who,
    "application/pem-certificate-chain",
  );
  if (!CHAIN.test(download.text)) throw new NativeApiError("response");
  return {
    chain: download.text,
    privateKey: lines(
      new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey)),
      "PRIVATE KEY",
    ),
  };
}
