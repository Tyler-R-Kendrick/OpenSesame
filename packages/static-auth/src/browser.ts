import { type HostedProfile, createHostedClient } from "./hosted.js";
import { type LoopbackProfile, signInLoopback } from "./passthrough.js";

type Profile = HostedProfile | LoopbackProfile;
declare global {
  interface Window {
    OpenSesame: {
      signIn: (
        profile: Profile,
      ) => Promise<{ subject: string; expiresAt: number } | undefined>;
      complete: (
        profile: HostedProfile,
      ) => Promise<{ subject: string; expiresAt: number } | null>;
    };
  }
}

function signedIn(result: { subject: string; expiresAt: number }) {
  window.dispatchEvent(
    new CustomEvent("opensesame:signed_in", { detail: result }),
  );
  return result;
}

window.OpenSesame = Object.freeze({
  async signIn(profile: Profile) {
    try {
      if (profile?.profile === "pages_passthrough_loopback")
        return signedIn(await signInLoopback(profile));
      if (profile?.profile !== "hosted_identity")
        throw new Error("profile_required");
      await createHostedClient(profile).begin();
    } catch {
      window.dispatchEvent(
        new CustomEvent("opensesame:signin_error", {
          detail: { code: "signin_failed" },
        }),
      );
      throw new Error("signin_failed");
    }
  },
  async complete(profile: HostedProfile) {
    try {
      const result = await createHostedClient(profile).complete();
      return result ? signedIn(result) : null;
    } catch {
      window.dispatchEvent(
        new CustomEvent("opensesame:signin_error", {
          detail: { code: "signin_failed" },
        }),
      );
      throw new Error("signin_failed");
    }
  },
});
