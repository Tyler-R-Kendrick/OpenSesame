/**
 * First-class "this deployment has no identity service" state.
 *
 * A static deploy that ships without an Identity API used to render every
 * sign-in affordance as if it worked and let each one fail after the redirect.
 * This notice says so up front, and carries the same inline endpoint field the
 * Settings panel offers — so an operator (or a user who was handed the URL)
 * can connect without first creating a vault to reach Settings.
 */

import { type FormEvent, useState, useSyncExternalStore } from "react";
import {
  loadSettings,
  pageIsLoopback,
  saveSettings,
  settingsEpoch,
  subscribeSettings,
} from "../../lib/settings.js";

const TRAILING_SLASH = /\/$/;

export const unconfiguredNoticeDependencies = {
  loadSettings,
  saveSettings,
  pageIsLoopback,
};

/** True when sign-in cannot work here: non-loopback page, no Identity API. */
export function identityUnconfigured(): boolean {
  if (unconfiguredNoticeDependencies.pageIsLoopback()) return false;
  return !unconfiguredNoticeDependencies.loadSettings().identityApi.trim();
}

export function UnconfiguredIdentityNotice() {
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  // Re-render on settings writes (the connect below, or the runtime config
  // landing) so the notice folds away the moment an Identity API exists.
  useSyncExternalStore(subscribeSettings, settingsEpoch, () => 0);

  if (!identityUnconfigured()) return null;

  function connect(event: FormEvent) {
    event.preventDefault();
    const trimmed = value.trim().replace(TRAILING_SLASH, "");
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      setInvalid(true);
      return;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      setInvalid(true);
      return;
    }
    const current = unconfiguredNoticeDependencies.loadSettings();
    unconfiguredNoticeDependencies.saveSettings({
      ...current,
      identityApi: trimmed,
    });
  }

  return (
    <div className="note note--warn unlock__unconfigured">
      <div className="unlock__unconfigured-body">
        <p>
          <strong>Not connected to an identity service.</strong> Sign-in options
          are unavailable on this deployment. You can still create a local-only
          vault, or connect one below.
        </p>
        {/* noValidate: the styled hint below explains, in place, what the
            browser's native bubble would otherwise say over the top of it. */}
        <form className="unlock__unconfigured-form" onSubmit={connect} noValidate>
          <input
            type="url"
            placeholder="https://id.example.com"
            aria-label="Identity API URL"
            aria-invalid={invalid || undefined}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setInvalid(false);
            }}
          />
          <button type="submit" className="btn btn--sm">
            Connect
          </button>
        </form>
        {invalid ? (
          <p className="hint" role="alert">
            Enter a full URL, like https://id.example.com.
          </p>
        ) : (
          <p className="hint">
            Ask whoever runs your OpenSesame deployment for this address. It's
            saved on this device only.
          </p>
        )}
      </div>
    </div>
  );
}
