import { overlapCast } from "@opensesame/os-domain";
import type { KoaContext } from "oidc-provider";

/**
 * The HTML pages oidc-provider draws itself: its error page, the device-flow
 * code entry, confirmation and success pages, and the logout prompt and its
 * success page.
 *
 * The library's own pages each import a Google font, so anyone who opened a
 * device code or logout page, or hit an authorization error, was announced
 * to a third party, and each printed a "you SHOULD change it" notice on first
 * use. These draw the same forms (the provider hands over each form's markup,
 * under the ids its buttons point at), load nothing beyond the page itself,
 * and escape every value they interpolate. The stylesheet is the caller's:
 * the identity plane passes its own, so the pages wear the product skin.
 */

/** The part of Koa's context these pages read and write. */
type PageContext = {
  host: string;
  type: string;
  body: string;
  oidc: { client?: { clientId: string; clientName?: string } };
};

/**
 * What oidc-provider says about an error it shows the browser. It may also
 * carry `state` and `iss`, which are for the client, not the person reading.
 */
export type ErrorDetails = Readonly<{
  error?: string;
  error_description?: string;
}>;

export type ProviderPageOptions = Readonly<{
  /** CSS for every page. It may style `.lede`, `.error`, `.btn`, `.btn-primary`. */
  styles?: string;
}>;

/** Enough to be legible when a caller brings no stylesheet of its own. */
const PLAIN_STYLES = [
  "body{font-family:system-ui,sans-serif;line-height:1.5;margin:0}",
  "main{max-width:32rem;margin:3rem auto;padding:0 1rem}",
  ".lede{color:#555}.error{color:#b00020}",
  ".btn{font:inherit;padding:.5rem 1rem;margin:.25rem .5rem .25rem 0}",
  "code{font-size:1.5em}",
].join("");

const ESCAPES = new Map([
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&#39;"],
]);

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES.get(char) ?? char);
}

function contextOf(ctx: KoaContext): PageContext {
  return overlapCast<KoaContext, PageContext>(ctx);
}

function clientLabel(ctx: PageContext): string | undefined {
  const client = ctx.oidc.client;
  return client?.clientName || client?.clientId;
}

/** Draw a page of `title` and `body` into the response. */
type Draw = (ctx: KoaContext, title: string, body: string) => void;

function drawWith(styles: string): Draw {
  return (ctx, title, body) => {
    const page = contextOf(ctx);
    page.type = "html";
    page.body = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(title)}</title>
  <style>${styles}</style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    ${body}
  </main>
</body>
</html>`;
  };
}

/** An authorization error, as the library describes it to the browser. */
function errorPage(draw: Draw, ctx: KoaContext, out: ErrorDetails): void {
  const code = out.error
    ? `<p><strong>error</strong>: ${escapeHtml(out.error)}</p>`
    : "";
  const detail = out.error_description
    ? `<p>${escapeHtml(out.error_description)}</p>`
    : "";
  draw(
    ctx,
    "Something went wrong",
    `<p class="error" role="alert">This request could not be completed.</p>${code}${detail}`,
  );
}

function codeEntryMessage(err?: { userCode?: string; name?: string }): string {
  if (err?.userCode || err?.name === "NoCodeError") {
    return '<p class="error" role="alert">That code is not right. Try again.</p>';
  }
  if (err?.name === "AbortedError") {
    return '<p class="error" role="alert">The sign-in request was interrupted.</p>';
  }
  if (err) {
    return '<p class="error" role="alert">This request could not be completed.</p>';
  }
  return '<p class="lede">Enter the code shown on your device.</p>';
}

function codeEntryPage(
  draw: Draw,
  ctx: KoaContext,
  form: string,
  err?: { userCode?: string; name?: string },
): void {
  draw(
    ctx,
    "Sign in on a device",
    `${codeEntryMessage(err)}${form}
    <button class="btn btn-primary" type="submit" form="op.deviceInputForm">Continue</button>`,
  );
}

function codeConfirmPage(
  draw: Draw,
  ctx: KoaContext,
  form: string,
  userCode: string,
): void {
  const label = clientLabel(contextOf(ctx)) ?? "An application";
  draw(
    ctx,
    "Confirm the device",
    `<p class="lede"><strong>${escapeHtml(label)}</strong> is asking to sign in. Your device should show this code:</p>
    <p><code>${escapeHtml(userCode)}</code></p>
    <p>If you did not start this, the code does not match, or you do not know the device, abort.</p>
    ${form}
    <button class="btn btn-primary" autofocus type="submit" form="op.deviceConfirmForm">Continue</button>
    <button class="btn" type="submit" form="op.deviceConfirmForm" value="yes" name="abort">Abort</button>`,
  );
}

function deviceSuccessPage(draw: Draw, ctx: KoaContext): void {
  const name = contextOf(ctx).oidc.client?.clientName;
  const through = name ? ` with ${escapeHtml(name)}` : "";
  draw(
    ctx,
    "Signed in",
    `<p class="lede">Your sign-in${through} worked. You can close this page.</p>`,
  );
}

function logoutPage(draw: Draw, ctx: KoaContext, form: string): void {
  const host = escapeHtml(contextOf(ctx).host);
  draw(
    ctx,
    "Sign out",
    `<p class="lede">Sign out of ${host}?</p>
    ${form}
    <button class="btn btn-primary" autofocus type="submit" form="op.logoutForm" value="yes" name="logout">Sign out</button>
    <button class="btn" type="submit" form="op.logoutForm">Stay signed in</button>`,
  );
}

function signedOutPage(draw: Draw, ctx: KoaContext): void {
  const label = clientLabel(contextOf(ctx));
  const from = label ? ` from ${escapeHtml(label)}` : "";
  draw(ctx, "Signed out", `<p class="lede">You signed out${from}.</p>`);
}

/**
 * The hooks oidc-provider calls, in the argument order it calls them with,
 * each drawing with `options.styles`.
 */
export function providerPages(options: ProviderPageOptions = {}) {
  const draw = drawWith(options.styles ?? PLAIN_STYLES);
  return {
    renderError: async (ctx: KoaContext, out: ErrorDetails) =>
      errorPage(draw, ctx, out),
    deviceFlow: {
      userCodeInputSource: async (
        ctx: KoaContext,
        form: string,
        _out: KoaContext,
        err?: { userCode?: string; name?: string },
      ) => codeEntryPage(draw, ctx, form, err),
      userCodeConfirmSource: async (
        ctx: KoaContext,
        form: string,
        _client: KoaContext,
        _deviceInfo: KoaContext,
        userCode: string,
      ) => codeConfirmPage(draw, ctx, form, userCode),
      successSource: async (ctx: KoaContext) => deviceSuccessPage(draw, ctx),
    },
    rpInitiatedLogout: {
      logoutSource: async (ctx: KoaContext, form: string) =>
        logoutPage(draw, ctx, form),
      postLogoutSuccessSource: async (ctx: KoaContext) =>
        signedOutPage(draw, ctx),
    },
  };
}
