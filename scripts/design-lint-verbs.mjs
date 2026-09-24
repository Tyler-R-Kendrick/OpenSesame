/**
 * Design lint — a verb painted on a button (DESIGN.md § Actions are symbols).
 *
 * Split from `design-lint.mjs`, which owns the debt ledger. The first version
 * of this check read a button with `<button\b([^>]*)>`, so the `>` of an
 * arrow function in `onClick={() => …}` ended the tag early and the button's
 * face was never read; and it knew fourteen verbs, so "Rename", "Sync",
 * "Review" and "Use … defaults" passed. Both holes shipped buttons.
 *
 * Here a tag ends at the first `>` outside braces, the face is every JSX text
 * run and every string literal between the tags (`{busy ? "Starting…" :
 * "Sign in"}` is a face too), and the verbs are the executing ones.
 */

/** The verbs of an action that executes. */
const EXECUTING =
  /^(Accept|Add|Allow|Apply|Approve|Authorize|Block|Cancel|Change|Check|Clear|Close|Confirm|Connect|Copy|Create|Decline|Delete|Deny|Detect|Disable|Discard|Disconnect|Dismiss|Download|Edit|Email|Enable|Enroll|Export|Finish|Forget|Generate|Grant|Import|Install|Issue|Keep|Link|Load|Lock|Mint|Move|Pause|Pin|Print|Prove|Publish|Refresh|Register|Reload|Remove|Rename|Renew|Replace|Request|Re-authorize|Reset|Restart|Restore|Resume|Retry|Review|Revoke|Rotate|Run|Save|Scan|Seal|Send|Share|Show|Start|Stop|Submit|Suggest|Switch|Sync|Test|Try|Undo|Unlink|Unlock|Unpin|Update|Upload|Use|Verify|View|Wipe|Withdraw)\b/;

/**
 * A button whose face may carry words: an icon key, the `.go` square, a
 * control that states a choice (a tab, a radio, a switch, a menu entry, a
 * pressed toggle), or one that names its choice object by class — the guest
 * and setup roads, the unlock screen's mode switch, a menu's entries, and
 * `choice` for any other button whose words are the thing chosen.
 */
const KEY = /\b(icon-btn|go)\b/;
const CHOICE_ROLE =
  /\brole="(tab|radio|switch|menuitem|menuitemradio|menuitemcheckbox|option)"|\baria-pressed=/;
const CHOICE_CLASS =
  /\b(choice|road|vault-row__body--road|unlock__switch|identity-ceremony__later|broker__link|account-switcher__(exit|add)|signin__menu-item)\b/;

/** Index just past the `>` that ends the tag opened at `from`. */
function tagEnd(source, from) {
  let depth = 0;
  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === ">" && depth === 0) return index + 1;
  }
  return source.length;
}

/** The words a button shows: JSX text, and string literals in its braces. */
function faces(inner) {
  const out = [];
  const text = inner
    .replace(/<[^>]*>/g, " ")
    .replace(/\{[^{}]*\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text) out.push(text);
  for (const match of inner.matchAll(/\{([^{}]*)\}/g)) {
    for (const literal of match[1].matchAll(/"([^"\n]+)"|`([^`$\n]+)/g)) {
      out.push((literal[1] ?? literal[2]).trim());
    }
  }
  return out;
}

/** Source offsets of every button that paints an executing verb. */
export function wordVerbHits(source) {
  const hits = [];
  for (const match of source.matchAll(/<button\b/g)) {
    const start = match.index ?? 0;
    const end = tagEnd(source, start);
    const tag = source.slice(start, end);
    if (tag.endsWith("/>")) continue;
    if (KEY.test(tag.match(/className=("[^"]*"|\{[\s\S]*?\})/)?.[1] ?? "")) {
      continue;
    }
    if (CHOICE_ROLE.test(tag) || CHOICE_CLASS.test(tag)) continue;
    const close = source.indexOf("</button>", end);
    if (close === -1) continue;
    if (faces(source.slice(end, close)).some((face) => EXECUTING.test(face))) {
      hits.push(start);
    }
  }
  return hits;
}
