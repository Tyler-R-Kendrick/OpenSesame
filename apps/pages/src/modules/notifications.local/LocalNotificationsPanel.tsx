/**
 * Settings › Capabilities › Local notifications: where this device tells its
 * person that a request is waiting (ADR 0162). Two rows, each one key, each
 * drawn only where its key can act (ADR 0158):
 *
 * - **System notifications** — a doorbell outside the page, for when the tab
 *   is in the background. The browser's permission is asked for when, and only
 *   when, its key is pressed. Where the browser cannot show one, or the person
 *   refused it there, there is no row: nothing here could change that.
 * - **Tab title and badge** — the count in the tab's title and, where the app
 *   is installed, on its icon.
 *
 * The bell is not a row. It is the inbox, and the inbox cannot be turned off
 * (ADR 0084), so there is nothing to press. Nothing on this panel names a
 * service: nothing it does reaches one.
 */

import type {
  LocalDestination,
  SystemPermission,
} from "@opensesame/app-core/lib/local-notifications/destinations.js";
import {
  DEFAULT_PREFERENCE,
  type LocalPreference,
  readPreference,
  subscribePreference,
  writePreference,
} from "@opensesame/app-core/lib/local-notifications/preference.js";
import { useCallback, useEffect, useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconBell, IconPlus, IconX } from "../../components/Icons.js";
import { useVault } from "../../lib/vault/hooks.js";
import { CeremonyRow } from "../../sections/settings/CeremonyRow.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { hasDocument, readEnvironment } from "./delivery.js";

/** The preference with `place` on or off, the order of the rest kept. */
function toggled(
  preference: LocalPreference,
  place: LocalDestination,
  on: boolean,
): LocalPreference {
  const rest = preference.destinations.filter((entry) => entry !== place);
  return {
    version: 1,
    destinations: on ? [...rest, place] : rest,
  };
}

/** One place, on or off, and the one key that changes it. */
function PlaceRow({
  label,
  on,
  keyLabel,
  onPress,
}: {
  label: string;
  on: boolean;
  keyLabel: string;
  onPress: () => void;
}) {
  return (
    <CeremonyRow
      icon={<IconBell size={16} />}
      label={label}
      mark={on ? { tone: "ok", label: "On" } : { tone: "idle", label: "Off" }}
      sub=""
      action={
        <IconKey small label={keyLabel} onClick={onPress}>
          {on ? <IconX size={16} /> : <IconPlus size={16} />}
        </IconKey>
      }
    />
  );
}

/** The vault's preference, kept current, and the way to write it. */
function usePreference(tomb: string) {
  const [preference, setPreference] = useState<LocalPreference | null>(null);
  const load = useCallback(() => {
    readPreference(tomb).then(setPreference, () =>
      setPreference(DEFAULT_PREFERENCE),
    );
  }, [tomb]);
  useEffect(() => {
    load();
    return subscribePreference(load);
  }, [load]);
  const save = (next: LocalPreference) => {
    writePreference(tomb, next).catch(() => undefined);
  };
  return { preference, save };
}

export function LocalNotificationsPanel() {
  const { tomb } = useVault();
  const { preference, save } = usePreference(tomb);
  const [permission, setPermission] = useState<SystemPermission>(
    () => readEnvironment().system,
  );
  const guide = useGuideTarget<HTMLElement>("settings.local-notifications");
  if (preference === null) return null;
  const has = (place: LocalDestination) =>
    preference.destinations.includes(place);
  const system = permission === "granted" && has("system");
  const askForSystem = async () => {
    // Asked for here, on this key, and nowhere else.
    const answer = await Notification.requestPermission();
    setPermission(answer);
    if (answer === "granted" && !has("system"))
      save(toggled(preference, "system", true));
  };
  const systemKey =
    permission === "default"
      ? "Allow system notifications"
      : system
        ? "Turn off system notifications"
        : "Turn on system notifications";

  return (
    <section className="panel" id="local-notifications" ref={guide}>
      <div className="panel__head">
        <h2>On this device</h2>
      </div>
      <div className="panel__body">
        {permission === "default" || permission === "granted" ? (
          <PlaceRow
            label="System notifications"
            on={system}
            keyLabel={systemKey}
            onPress={() => {
              if (permission === "default") void askForSystem();
              else save(toggled(preference, "system", !system));
            }}
          />
        ) : null}
        {hasDocument() ? (
          <PlaceRow
            label="Tab title and badge"
            on={has("tab_title")}
            keyLabel={
              has("tab_title")
                ? "Turn off tab title and badge"
                : "Turn on tab title and badge"
            }
            onPress={() =>
              save(toggled(preference, "tab_title", !has("tab_title")))
            }
          />
        ) : null}
      </div>
    </section>
  );
}
