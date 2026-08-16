/**
 * OpenSesame static-site client — Shoo-comparable benefit without a backend.
 *
 * Opens the Pages broker popup, receives an upstream id_token via postMessage
 * (ADR 0034). Does not exchange codes against OpenSesame; OpenSesame has no
 * token endpoint on static hosting.
 *
 * Declarative (default):
 *   <script src="https://…/OpenSesame/opensesame.js" defer></script>
 *   <button type="button" data-opensesame-signin>Sign in</button>
 *   window.addEventListener("opensesame:signed_in", (e) => { … e.detail … });
 *
 * Or a plain authorize link (auto-wired unless data-opensesame-auto-links="false"):
 *   <a href="https://…/OpenSesame/broker/authorize?client_id=origin:…&origin=…&scope=openid">Sign in</a>
 *
 * Explicit:
 *   OpenSesame.signIn().then((session) => …)
 *   OpenSesame.signInAndAccept().then(({ session, claims, subject }) => …)
 *   OpenSesame.acceptSession(session) // JWKS verify + pairwise subject
 *
 * Script dataset:
 *   data-opensesame-broker, data-opensesame-scope, data-opensesame-storage-key
 *   data-opensesame-auto-bind="false"   — disable [data-opensesame-signin]
 *   data-opensesame-auto-links="false"  — disable authorize-link interception
 *   data-opensesame-verify="true"       — acceptSession before signed_in on auto-bind
 */
