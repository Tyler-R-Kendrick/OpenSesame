/**
 * A relying party for a Pages Self-Issued OP, as an Express app (ADR 0161).
 *
 * Copy this file, `callback-page.ts` and `config.ts`. The protocol work is
 * `@opensesame/siop-v2`'s `SiopRelyingParty`; what is left here is routes:
 *
 *   GET  /auth/start       begin a login: remember state + nonce, redirect
 *   GET  <callback path>   the page that reads the URL fragment
 *   POST <callback path>   verify the response and start *your* session
 *
 * The completion POST goes to the same path the page was served from, and the
 * server derives the redirect_uri from that route, so a response that landed on
 * the wrong callback is refused (`redirect_mismatch`) without trusting the page.
 */
import { isString } from "@opensesame/os-domain";
import {
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

export type SiopRpAppOptions = {
  /** What discovery named, when the operator turned it on. */
  authorizationEndpoint?: string | undefined;
  /** Share these across instances: see `SiopLoginStore` / `SiopReplayLedger`. */
  relyingParty?: SiopRelyingParty | undefined;
};

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
    });
  const origin = new URL(config.redirectUri).origin;
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    next();
  });

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

  // The application id is minted by the person's own vault, so a relying
  // party for many people takes it per login: `?client_id=local_<uuid>`. With
  // none, the configured id is used.
  app.get("/auth/start", async (req, res) => {
    const asked = req.query.client_id;
    const clientId = isString(asked) && asked.length > 0 ? asked : undefined;
    try {
      const { authorizationUrl } = await relyingParty.startLogin({ clientId });
      res.redirect(302, authorizationUrl);
    } catch (failure) {
      if (
        failure instanceof SiopRpError &&
        failure.code === "invalid_configuration"
      ) {
        res.status(400).json({ error: "invalid_client_id" });
        return;
      }
      respondRefused(res, failure instanceof Error ? failure : new Error());
    }
  });

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
          // The route that received this response, not a value the page sent.
          receivedRedirectUri: `${origin}${path}`,
        });
        // Your session starts here: set your own cookie for `result.subject`.
        // The subject is the thumbprint of a key the person holds for this
        // application; it proves possession, not an email address or a name.
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
