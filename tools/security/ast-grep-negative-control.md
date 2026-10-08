# ast-grep gate — negative control

`pnpm audit:ast-grep` is green. A green gate is only worth something if it can
still go red, so this is how to check that it can — and that the test-file
scoping in `ast-grep-rules.yml` narrows the rules rather than switching them
off.

Run it after any change to the rules file.

```bash
R="$(cat tools/security/ast-grep-rules.yml)"
run() { ast-grep scan --inline-rules "$R" "$1" 2>/dev/null | grep -c '^error\['; }
mkdir -p /tmp/ng/src
```

## The five cases

**1. A production file writing to web storage — must FAIL.**

```bash
cat > /tmp/ng/src/prod.ts <<'EOF'
export function save(t: string) { localStorage.setItem("token", t); }
EOF
run /tmp/ng/src/prod.ts   # expect: 1
```

**2. The same call in a test file — must PASS.**

```bash
cat > /tmp/ng/src/prod.test.ts <<'EOF'
it("x", () => { localStorage.setItem("token", "t"); });
EOF
run /tmp/ng/src/prod.test.ts   # expect: 0
```

This is the scoping doing its job. A test seeding storage so it can assert the
production reader handles it is not an exfiltration path — the code never
reaches a browser and there is no attacker in the room.

**3. `eval` in a test file — must still FAIL.**

```bash
cat > /tmp/ng/src/inject.test.ts <<'EOF'
it("y", () => { eval("1+1"); });
EOF
run /tmp/ng/src/inject.test.ts   # expect: 1
```

The point of case 3: the injection rules are deliberately **not** scoped. Only
the browser-risk rules (innerHTML, web storage, `Math.random`) carry the
ignore list. If this case ever returns 0, someone has widened the scoping too
far and the gate has quietly stopped reading test files at all.

**4. `innerHTML` in a production `.tsx` — must FAIL.**

```bash
cat > /tmp/ng/src/x.tsx <<'EOF'
export function f(el: HTMLElement, s: string) { el.innerHTML = s; }
EOF
run /tmp/ng/src/x.tsx   # expect: 1
```

Case 4 covers the `tsx` rules separately from the `typescript` ones: ast-grep
treats them as different languages, so a rule fixed in one is not fixed in
the other.

**5. SQL formatting with an explicit caller argument — must FAIL.**

```bash
cat > /tmp/ng/src/sql.rs <<'EOF'
fn bad(input: &str) { sqlx::query(&format!("SELECT {}", input)); }
EOF
run /tmp/ng/src/sql.rs   # expect: 1
```

The SQL patterns use a variadic capture: a single capture misses the comma
and explicit argument, although it recognizes implicit `{input}` formatting.
Reviewed column lists and closed enum choices have individual audit comments;
caller values must remain bound parameters.

```bash
rm -rf /tmp/ng
```

## Suppressions

Production findings are suppressed individually, at the call site, with
`// ast-grep-ignore: <rule-id>`. Most carry a reason in the comment above. At
the time of writing there are 65 such lines under `apps`, `crates` and
`packages` (`rg 'ast-grep-ignore'` lists them):

| Rule | Sites | Where | What is suppressed |
| --- | --- | --- | --- |
| `sql-format-injection` | 54 | `crates/storage` (including `src/bitwarden/` and `src/web_login_runs/`), `crates/connection-broker/src/store.rs`, `crates/bitwarden-server/src/import/vaultwarden/files.rs`, two test modules in `crates/gateway/src/transport_lifecycle/` | `sqlx::query(&format!(..))` calls whose interpolated parts are reviewed column lists, a closed enum's column name or fixed test constants; caller values stay bound parameters. |
| `ts-localstorage-set` | 11 | `packages/app-core/src/lib/`: `guest-auth.ts`, `last-sign-in.ts`, `federation-pending.ts`, `federation-session-store.ts`, `auth-outcome.ts`, `ambient-auth/` (`transactions.ts`, `policy.ts`, `generation.ts`), `duress/session/fence.ts` | Writes through the host's local and session store ports. The `guest-auth.ts` site stores a literal `"1"` marking a pending link, which the on-screen notice already says. See `docs/security/audits/2026-08-07-sdk-browser-storage.md` for the storage rules. |

There is no `ts-math-random-security` suppression: a new `Math.random()` in
production code should turn this gate red.

`// ast-grep-ignore: <rule-id>` must be the line **immediately** above the
match. Another comment between the two silently does nothing, and the gate
stays red with no explanation of why the suppression "didn't work".

Suppress at the call site, never by deleting a rule. A new production finding
should turn this gate red.
