# ast-grep gate — negative control

`pnpm audit:ast-grep` is green. A green gate is only worth something if it can
still go red, so this is how to check that it can — and that the test-file
scoping in `ast-grep-rules.yml` narrows the rules rather than switching them
off.

Run it after any change to the rules file.

```bash
R="$(cat security/ast-grep-rules.yml)"
run() { ast-grep scan --inline-rules "$R" "$1" 2>/dev/null | grep -c '^error\['; }
mkdir -p /tmp/ng/src
```

## The four cases

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

```bash
rm -rf /tmp/ng
```

## Suppressions

Three production findings are suppressed individually, each with its reason at
the call site:

| Site | Rule | Why |
| --- | --- | --- |
| `apps/pages/src/lib/connectivity-monitor.ts` | `ts-math-random-security` | Probe jitter. Nothing treats the delay as unpredictable-to-an-attacker; it only stops a fleet sweeping in lockstep. |
| `apps/pages/src/lib/guest-auth.ts` (stash) | `ts-localstorage-set` | Real and deliberate — the guest access token has to survive the OIDC redirect, which is a full navigation. Follows `docs/security/audit-2026-08-07-sdk-browser-storage.md`: sessionStorage, no refresh token. |
| `apps/pages/src/lib/guest-auth.ts` (pending link) | `ts-localstorage-set` | A literal `"1"`. The only thing it leaks is that a link is pending, which the on-screen notice already says. |

`// ast-grep-ignore: <rule-id>` must be the line **immediately** above the
match. Another comment between the two silently does nothing, and the gate
stays red with no explanation of why the suppression "didn't work".

Suppress at the call site, never by deleting a rule. A fourth production
finding should turn this gate red.
