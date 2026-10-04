/**
 * A relying party for a Pages Self-Issued OP, as an Express app (ADR 0161).
 *
 * Copy this file, `callback-page.ts`, `rate-limit.ts` and `config.ts`. The
 * protocol work is `@opensesame/siop-v2`'s `SiopRelyingParty`; what is left
 * here is routes:
 *
 *   GET  /auth/start       begin a login: remember state + nonce, hand this
 *                          browser its binding cookie, redirect
 *   GET  <callback path>   the page that reads the URL fragment
 *   POST <callback path>   verify the response and start *your* session
 *
 * Two things keep a response with the wrong browser or the wrong address from
 * signing anyone in. The binding cookie (`__Host-`, HttpOnly, SameSite=Lax) is
 * the browser's half of the login: a response somebody else obtained, planted
 * in a victim's browser, arrives without it. And the redirect_uri a response
 * is checked against is built from the *request the server received*, path and
 * query, never from anything the page says about itself.
 */
import { isString } from "@opensesame/os-domain";
import {
  MemoryLoginStore,
  type SiopLoginResult,
  type SiopRelyingParty,
  SiopRpError,
  createSiopRelyingParty,
  isSiopV2Error,
} from "@opensesame/siop-v2";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  CALLBACK_SCRIPT,
  EXAMPLE_CSS,
  callbackHtml,
  indexHtml,
} from "./callback-page.js";
import { type SiopRpConfig, issuerOf } from "./config.js";
import { StartRateLimit } from "./rate-limit.js";

export type SiopRpAppOptions = {
  /** What discovery named, when the operator turned it on. */
  authorizationEndpoint?: string | undefined;
  /** Share these across instances: see `SiopLoginStore` / `SiopReplayLedger`. */
  relyingParty?: SiopRelyingParty | undefined;
  /** A test seam for the rate limit's clock. */
  now?: (() => number) | undefined;
};

const BINDING_COOKIE = "__Host-siop_binding";
const BINDING_MAX_AGE_SECONDS = 600;

/** What the page is told: a stable code, never a message and never the token. */
function refusalCode(failure: Error): string {
  if (failure instanceof SiopRpError) return failure.code;
  if (isSiopV2Error(failure)) return failure.code;
  return "unavailable";
}

function respondRefused(res: Response, failure: Error): void {
  const code = refusalCode(failure);
  res.status(code === "unavailable" ? 500 : 401).json({ error: code });
}

function sessionBody(result: SiopLoginResult) {
  return {
    session: {
      subject: result.subject,
      issuer: result.verified.iss,
      audience: result.verified.aud,
    },
  };
}

function responseFrom(req: Request): string | null {
  const response = req.body?.response;
  if (!isString(response) || response.length === 0) return null;
  return response;
}

/**
 * The binding as a cookie only this browser holds. `__Host-` pins it to this
 * exact host, over https, at path `/`; HttpOnly keeps script (including this
 * page's own) from reading it; SameSite=Lax keeps it off cross-site requests
 * other than the top-level navigation the redirect back is.
 */
function bindingCookie(value: string, maxAge: number): string {
  return `${BINDING_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function bindingFrom(req: Request): string {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === BINDING_COOKIE) return value.join("=");
  }
  return "";
}

/**
 * Headers on every answer. `form-action` names this server and the Pages
 * deployment: a browser checks a form's *redirect* target against it, so the
 * sign-in form's 302 to Pages is blocked by `'none'` or by `'self'` alone.
 */
function pageHeaders(pagesOrigin: string) {
  const policy = `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self' ${pagesOrigin}; frame-ancestors 'none'`;
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-security-policy", policy);
    next();
  };
}

type StartDeps = {
  relyingParty: SiopRelyingParty;
  limit: StartRateLimit;
  redirectFor: Map<string, string>;
};

/** What `startLogin` refusing means to the visitor, as a status and a code. */
function refusalOfStart(
  failure: Error,
): { status: number; error: string } | null {
  if (!(failure instanceof SiopRpError)) return null;
  if (failure.code === "capacity_exceeded")
    return { status: 503, error: "busy" };
  if (failure.code === "invalid_configuration")
    return { status: 400, error: "invalid_client_id" };
  return null;
}

/**
 * The application id is minted by the person's own vault, so a relying party
 * for many people takes it per login: `?client_id=local_<uuid>`. A second
 * registered callback is chosen the same way: `?callback=/path`.
 */
