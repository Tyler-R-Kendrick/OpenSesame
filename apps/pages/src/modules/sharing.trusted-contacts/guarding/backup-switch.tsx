/** One setting a guardian turns on or off in the sheet that agrees: whether a second security key is registered too. */

export function BackupSwitch({
  on,
  disabled,
  onChange,
}: {
  on: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="tc-switch">
      <span id="guarding-backup-label">Add a backup key</span>
      <button
        id="guarding-backup"
        type="button"
        className="toggle"
        role="switch"
        aria-checked={on}
        aria-labelledby="guarding-backup-label"
        disabled={disabled}
        onClick={() => onChange(!on)}
      />
    </div>
  );
}
