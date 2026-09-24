import { element, issuer, origin, sesame } from "./client.js";

element("origin").textContent = origin;
element("issuer").textContent = issuer;
const status = element("status");
status.textContent = "Signed out.";
element("sign-in").addEventListener("click", () => {
  void sesame.begin().catch(() => {
    status.textContent = "Sign-in failed.";
  });
});
element("sign-out").addEventListener("click", () => {
  status.textContent = "Signed out. No RP token is stored.";
});
