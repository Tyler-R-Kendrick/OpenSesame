/**
 * Which transport a ceremony link may use: HTTPS, or plain HTTP against a
 * loopback literal. Shared by the link builder and the link parser
 * (`interaction-url.ts`). Pure: no globals, no network.
 */

/**
 * The three spellings of "this machine".
 *
 * Deliberately literal. `.localhost` subdomains, `10.`/`192.168.`/`172.16.`
 * addresses, `169.254.` link-local, `*.local` mDNS names and tailnet names are
 * all excluded even though a developer might reach a dev server on any of
 * them, because every one of those still puts the link on a wire.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "[::1]",
  "localhost",
]);

/**
 * True for the three host spellings that never leave the machine.
 *
 * **Why the plaintext exception is safe here.** TLS on an interaction link
 * defends against an attacker on the network path: someone who can read or
 * rewrite the bytes between the two devices. For `127.0.0.1` and `[::1]` there
 * is no such path — the kernel loops the packets back without ever reaching an
 * interface — so the threat TLS answers does not exist, and requiring
 * certificates would only push developers toward disabled verification, which
 * is strictly worse.
 *
 * **Where it is not safe.** (1) It is not a "private addresses are fine" rule:
 * `10.0.0.5`, `192.168.1.10`, `169.254.169.254` and a tailnet name all cross a
 * wire and are refused here — see `authenticator-invocation.ts`,
 * whose `privateHost()` refuses that whole range for the same reason from the
 * other direction. (2) `localhost` is a *name*, not an address, and a host
 * whose resolver or hosts file has been tampered with can point it anywhere;
 * it is admitted only because browser cookie scoping and dev tooling depend on
 * it, and it is the weakest of the three. (3) Loopback keeps the link off the
 * network, not away from the machine: any other local process, browser
 * extension, or user on that host can still read it, so this is a
 * developer-workstation affordance and never a production posture.
 */
export function isLoopbackLiteral(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/** HTTPS, or HTTP against a loopback literal (`isLoopbackLiteral`). */
export function isAcceptableTransport(url: URL): boolean {
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackLiteral(url.hostname);
}
