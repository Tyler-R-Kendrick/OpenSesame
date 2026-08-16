/**
 * OpenSesame static-site client — Shoo-comparable benefit without a backend.
 *
 * Opens the Pages broker popup, receives an upstream id_token via postMessage
 * (ADR 0034). Does not exchange codes against OpenSesame; OpenSesame has no
 * token endpoint on static hosting.
 *
 * Usage:
 *   <script src="https://…/OpenSesame/opensesame.js" defer></script>
 *   OpenSesame.signIn().then((session) => { … })
 */
(function () {
  if (typeof window === "undefined") return;

  var scriptEl = document.currentScript;
  var dataset = scriptEl && scriptEl.dataset ? scriptEl.dataset : {};
  var scriptSrc = scriptEl && scriptEl.src ? scriptEl.src : "";

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

  /**
   * Open broker popup and resolve with the passthrough session.
   * @returns {Promise<object>}
   */
  function signIn(params) {
    var options = params || {};
    var prepared = authorizeUrl(options);
    var brokerOrigin;
    try {
      brokerOrigin = new URL(normalizeBase(options.brokerBase || defaults.brokerBase)).origin;
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

  function decodeJwtPayload(token) {
    try {
      var parts = token.split(".");
      if (parts.length < 2) return null;
      var padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      var pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
      return JSON.parse(atob(padded + pad));
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
    var bytes = new Uint8Array(digest);
    var binary = "";
    for (var i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  window.OpenSesame = Object.assign(window.OpenSesame || {}, {
    defaults: defaults,
    signIn: signIn,
    getSession: getSession,
    clearSession: clearSession,
    authorizeUrl: function (options) {
      return authorizeUrl(options).url;
    },
    decodeJwtPayload: decodeJwtPayload,
    derivePairwiseSubject: derivePairwiseSubject,
  });
})();
