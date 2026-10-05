import { generatorEntropyBits } from "@opensesame/app-core/lib/vault/generators/index.js";
import type {
  CharacterRules,
  PassphraseGenerator,
  PasswordGenerator,
} from "@opensesame/vault-core";

function Check({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  /** What the option means in plain words, on hover and long press. */
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="check" title={hint}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function Slider({
  label,
  min,
  max,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="gen__slider">
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="gen__num">{value}</span>
    </div>
  );
}

function Count({
  label,
  value,
  max,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="check gen__count">
      <span>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={0}
        max={max}
        value={value}
        onChange={(event) => {
          const next = Math.floor(Number(event.target.value));
          onChange(
            Number.isFinite(next) ? Math.min(max, Math.max(0, next)) : 0,
          );
        }}
      />
    </label>
  );
}

/** Length, character types, floors and look-alikes: the options `rules`, `derived` and `sphinx` share. */
function RuleOptions({
  rules,
  onChange,
}: {
  rules: CharacterRules;
  onChange: (next: CharacterRules) => void;
}) {
  const set = (changes: Partial<CharacterRules>) =>
    onChange({ ...rules, ...changes });
  return (
    <>
      <Slider
        label="Length"
        min={8}
        max={64}
        value={rules.length}
        onChange={(length) => set({ length })}
      />
      <div className="gen__checks">
        <Check
          label="Capital letters"
          checked={rules.upper}
          onChange={(upper) => set({ upper })}
        />
        <Check
          label="Lowercase letters"
          checked={rules.lower}
          onChange={(lower) => set({ lower })}
        />
        <Check
          label="Numbers"
          checked={rules.digits}
          onChange={(digits) => set({ digits })}
        />
        <Check
          label="Symbols"
          checked={rules.symbols}
          onChange={(symbols) => set({ symbols })}
        />
        <Check
          label="Avoid look-alike characters"
          hint="Leaves out characters that are easy to mix up, such as the letter l and the number 1"
          checked={rules.avoidAmbiguous}
          onChange={(avoidAmbiguous) => set({ avoidAmbiguous })}
        />
      </div>
      <div className="gen__checks">
        {rules.digits ? (
          <Count
            label="Fewest numbers"
            value={rules.minDigits}
            max={64}
            onChange={(minDigits) => set({ minDigits })}
          />
        ) : null}
        {rules.symbols ? (
          <Count
            label="Fewest symbols"
            value={rules.minSymbols}
            max={64}
            onChange={(minSymbols) => set({ minSymbols })}
          />
        ) : null}
      </div>
    </>
  );
}

function PassphraseOptions({
  generator,
  onChange,
}: {
  generator: PassphraseGenerator;
  onChange: (next: PassphraseGenerator) => void;
}) {
  const set = (changes: Partial<PassphraseGenerator>) =>
    onChange({ ...generator, ...changes });
  return (
    <>
      <Slider
        label="Word count"
        min={3}
        max={10}
        value={generator.words}
        onChange={(words) => set({ words })}
      />
      <div className="gen__checks">
        <Check
          label="Capitalise"
          checked={generator.capitalize}
          onChange={(capitalize) => set({ capitalize })}
        />
        <Check
          label="Add a number"
          checked={generator.includeNumber}
          onChange={(includeNumber) => set({ includeNumber })}
        />
        <label className="check gen__count">
          <span>Separator</span>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={generator.separator}
            maxLength={1}
            onChange={(event) => set({ separator: event.target.value })}
          />
        </label>
      </div>
    </>
  );
}

/** How hard the configuration is to guess, in a word; null when nothing is configured. */
function strengthOf(generator: PasswordGenerator): {
  word: string;
  bits: number;
} | null {
  let bits: number | null;
  try {
    bits = generatorEntropyBits(generator);
  } catch {
    // No type chosen: the options say so by being unusable, not by a message.
    return null;
  }
  if (bits === null) return null;
  const rounded = Math.round(bits);
  if (rounded >= 100) return { word: "Excellent", bits: rounded };
  if (rounded >= 70) return { word: "Strong", bits: rounded };
  if (rounded >= 50) return { word: "Fair", bits: rounded };
  return { word: "Weak", bits: rounded };
}

function kindsOf(rules: CharacterRules): string {
  const kinds: string[] = [];
  if (rules.upper && rules.lower) kinds.push("letters");
  else if (rules.upper) kinds.push("capital letters");
  else if (rules.lower) kinds.push("lowercase letters");
  if (rules.digits) kinds.push("numbers");
  if (rules.symbols) kinds.push("symbols");
  return kinds.length === 0 ? "nothing chosen" : kinds.join(", ");
}

/** The current choice in plain words: what the disclosure shows while it is closed. */
export function describeGenerator(generator: PasswordGenerator): string {
  switch (generator.id) {
    case "manual":
      return "";
    case "passphrase": {
      const extras = [
        generator.capitalize ? "capitalised" : "",
        generator.includeNumber ? "with a number" : "",
      ].filter((part) => part !== "");
      return [`${generator.words} words`, ...extras].join(", ");
    }
    case "rules":
      return `${generator.length} characters: ${kindsOf(generator)}`;
    case "derived":
    case "sphinx":
      return `${generator.rules.length} characters: ${kindsOf(generator.rules)}`;
  }
}

/**
 * The chosen generator's options (ADR 0172 §6, ADR 0173), kept out of the way:
 * one line says what the generator will make, and the options open from it.
 * `manual` has none.
 */
export function GeneratorOptions({
  generator,
  onChange,
}: {
  generator: PasswordGenerator;
  onChange: (next: PasswordGenerator) => void;
}) {
  if (generator.id === "manual") return null;
  const strength = strengthOf(generator);
  return (
    <details className="gen__more">
      <summary>{describeGenerator(generator)}</summary>
      <div className="gen__opts">
        {generator.id === "rules" ? (
          <RuleOptions
            rules={generator}
            onChange={(rules) => onChange({ id: "rules", ...rules })}
          />
        ) : null}
        {generator.id === "derived" ? (
          <RuleOptions
            rules={generator.rules}
            onChange={(rules) => onChange({ ...generator, rules })}
          />
        ) : null}
        {generator.id === "passphrase" ? (
          <PassphraseOptions generator={generator} onChange={onChange} />
        ) : null}
        {generator.id === "sphinx" ? (
          <>
            <RuleOptions
              rules={generator.rules}
              onChange={(rules) => onChange({ ...generator, rules })}
            />
            <div className="gen__checks">
              <Count
                label="Counter"
                value={generator.counter}
                max={9999}
                onChange={(counter) => onChange({ ...generator, counter })}
              />
            </div>
          </>
        ) : null}
        {strength === null ? null : (
          <output
            className="gen__bits"
            title={`About ${strength.bits} bits of guesswork`}
          >
            {strength.word}
          </output>
        )}
      </div>
    </details>
  );
}
