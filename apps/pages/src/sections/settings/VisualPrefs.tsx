import type { VaultPrefs } from "@opensesame/app-core/lib/vault/store.js";
import { IconMonitor, IconMoon, IconSun } from "../../components/Icons.js";
import { setTheme } from "../../lib/theme.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";

const THEMES = [
  { id: "system", label: "System", Icon: IconMonitor },
  { id: "light", label: "Day", Icon: IconSun },
  { id: "dark", label: "Night", Icon: IconMoon },
] as const;

const AUTO_LOCK = [
  { value: 0, label: "only when I ask" },
  { value: 60, label: "after 1 hour idle" },
  { value: 240, label: "after 4 hours idle" },
  { value: 480, label: "after 8 hours idle" },
  { value: 1440, label: "after 24 hours idle" },
  { value: 30, label: "after 30 minutes idle" },
  { value: 15, label: "after 15 minutes idle" },
  { value: 5, label: "after 5 minutes idle" },
  { value: 1, label: "after 1 minute idle" },
] as const;

const CLIPBOARD = [
  { value: 10, label: "for 10 seconds" },
  { value: 30, label: "for 30 seconds" },
  { value: 60, label: "for 1 minute" },
  { value: 0, label: "until something replaces them" },
] as const;

type VisualPrefsProps = {
  prefs: VaultPrefs;
  onTheme: (id: VaultPrefs["theme"]) => void;
  onNumber: (
    key: "autoLockMinutes" | "clipboardClearSeconds",
    value: number,
  ) => void;
  onToggle: (key: "lockOnHide" | "signOutOnLock", value: boolean) => void;
};

function AppearancePrefs(props: VisualPrefsProps) {
  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Appearance</h2>
        </div>
      </div>
      <div className="panel__body">
        <fieldset className="set__themes" aria-label="Theme">
          {THEMES.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              className="set__theme"
              aria-pressed={props.prefs.theme === id}
              onClick={() => {
                setTheme(id);
                props.onTheme(id);
              }}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </fieldset>
      </div>
    </section>
  );
}

function LockingPrefs(props: VisualPrefsProps) {
  const autoLockRef = useGuideTarget<HTMLSelectElement>("settings.auto-lock");
  const { prefs } = props;
  const lockOptions = AUTO_LOCK.some(
    (option) => option.value === prefs.autoLockMinutes,
  )
    ? AUTO_LOCK
    : [
        ...AUTO_LOCK,
        {
          value: prefs.autoLockMinutes,
          label: `after ${prefs.autoLockMinutes} minutes idle`,
        },
      ];
  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Locking</h2>
        </div>
      </div>
      <div className="panel__body">
        {/* Rows like the switches under them — a name, then its control at
            the row's end. As one sentence with two selects in it, a phone
            broke it into boxed pills on lines of their own. */}
        <div className="sw">
          <label className="sw__name" htmlFor="settings-auto-lock">
            Lock the vault
          </label>
          <select
            id="settings-auto-lock"
            ref={autoLockRef}
            className="sw__select"
            aria-label="Lock after inactivity"
            value={prefs.autoLockMinutes}
            onChange={(event) =>
              props.onNumber("autoLockMinutes", Number(event.target.value))
            }
          >
            {lockOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="sw">
          <label className="sw__name" htmlFor="settings-clipboard">
            Keep copied secrets
          </label>
          <select
            id="settings-clipboard"
            className="sw__select"
            aria-label="Clear copied secrets after"
            value={prefs.clipboardClearSeconds}
            onChange={(event) =>
              props.onNumber(
                "clipboardClearSeconds",
                Number(event.target.value),
              )
            }
          >
            {CLIPBOARD.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="sw">
          <span className="sw__name">
            Lock when this tab goes to the background
          </span>
          <button
            type="button"
            className="toggle"
            role="switch"
            aria-checked={prefs.lockOnHide}
            aria-pressed={prefs.lockOnHide}
            aria-label="Lock when this tab goes to the background"
            onClick={() => props.onToggle("lockOnHide", !prefs.lockOnHide)}
          />
        </div>
        <div className="sw">
          <span>
            <span className="sw__name">Sign out of Identity too</span>
            <span className="sw__sub">
              {" "}
              — otherwise auto-lock drops only the vault key and you stay signed
              in.
            </span>
          </span>
          <button
            type="button"
            className="toggle"
            role="switch"
            aria-checked={prefs.signOutOnLock}
            aria-pressed={prefs.signOutOnLock}
            aria-label="Also sign out of Identity when the vault locks"
            onClick={() =>
              props.onToggle("signOutOnLock", !prefs.signOutOnLock)
            }
          />
        </div>
      </div>
    </section>
  );
}

export function VisualPrefs(props: VisualPrefsProps) {
  return (
    <>
      <AppearancePrefs {...props} />
      <LockingPrefs {...props} />
    </>
  );
}
