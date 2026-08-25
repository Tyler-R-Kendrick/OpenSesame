import { FederatedProvidersResponseSchema } from "@opensesame/contracts";
import { Hono } from "hono";
import {
  catalogProviders,
  isBrowserCapable,
} from "../interactions/registry.js";
import type { Variables } from "../middleware/context.js";

export const federatedProviderRoutes = new Hono<{ Variables: Variables }>();

/**
 * The public provider catalog (D7).
 *
 * Unauthenticated on purpose: the Pages PWA's first-run screen and the
 * console's sign-in page render it before anyone has an identity, and a
 * catalog nobody can read is a catalog nobody can sign in from.
 *
 * What it deliberately does not carry: issuers, authorize/token/userinfo
 * endpoints, client ids, secrets or tenant ids. A client needs an id to post
 * back and a label to render; the leg itself runs server-side, where the
 * registry already knows the rest. Publishing the topology of a deployment's
 * upstreams to every visitor would buy nothing and give a prospective attacker
 * the map for free.
 */
federatedProviderRoutes.get("/providers", (c) => {
  const ctx = c.get("ctx");
  const providers = catalogProviders(ctx.config).map((provider) => ({
    id: provider.id,
    label: provider.label,
    kind: provider.kind,
    browserCapable: isBrowserCapable(provider),
  }));
  return c.json(FederatedProvidersResponseSchema.parse({ providers }));
});
