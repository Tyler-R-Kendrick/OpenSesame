/**
 * Browser wiring for `login.ts`. Configuration is baked in at build time by
 * `vite.spa.config.ts` (`OPENSESAME_PAGES_BASE`, `SIOP_RP_CLIENT_ID`).
 */
import { type SpaConfig, beginSignIn, finishSignIn } from "./login.js";

declare const __SIOP_SPA_CONFIG__: SpaConfig;

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing #${id}`);
  return found;
}

const status = element("status");
const detail = element("detail");
const signin = element("signin");

const deps = {
  storage: sessionStorage,
  fetch: globalThis.fetch.bind(globalThis),
  page: {
    origin: location.origin,
    pathname: location.pathname,
    search: location.search,
    hash: location.hash,
  },
  navigate: (url: string) => location.assign(url),
  scrub: (url: string) => history.replaceState(null, "", url),
};

function show(state: string, text: string, more?: string): void {
  status.dataset.state = state;
  status.textContent = text;
  if (more !== undefined) {
    detail.hidden = false;
    detail.textContent = more;
  }
}

signin.addEventListener("click", () => {
  show("working", "Reading the deployment's metadata");
  beginSignIn(__SIOP_SPA_CONFIG__, deps).catch((failure: Error) => {
    show("refused", "Could not start sign-in.", failure.message);
  });
});

const outcome = await finishSignIn(__SIOP_SPA_CONFIG__, deps);
if (outcome.kind === "signed-in") {
  const { result } = outcome;
  signin.hidden = true;
  show(
    "verified",
    "Signed in.",
    JSON.stringify(
      {
        subject: result.subject,
        issuer: result.verified.iss,
        audience: result.verified.aud,
      },
      null,
      2,
    ),
  );
} else if (outcome.kind === "refused") {
  show("refused", "Sign-in was refused.", outcome.code);
  status.dataset.code = outcome.code;
}
