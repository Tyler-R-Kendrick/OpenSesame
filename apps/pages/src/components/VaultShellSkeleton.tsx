import "./vault-shell-skeleton.css";

const RAIL_ROWS = ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"];
const CONTENT_ROWS = [
  { id: "c1", width: 62 },
  { id: "c2", width: 73 },
  { id: "c3", width: 84 },
  { id: "c4", width: 62 },
  { id: "c5", width: 73 },
  { id: "c6", width: 84 },
];

/**
 * The unlocked shell's frame, before the real one can paint.
 *
 * Unlock is the moment the person expects to see their vault, not a second
 * loading screen. The rail and content frame use the same grid as `AppShell`
 * so the real shell lands in place; the shimmers are decorative and stop for
 * reduced motion.
 */
export function VaultShellSkeleton() {
  return (
    <div className="app vault-skeleton" aria-hidden="true">
      <aside className="rail">
        <div className="rail__brand">
          <span className="vault-skeleton__bar vault-skeleton__wordmark" />
        </div>
        <div className="rail__prompt">
          <span className="vault-skeleton__bar vault-skeleton__prompt" />
        </div>
        <div className="rail__scroll">
          <div className="vault-skeleton__rows">
            {RAIL_ROWS.map((id, index) => (
              <span
                className="vault-skeleton__bar vault-skeleton__row"
                key={id}
                style={{ inlineSize: `${72 - (index % 3) * 12}%` }}
              />
            ))}
          </div>
        </div>
      </aside>
      <div className="main">
        <div className="vault-skeleton__topbar">
          <span className="vault-skeleton__bar vault-skeleton__crumb" />
        </div>
        <VaultContentSkeleton />
      </div>
    </div>
  );
}

/** The first screen inside the shell: the vault listing's card and rows. */
export function VaultContentSkeleton() {
  return (
    <div className="vault-skeleton__content" aria-hidden="true">
      <div className="vault-skeleton__intro">
        <span className="vault-skeleton__bar vault-skeleton__title" />
        <span className="vault-skeleton__bar vault-skeleton__lede" />
      </div>
      <div className="vault-skeleton__card">
        {CONTENT_ROWS.map((row) => (
          <div className="vault-skeleton__item" key={row.id}>
            <span className="vault-skeleton__bar vault-skeleton__icon" />
            <span
              className="vault-skeleton__bar vault-skeleton__line"
              style={{ inlineSize: `${row.width}%` }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