function startRoute({ relyingParty, limit, redirectFor }: StartDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    if (!limit.allow(req.ip ?? "unknown")) {
      res.setHeader("retry-after", "60");
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    const asked = req.query.client_id;
    const clientId = isString(asked) && asked.length > 0 ? asked : undefined;
    const path = req.query.callback;
    const redirectUri =
      isString(path) && path.length > 0 ? redirectFor.get(path) : undefined;
    if (isString(path) && path.length > 0 && redirectUri === undefined) {
      res.status(400).json({ error: "invalid_callback" });
      return;
    }
    try {
      const started = await relyingParty.startLogin({ clientId, redirectUri });
      res.setHeader(
        "set-cookie",
        bindingCookie(started.binding, BINDING_MAX_AGE_SECONDS),
      );
      res.redirect(302, started.authorizationUrl);
    } catch (failure) {
      const error = failure instanceof Error ? failure : new Error();
      const refused = refusalOfStart(error);
      if (refused === null) {
        respondRefused(res, error);
        return;
      }
      if (refused.status === 503) res.setHeader("retry-after", "30");
      res.status(refused.status).json({ error: refused.error });
    }
  };
}

/** The redirect URI each callback path was registered as. */
function redirectsByPath(config: SiopRpConfig): Map<string, string> {
  return new Map(
    config.callbackPaths.map((path, index) => [
      path,
      config.redirectUris[index] ?? config.redirectUri,
    ]),
  );
}

export function createSiopRpApp(
  config: SiopRpConfig,
  options: SiopRpAppOptions = {},
): Express {
  const relyingParty =
    options.relyingParty ??
    createSiopRelyingParty({
      issuer: issuerOf(config),
      authorizationEndpoint: options.authorizationEndpoint,
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      allowedRedirectUris: config.redirectUris,
      allowLoopbackHttp: config.allowLoopbackHttp,
      store: new MemoryLoginStore(config.maxPendingLogins),
    });
  const origin = new URL(config.redirectUri).origin;
  // The pages and endpoints a form may submit to: this server, and the Pages
  // deployment its 302 sends the browser on to (a form's redirect is checked
  // against `form-action` too).
  const pagesOrigin = new URL(issuerOf(config)).origin;
  const redirectFor = redirectsByPath(config);
  const limit = new StartRateLimit(config.startsPerMinute, options.now);
  const app = express();
  app.disable("x-powered-by");
  app.use(pageHeaders(pagesOrigin));

  app.get("/", (_req, res) => {
    res.type("html").send(
      indexHtml({
        pagesBase: config.pagesBase,
        clientId: config.clientId,
        redirectUri: config.redirectUri,
      }),
    );
  });
  app.get("/example.css", (_req, res) => {
    res.type("css").send(EXAMPLE_CSS);
  });
  app.get("/siop-callback.js", (_req, res) => {
    res.type("js").send(CALLBACK_SCRIPT);
  });

  app.get("/auth/start", startRoute({ relyingParty, limit, redirectFor }));

  const json = express.json({ limit: "20kb", type: "application/json" });
  for (const path of config.callbackPaths) {
    app.get(path, (_req, res) => {
      res.type("html").send(callbackHtml());
    });
    app.post(path, json, async (req, res) => {
      const response = responseFrom(req);
      if (response === null) {
        res.status(400).json({ error: "malformed_request" });
        return;
      }
      try {
        const result = await relyingParty.completeLogin({
          response,
          binding: bindingFrom(req),
          // The address this server was asked at, query included: not a
          // value the page sent.
          receivedRedirectUri: `${origin}${req.originalUrl}`,
        });
        // Your session starts here: set your own cookie for `result.subject`.
        // The subject is the thumbprint of a key the person holds for this
        // application; it proves possession, not an email address or a name.
        res.setHeader("set-cookie", bindingCookie("", 0));
        res.json(sessionBody(result));
      } catch (failure) {
        respondRefused(res, failure instanceof Error ? failure : new Error());
      }
    });
  }
  // A body that is not JSON, or is too large, is a malformed request, not a stack trace.
  app.use(
    (_failure: Error, _req: Request, res: Response, _next: NextFunction) => {
      res.status(400).json({ error: "malformed_request" });
    },
  );
  return app;
}