(function () {
  if (typeof window === "undefined") return;

  var scriptEl = document.currentScript;
  var dataset = scriptEl && scriptEl.dataset ? scriptEl.dataset : {};
  var scriptSrc = scriptEl && scriptEl.src ? scriptEl.src : "";

  function parseBoolean(value) {
    return value === true || value === "true" || value === "1" || value === "yes";
  }

  function brokerBaseFromScript() {
    try {
      if (scriptSrc) {
        var u = new URL(scriptSrc, window.location.href);
        var path = u.pathname.replace(/\/?opensesame\.js$/i, "/");
        return u.origin + path;
      }
    } catch (_e) {
      /* fall through */
    }
    return "https://tyler-r-kendrick.github.io/OpenSesame/";
  }

  var defaults = {
    brokerBase: dataset.opensesameBroker || brokerBaseFromScript(),
    storageKey: dataset.opensesameStorageKey || "opensesame_static_session",
    scope: dataset.opensesameScope || "openid",
    autoBind: dataset.opensesameAutoBind !== "false",
    autoLinks: dataset.opensesameAutoLinks !== "false",
    verifyOnBind: parseBoolean(dataset.opensesameVerify),
  };

  function randomState() {
    var bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    var binary = "";
    for (var i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function normalizeBase(base) {
    if (typeof base !== "string" || !base) return defaults.brokerBase;
    return base.endsWith("/") ? base : base + "/";
  }

  function brokerOriginFromBase(base) {
    return new URL(normalizeBase(base)).origin;
  }

  function expectedAudience(options) {
    if (options && typeof options.audience === "string" && options.audience) {
      return options.audience;
    }
    var base = (options && options.brokerBase) || defaults.brokerBase;
    return "origin:" + brokerOriginFromBase(base);
  }

  function authorizeUrl(options) {
    var base = normalizeBase(options && options.brokerBase);
    var origin = (options && options.origin) || window.location.origin;
    var state = (options && options.state) || randomState();
    var scope = (options && options.scope) || defaults.scope;
    var url = new URL("broker/authorize", base);
    url.searchParams.set("client_id", "origin:" + origin);
    url.searchParams.set("origin", origin);
    url.searchParams.set("state", state);
    url.searchParams.set("scope", scope);
    if (options && options.redirectUri) {
      url.searchParams.set("redirect_uri", options.redirectUri);
    }
    return { url: url.toString(), state: state };
  }

  function parseJson(value) {
    try {
      return JSON.parse(value);
    } catch (_e) {
      return null;
    }
  }

  function persistSession(session, storageKey) {
    try {
      sessionStorage.setItem(storageKey || defaults.storageKey, JSON.stringify(session));
    } catch (_e) {
      /* private mode */
    }
  }

  function getSession(storageKey) {
    try {
      var raw = sessionStorage.getItem(storageKey || defaults.storageKey);
      if (!raw) return null;
      var session = parseJson(raw);
      if (!session || typeof session.id_token !== "string") return null;
      if (session.expires_at && Date.parse(session.expires_at) <= Date.now()) {
        clearSession(storageKey);
        return null;
      }
      return session;
    } catch (_e) {
      return null;
    }
  }

  function clearSession(storageKey) {
    try {
      sessionStorage.removeItem(storageKey || defaults.storageKey);
    } catch (_e) {
      /* ignore */
    }
  }

  function dispatch(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail: detail }));
    } catch (_e) {
      /* CustomEvent unavailable */
    }
  }

  /**
   * Open broker popup and resolve with the passthrough session.
   * @returns {Promise<object>}
   */
  function signIn(params) {
    var options = params || {};
    var prepared = authorizeUrl(options);
    var brokerOrigin;
    try {
      brokerOrigin = brokerOriginFromBase(options.brokerBase || defaults.brokerBase);
    } catch (_e) {
      return Promise.reject(new Error("Invalid broker base URL."));
    }

    return new Promise(function (resolve, reject) {
      var popup = window.open(
        prepared.url,
        "opensesame-broker",
        "popup=yes,width=480,height=720"
      );
      if (!popup) {
        reject(new Error("Popup blocked. Allow popups for this site, or open the authorize URL manually."));
        return;
      }

      var settled = false;
      function finish(ok, value) {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", onMessage);
        clearInterval(timer);
        try {
          popup.close();
        } catch (_e) {
          /* ignore */
        }
        if (ok) resolve(value);
        else reject(value instanceof Error ? value : new Error(String(value)));
      }

      function onMessage(event) {
        if (event.origin !== brokerOrigin) return;
        var data = event.data;
        if (!data || data.type !== "opensesame:signin") return;
        if (data.state !== prepared.state) return;

        if (data.error) {
          finish(false, new Error(data.error_description || data.error));
          return;
        }
        if (typeof data.id_token !== "string") {
          finish(false, new Error("Broker returned no id_token."));
          return;
        }

        var session = {
          id_token: data.id_token,
          issuer: data.issuer,
          audience: data.audience,
          jwks_uri: data.jwks_uri,
          expires_at: data.expires_at,
          state: data.state,
        };
        if (options.persist !== false) {
          persistSession(session, options.storageKey);
        }
        finish(true, session);
      }

      window.addEventListener("message", onMessage);

      var timer = setInterval(function () {
        if (settled) return;
        if (popup.closed) {
          finish(false, new Error("consent_required"));
        }
      }, 400);
    });
  }

  function base64UrlToBytes(value) {
    var padded = value.replace(/-/g, "+").replace(/_/g, "/");
    var pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    var binary = atob(padded + pad);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function bytesToBase64Url(bytes) {
    var binary = "";
    for (var i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function decodeJwtPayload(token) {
    try {
      var parts = token.split(".");
      if (parts.length < 2) return null;
      var json = new TextDecoder().decode(base64UrlToBytes(parts[1]));
      return JSON.parse(json);
    } catch (_e) {
      return null;
    }
  }

  function decodeJwtHeader(token) {
    try {
      var parts = token.split(".");
      if (parts.length < 2) return null;
      var json = new TextDecoder().decode(base64UrlToBytes(parts[0]));
      return JSON.parse(json);
    } catch (_e) {
      return null;
    }
  }

  async function derivePairwiseSubject(idToken, rpOrigin) {
    var claims = decodeJwtPayload(idToken);
    if (!claims || typeof claims.pairwise_sub !== "string") {
      throw new Error("Token has no pairwise_sub.");
    }
    var origin = rpOrigin || window.location.origin;
    var material = new TextEncoder().encode(claims.pairwise_sub + ":" + origin);
    var digest = await crypto.subtle.digest("SHA-256", material);
    return bytesToBase64Url(new Uint8Array(digest));
  }

  function jwkToImportParams(jwk, alg) {
    if (alg === "ES256") {
      return {
        algorithm: { name: "ECDSA", namedCurve: "P-256" },
        keyUsages: ["verify"],
      };
    }
    if (alg === "RS256") {
      return {
        algorithm: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        keyUsages: ["verify"],
      };
    }
    throw new Error("Unsupported JWT alg: " + alg);
  }

  function verifyAlgorithm(alg) {
    if (alg === "ES256") {
      return { name: "ECDSA", hash: "SHA-256" };
    }
    if (alg === "RS256") {
      return { name: "RSASSA-PKCS1-v1_5" };
    }
    throw new Error("Unsupported JWT alg: " + alg);
  }

  async function importJwk(jwk, alg) {
    var params = jwkToImportParams(jwk, alg);
    return crypto.subtle.importKey("jwk", jwk, params.algorithm, false, params.keyUsages);
  }

  async function fetchJwks(jwksUri) {
    var response = await fetch(jwksUri, { credentials: "omit" });
    if (!response.ok) {
      throw new Error("JWKS fetch failed (" + response.status + ").");
    }
    var body = await response.json();
    if (!body || !Array.isArray(body.keys)) {
      throw new Error("JWKS response has no keys.");
    }
    return body.keys;
  }

  function pickJwk(keys, header) {
    var kid = header && header.kid;
    if (kid) {
      for (var i = 0; i < keys.length; i += 1) {
        if (keys[i].kid === kid) return keys[i];
      }
    }
    var alg = header && header.alg;
    for (var j = 0; j < keys.length; j += 1) {
      var key = keys[j];
      if (key.use && key.use !== "sig") continue;
      if (alg === "ES256" && (key.kty === "EC" || key.crv === "P-256")) return key;
      if (alg === "RS256" && key.kty === "RSA") return key;
    }
    return keys[0] || null;
  }

  /**
   * Verify the upstream id_token (federated-signin.md §3) and derive the RP subject.
   * @returns {Promise<{ session: object, claims: object, subject: string }>}
   */
  async function acceptSession(session, options) {
    var opts = options || {};
    if (!session || typeof session.id_token !== "string") {
      throw new Error("Session is missing id_token.");
    }
    var token = session.id_token;
    var parts = token.split(".");
    if (parts.length !== 3) {
      throw new Error("id_token is not a compact JWT.");
    }

    var header = decodeJwtHeader(token);
    var claims = decodeJwtPayload(token);
    if (!header || !claims) {
      throw new Error("Could not decode id_token.");
    }

    var alg = header.alg;
    if (alg !== "ES256" && alg !== "RS256") {
      throw new Error("Unsupported JWT alg: " + String(alg));
    }

    var jwksUri = session.jwks_uri || opts.jwksUri;
    if (!jwksUri || typeof jwksUri !== "string") {
      throw new Error("Session is missing jwks_uri.");
    }

    var keys = await fetchJwks(jwksUri);
    var jwk = pickJwk(keys, header);
    if (!jwk) {
      throw new Error("No matching JWK for this token.");
    }

    var key = await importJwk(jwk, alg);
    var data = new TextEncoder().encode(parts[0] + "." + parts[1]);
    var signature = base64UrlToBytes(parts[2]);
    var ok = await crypto.subtle.verify(verifyAlgorithm(alg), key, signature, data);
    if (!ok) {
      throw new Error("id_token signature is invalid.");
    }

    var expectedIss = opts.issuer || session.issuer;
    if (expectedIss && claims.iss !== expectedIss) {
      throw new Error("iss mismatch.");
    }

    var expectedAud = opts.audience || session.audience || expectedAudience(opts);
    var aud = claims.aud;
    var audOk = Array.isArray(aud) ? aud.indexOf(expectedAud) !== -1 : aud === expectedAud;
    if (!audOk) {
      throw new Error("aud mismatch (expected " + expectedAud + ").");
    }

    if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) {
      throw new Error("id_token is expired.");
    }

    if (typeof claims.pairwise_sub !== "string" || !claims.pairwise_sub) {
      throw new Error("id_token has no pairwise_sub.");
    }

    var subject = await derivePairwiseSubject(token, opts.rpOrigin || window.location.origin);
    return { session: session, claims: claims, subject: subject };
  }

  async function signInAndAccept(params) {
    var session = await signIn(params);
    return acceptSession(session, params);
  }

  function shouldHandleClick(event) {
    if (event.defaultPrevented) return false;
    if (event.button !== 0) return false;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
    return true;
  }

  function runSignInFlow(options, verify) {
    var pending = verify ? signInAndAccept(options) : signIn(options);
    return pending
      .then(function (result) {
        var detail = verify
          ? result
          : { session: result };
        dispatch("opensesame:signed_in", detail);
        return result;
      })
      .catch(function (error) {
        dispatch("opensesame:signin_error", {
          error: error && error.message ? error.message : String(error),
        });
        throw error;
      });
  }

  function getAuthorizeLinkConfig(anchor) {
    if (!anchor || typeof anchor.href !== "string" || !anchor.href) return null;

    var parsed;
    try {
      parsed = new URL(anchor.href, window.location.href);
    } catch (_e) {
      return null;
    }

    if (!/\/broker\/authorize\/?$/.test(parsed.pathname)) return null;

    // Already a fully prepared request — leave it alone.
    if (parsed.searchParams.get("state")) return null;

    var origin = parsed.searchParams.get("origin") || window.location.origin;
    var clientId = parsed.searchParams.get("client_id") || "origin:" + origin;
    if (clientId !== "origin:" + origin) return null;

    var brokerBase;
    try {
      var path = parsed.pathname.replace(/\/broker\/authorize\/?$/, "/");
      brokerBase = parsed.origin + path;
    } catch (_e2) {
      brokerBase = defaults.brokerBase;
    }

    return {
      brokerBase: brokerBase,
      origin: origin,
      scope: parsed.searchParams.get("scope") || defaults.scope,
      redirectUri: parsed.searchParams.get("redirect_uri") || undefined,
    };
  }

  function bootstrapAutoBind() {
    if (!defaults.autoBind) return;
    if (window.__opensesameAutoBindBootstrapped) return;
    window.__opensesameAutoBindBootstrapped = true;

    document.addEventListener("click", function (event) {
      if (!shouldHandleClick(event)) return;
      var target = event.target;
      if (!target || typeof target.closest !== "function") return;
      var el = target.closest("[data-opensesame-signin]");
      if (!el) return;

      event.preventDefault();
      var verify =
        parseBoolean(el.getAttribute("data-opensesame-verify")) || defaults.verifyOnBind;
      var scope = el.getAttribute("data-opensesame-scope") || defaults.scope;
      runSignInFlow({ scope: scope }, verify).catch(function (error) {
        console.error("[opensesame.js] sign-in failed", error);
      });
    });
  }

  function bootstrapAuthorizeLinks() {
    if (!defaults.autoLinks) return;
    if (window.__opensesameAuthorizeLinksBootstrapped) return;
    window.__opensesameAuthorizeLinksBootstrapped = true;

    document.addEventListener("click", function (event) {
      if (!shouldHandleClick(event)) return;
      var target = event.target;
      if (!target || typeof target.closest !== "function") return;
      var anchor = target.closest("a[href]");
      if (!anchor) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;

      var config = getAuthorizeLinkConfig(anchor);
      if (!config) return;

      event.preventDefault();
      var verify =
        parseBoolean(anchor.getAttribute("data-opensesame-verify")) || defaults.verifyOnBind;
      runSignInFlow(config, verify).catch(function (error) {
        console.error("[opensesame.js] authorize link sign-in failed", error);
      });
    });
  }

  window.OpenSesame = Object.assign(window.OpenSesame || {}, {
    defaults: defaults,
    signIn: signIn,
    signInAndAccept: signInAndAccept,
    acceptSession: acceptSession,
    getSession: getSession,
    clearSession: clearSession,
    authorizeUrl: function (options) {
      return authorizeUrl(options).url;
    },
    decodeJwtPayload: decodeJwtPayload,
    derivePairwiseSubject: derivePairwiseSubject,
    /** @internal exported for tests */
    _getAuthorizeLinkConfig: getAuthorizeLinkConfig,
  });

  bootstrapAutoBind();
  bootstrapAuthorizeLinks();
})();
