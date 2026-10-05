import { generatorEntropyBits } from "@opensesame/app-core/lib/vault/generators/index.js";
import type {
  CharacterRules,
  PassphraseGenerator,
  PasswordGenerator,
} from "@opensesame/vault-core";

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="check">
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

/** Length, classes, floors and ambiguity: the options `rules`, `derived` and `sphinx` share. */
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
          label="A–Z"
          checked={rules.upper}
          onChange={(upper) => set({ upper })}
        />
        <Check
          label="a–z"
          checked={rules.lower}
          onChange={(lower) => set({ lower })}
        />
        <Check
          label="0–9"
          checked={rules.digits}
          onChange={(digits) => set({ digits })}
        />
        <Check
          label="Symbols"
          checked={rules.symbols}
          onChange={(symbols) => set({ symbols })}
        />
        <Check
          label="Avoid l1IO0"
          checked={rules.avoidAmbiguous}
          onChange={(avoidAmbiguous) => set({ avoidAmbiguous })}
        />
      </div>
      <div className="gen__checks">
        {rules.digits ? (
          <Count
            label="Minimum digits"
            value={rules.minDigits}
            max={64}
            onChange={(minDigits) => set({ minDigits })}
          />
        ) : null}
        {rules.symbols ? (
          <Count
            label="Minimum symbols"
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

/** One line of data about the chosen configuration; null when nothing is configured. */
function bitsOf(generator: PasswordGenerator): number | null {
  try {
    return generatorEntropyBits(generator);
  } catch {
    // No class chosen: the options say so by being unusable, not by a message.
    return null;
  }
}

/**
 * The chosen generator's own options, inline under its select (ADR 0172 §6).
 * `manual` has none. Entropy is the configuration's own, a data readout.
 */
export function GeneratorOptions({
  generator,
  onChange,
}: {
  generator: PasswordGenerator;
  onChange: (next: PasswordGenerator) => void;
}) {
  if (generator.id === "manual") return null;
  const bits = bitsOf(generator);
  return (
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
      {bits === null ? null : (
        <output className="gen__bits">≈{bits} bits</output>
      )}
    </div>
  );
}
