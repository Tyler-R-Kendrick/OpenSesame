/** Explicit owner-configured receiver DATA, never production authority or a remote-login grant. */
import { z } from "zod";
import { ControlledCanaryHex } from "./controlled-receiver-contract.js";
const schema = z.strictObject({
  endpoint: z.string().min(1).max(200),
  serviceId: ControlledCanaryHex,
  browserOrigin: z.string().min(1).max(300),
  bindPort: z.number().int().min(1).max(65535),
});
export type CanaryReceiverProfile = Readonly<z.infer<typeof schema>>;
function unavailable(): never {
  throw new Error(
    "The controlled canary receiver configuration is unavailable.",
  );
}
function browserOrigin(value: string) {
  if (
    /^chrome-extension:\/\/[a-p]{32}$/u.test(value) ||
    /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      value,
    )
  )
    return;
  const browser = new URL(value);
  if (browser.origin !== value || browser.username || browser.password)
    unavailable();
  if (browser.protocol === "https:") return;
  if (
    browser.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(browser.hostname)
  )
    return;
  unavailable();
}
/** HTTPS is an explicit controlled TLS proxy, never an inferred third-party credential destination. */
export function copyCanaryReceiverProfile(input: CanaryReceiverProfile) {
  return parseCanaryReceiverProfile(input);
}
/** Validate receiver I/O once, before copying bounded destination metadata. */
export function parseCanaryReceiverProfile<Input>(input: Input) {
  const parsed = schema.parse(input);
  const endpoint = new URL(parsed.endpoint);
  if (
    endpoint.origin !== parsed.endpoint ||
    endpoint.username ||
    endpoint.password
  )
    unavailable();
  if (
    endpoint.protocol !== "https:" &&
    !(
      endpoint.protocol === "http:" &&
      endpoint.hostname === "127.0.0.1" &&
      Number(endpoint.port) === parsed.bindPort
    )
  )
    unavailable();
  browserOrigin(parsed.browserOrigin);
  return Object.freeze({ ...parsed });
}
export function controlledCanaryAudience(
  profile: CanaryReceiverProfile,
  commandHash: string,
) {
  ControlledCanaryHex.parse(commandHash);
  return `${profile.endpoint}/v1/agent-canaries/execute#${profile.serviceId}/${commandHash}`;
}
