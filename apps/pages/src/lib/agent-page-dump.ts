import {
  readLocalGithubApp,
  refreshGithubAppInstallations,
} from "./github-app-manifest.js";
import { vaultStore } from "./vault/store.js";

if (import.meta.env.DEV) {
  let refreshing = false;
  const post = (): void => {
    try {
      const root = document.getElementById("root");
      if (!root || root.childElementCount === 0) return;
      const snap = vaultStore.getSnapshot();
      const githubKeys = Object.keys(localStorage).filter((k) =>
        /github|pem|opensesame\.github/i.test(k),
      );
      const store: Record<string, string | null> = {};
      for (const k of githubKeys) {
        const v = localStorage.getItem(k);
        store[k] =
          k.includes("pem") && v
            ? `[pem ${v.length} chars, hasKey=${v.includes("PRIVATE KEY")}]`
            : v;
      }
      const body = {
        url: location.href,
        presence:
          document.querySelector('[data-testid="github-app-presence"]')
            ?.textContent ?? null,
        owner:
          document.querySelector('[data-testid="github-app-owner"]')
            ?.textContent ?? null,
        installs: [
          ...document.querySelectorAll('[data-testid="github-app-install"]'),
        ].map((el) => el.textContent),
        vault: {
          status: snap.status,
          tomb: snap.tomb,
          secrets: snap.items
            .filter((i) => i.kind === "secret")
            .map((i) => i.name),
        },
        localApp: readLocalGithubApp(),
        store,
        at: Date.now(),
      };
      void fetch(`${import.meta.env.BASE_URL}__agent_page`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        keepalive: true,
      });
      if (
        !refreshing &&
        snap.status === "unlocked" &&
        readLocalGithubApp() &&
        !readLocalGithubApp()?.ownerLogin
      ) {
        refreshing = true;
        void refreshGithubAppInstallations().finally(() => {
          refreshing = false;
        });
      }
    } catch {
      /* ignore */
    }
  };
  post();
  window.setInterval(post, 2000);
}
