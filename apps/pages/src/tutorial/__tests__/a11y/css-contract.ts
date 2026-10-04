/**
 * A deliberately small CSS reader for the stylesheet contract suites: enough
 * for the hand-written files this feature ships, and no more. jsdom has no
 * cascade, so the contracts are assertions about the source.
 */

export type CssRule = {
  readonly selectors: readonly string[];
  readonly body: string;
  /** At-rule preludes enclosing this rule, outermost first. */
  readonly context: readonly string[];
};

function matchingBrace(css: string, from: number): number {
  let depth = 1;
  for (let index = from; index < css.length; index += 1) {
    const character = css[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("unbalanced stylesheet");
}

/**
 * A deliberately small reader: enough for these two hand-written files, and
 * no more. `@keyframes` bodies are skipped outright — their `0%`/`to` steps
 * are not selectors and would only ever be false positives.
 */
export function parseRules(source: string): readonly CssRule[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: CssRule[] = [];
  const context: string[] = [];
  let prelude = "";
  let index = 0;
  while (index < css.length) {
    const character = css[index];
    if (character === "{") {
      const head = prelude.trim();
      prelude = "";
      index += 1;
      if (head.startsWith("@keyframes")) {
        index = matchingBrace(css, index) + 1;
      } else if (head.startsWith("@")) {
        context.push(head);
      } else {
        const end = matchingBrace(css, index);
        rules.push({
          selectors: head
            .split(",")
            .map((selector) => selector.trim())
            .filter((selector) => selector.length > 0),
          body: css.slice(index, end),
          context: [...context],
        });
        index = end + 1;
      }
      continue;
    }
    if (character === "}") {
      context.pop();
      index += 1;
      continue;
    }
    prelude += character;
    index += 1;
  }
  return rules;
}

/** The compound a selector starts with — what the rule is anchored on. */
export function anchor(selector: string): string {
  const first = selector.split(/[\s>+~]+/)[0];
  return first ?? selector;
}

export function reduced(rule: CssRule): boolean {
  return rule.context.some((prelude) =>
    prelude.includes("prefers-reduced-motion: reduce"),
  );
}

export function declarations(
  rule: CssRule,
  property: string,
): readonly string[] {
  const found: string[] = [];
  for (const line of rule.body.split(";")) {
    const [name, ...rest] = line.split(":");
    if ((name ?? "").trim() !== property) continue;
    found.push(rest.join(":").trim());
  }
  return found;
}

/** The one rule for a selector, or a failure that names what is missing. */
export function ruleFor(
  rules: readonly CssRule[],
  selector: string,
  within?: string,
): CssRule {
  const found = rules.find(
    (rule) =>
      rule.selectors.includes(selector) &&
      (within === undefined ||
        rule.context.some((prelude) => prelude.includes(within))),
  );
  if (!found) throw new Error(`no rule for ${selector}`);
  return found;
}
