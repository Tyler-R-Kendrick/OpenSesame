# @opensesame/browser-extension-bridge

The **optional** companion extension that lets the OpenSesame app read a
provider's answer when the provider's servers refuse web pages
([ADR 0199](../../docs/adr/0199-connector-bridge-extension.md)). It is the
road for the API-key providers whose key check a page cannot read (SendGrid,
Postmark, Datadog, Cloudflare, Resend, Plivo, a number of hosted-model gateways,
… the list is generated from [`spec/connectors/browser-policy.json`](../../spec/connectors/browser-policy.json)).

It is also the road for a person's **own OAuth application** with a provider whose
token, account or revocation endpoint a page cannot read (Box, HubSpot, Notion,
Salesforce, Zoom, X, …, and a tenant host for Okta, Auth0, Databricks, Shopify,
Workday and BambooHR): the client secret stays sealed in the person's vault and is
sent only to those hosts, through this extension, which keeps nothing
([ADR 0217](../../docs/adr/0217-registered-oauth-applications-and-the-bridge.md);
the list is generated from [`spec/connectors/oauth-reach.json`](../../spec/connectors/oauth-reach.json)).

It is never part of the default extension ([`apps/browser-extension`](../browser-extension)),
never installed unless a person installs it, and does nothing until they switch
it on for the app's origin. A person who does not install it carries none of
this code, and the app says so on each provider it would help with.

## What it can and cannot do

| | |
|---|---|
| **Manifest** | `storage`, `scripting`, `activeTab`, `declarativeNetRequestWithHostAccess`. **No `content_scripts`. No `host_permissions`**: every host is an `optional_host_permissions` entry the popup asks the browser for, one host at a time, on the person's own click. |
| **Switching an origin on** | The popup's switch asks the browser for the tab's origin and registers the relay content script for that origin only (`scripting.registerContentScripts`, top frame only). Switching off unregisters it and gives the grant back. A grant taken back in the browser's own settings switches it off here too. |
| **Allowing a host** | A page can only *ask* (`need`): the bridge records the ask and lights its badge. The popup lists the asked hosts with the providers that use them; allowing one is the browser's own permission prompt. A host the generated table does not name cannot be allowed at all. A tenant (`acme.okta.com`) is named only by a `*.suffix` family the table gives to that provider, with at least one plain DNS label in front; `okta.com`, `evilokta.com` and `acme.okta.com.evil.test` are not under `*.okta.com`. |
| **A request** | HTTPS to a table host for the provider the page names; a closed set of methods; no body on GET/HEAD; no `Cookie`, `Host`, `Origin`, `Referer`, `Proxy-*` or `Sec-*` header; `credentials: "omit"`; a redirect is refused, never followed; 256 KiB out, 1 MiB back, 20 s; UTF-8 text only. Cookies the provider sets are not passed back. |
| **No `Origin`** | A session rule removes the `Origin` header from this extension's own requests to granted hosts, so a request is the plain-client request the key checks were established with (Chromium would otherwise add `chrome-extension://…` to a POST, and a few providers answer an origin they do not know with an error). It acts only on hosts a person granted. |
| **Who is answered** | A relayed message only when the browser says it came from this extension's relay, in the top frame of a tab, at an origin that is switched on right now. A popup message only from an extension page. |
| **What it keeps** | The list of hosts a page asked for and has not been answered. Never a key, a request or a response. |

An origin a person switched on can ask the bridge to send a key *that origin
supplies* to a host the person allowed. That is no authority the origin did
not have: the bridge adds a way to read an answer, not a way to obtain a key.

## Build and install

```bash
pnpm --filter @opensesame/browser-extension-bridge build   # .output/chrome-mv3/
pnpm --filter @opensesame/browser-extension-bridge zip
```

Load `.output/chrome-mv3/` as an unpacked extension (Chrome: `chrome://extensions`
→ Developer mode → Load unpacked). Then, in the app, open a provider the bridge
helps with, open the extension's popup on the app's tab, switch the site on and
allow the host the page asked for.

## Tests

```bash
pnpm --filter @opensesame/browser-extension-bridge test        # unit: decisions, ports, popup
pnpm --filter @opensesame/browser-extension-bridge typecheck
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  pnpm --filter @opensesame/browser-extension-bridge test:e2e  # a real Chromium, the built extension
```

The end-to-end test starts a provider that answers with no CORS header (a page
cannot read it), proves the page then reads the answer through the bridge with
the switch on and the host allowed, and records what the provider received: the
key the page sent, no cookie and no `Origin`. It also proves a host nobody
allowed, a host the table does not name, a cookie header, plain HTTP, a body on
a GET and a redirect are refused with nothing sent, and that another origin, or
this one switched off, gets no answer.
