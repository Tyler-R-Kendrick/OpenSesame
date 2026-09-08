// Deprecated root artifact: explicit loopback compatibility only.
// Remote RPs use the immutable hosted SDK or a self-hosted package build.
import { type LoopbackProfile, signInLoopback } from "./passthrough.js";

Object.defineProperty(window, "OpenSesame", {
  configurable: false,
  writable: false,
  value: Object.freeze({
    async signIn(profile: LoopbackProfile) {
      try {
        const result = await signInLoopback(profile);
        window.dispatchEvent(
          new CustomEvent("opensesame:signed_in", { detail: result }),
        );
        return result;
      } catch {
        window.dispatchEvent(
          new CustomEvent("opensesame:signin_error", {
            detail: { code: "signin_failed" },
          }),
        );
        throw new Error("signin_failed");
      }
    },
  }),
});
