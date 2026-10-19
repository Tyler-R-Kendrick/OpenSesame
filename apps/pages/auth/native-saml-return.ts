/** Fixed release-owned loader for the service worker's response-free ACS document. */
import { returnSamlPost } from "@opensesame/app-core/browser/saml/post-return.js";

const scopeUrl = new URL(import.meta.env.BASE_URL, location.origin).href;
const acsUrl = new URL("auth/native-saml", scopeUrl).href;
const stopped = new AbortController();
window.addEventListener("pagehide", () => stopped.abort(), { once: true });
const status = document.getElementById("saml-status");
void returnSamlPost({
  scopeUrl,
  acsUrl,
  owner: {
    signal: stopped.signal,
    assertCurrent() {
      if (location.href !== acsUrl)
        throw new Error("SAML callback location changed");
    },
  },
})
  .then(() => {
    if (status)
      status.textContent =
        "Response delivered. Continue in the original window.";
  })
  .catch(() => {
    if (status)
      status.textContent =
        "Return expired. Close this window and retry sign-in in the original window.";
  });
