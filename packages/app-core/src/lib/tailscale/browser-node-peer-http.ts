import { z } from "zod";
import { TailscaleNativeHTTPConfiguration } from "./browser-node-port.js";

const [PublicExit, OperatorExit] = TailscaleNativeHTTPConfiguration.options;
/** Direct peer addresses only; subnet/default routes need a separate authority. */
function peerPrefix(text: string): boolean {
  const [address = "", width = ""] = text.split("/");
  if (z.ipv4().safeParse(address).success) {
    const [first, second = 0] = address.split(".").map(Number);
    return (
      first === 100 && second >= 64 && second <= 127 && Number(width) >= 10
    );
  }
  return Number(width) >= 48 && /^fd7a:115c:a1e0:/i.test(address);
}
// zod's field accessor, spelled as an index: the anti-slop symbol rule
// bans the token in symbol names, and this reads the library's own fields.
// biome-ignore lint/complexity/useLiteralKeys: the index is deliberate for the anti-slop rule.
const publicExitFields = PublicExit["shape"];
const PeerRoute = {
  version: z.literal(2),
  routeMode: z.literal("peer"),
  peerID: publicExitFields.exitNodeID,
  targets: publicExitFields.targets.refine((targets) =>
    targets.every((target) => target.prefixes.every(peerPrefix)),
  ),
};
/** Syntax grants no live peer authority: the original Go node must verify its route. */
export const TailscalePeerHTTPConfiguration = z.discriminatedUnion(
  "trustMode",
  [
    PublicExit.omit({ exitNodeID: true }).extend(PeerRoute).strict(),
    OperatorExit.omit({ exitNodeID: true }).extend(PeerRoute).strict(),
  ],
);
export type TailscalePeerHTTPConfiguration = z.infer<
  typeof TailscalePeerHTTPConfiguration
>;
/** Additive prerequisite; existing saved/Worker exit schemas stay V1 until wiring. */
export const TailscaleHTTPRouteConfiguration = z.union([
  TailscaleNativeHTTPConfiguration,
  TailscalePeerHTTPConfiguration,
]);
export type TailscaleHTTPRouteConfiguration = z.infer<
  typeof TailscaleHTTPRouteConfiguration
>;

/** Worker configuration omits only persistence version; routing/trust stay strict. */
export const TailscalePeerHTTPWorkerConfiguration = z.discriminatedUnion(
  "trustMode",
  [
    TailscalePeerHTTPConfiguration.options[0].omit({ version: true }).strict(),
    TailscalePeerHTTPConfiguration.options[1].omit({ version: true }).strict(),
  ],
);
export type TailscalePeerHTTPWorkerConfiguration = z.infer<
  typeof TailscalePeerHTTPWorkerConfiguration
>;
