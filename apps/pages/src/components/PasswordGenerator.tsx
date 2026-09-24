import {
  type CharOptions,
  type GeneratorOptions,
  type PassphraseOptions,
  defaultCharOptions,
  defaultPassphraseOptions,
  generate,
  generatorEntropyBits,
} from "@opensesame/app-core/lib/vault/password.js";
import { useCallback, useEffect, useState } from "react";
import { useCopyFeedback } from "./FieldRow.js";
import { FormCommit } from "./FormCommit.js";
import { IconKey } from "./IconKey.js";
import { IconCheck, IconCopy, IconRefresh, IconX } from "./Icons.js";

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
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

/**
 * Inline generator. Rendered where the password is being chosen, so it never
 * interrupts the edit it belongs to.
 */
export function PasswordGenerator({
  onUse,
  onDismiss,
}: {
  onUse: (value: string) => void;
  onDismiss?: () => void;
}) {
  const [charOptions, setCharOptions] =
    useState<CharOptions>(defaultCharOptions);
  const [phraseOptions, setPhraseOptions] = useState<PassphraseOptions>(
    defaultPassphraseOptions,
  );
  const [mode, setMode] = useState<GeneratorOptions["mode"]>("characters");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { copied, copy } = useCopyFeedback();

  const options: GeneratorOptions =
    mode === "characters" ? charOptions : phraseOptions;

  const roll = useCallback((next: GeneratorOptions) => {
    try {
      setValue(generate(next));
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not generate.",
      );
      setValue("");
    }
  }, []);

  // Regenerate whenever the configuration changes.
  useEffect(() => {
    roll(options);
  }, [roll, options]);

  const bits = generatorEntropyBits(options);

  return (
    <div className="gen">
      <div className="gen__out">
        <span className="gen__value">{value || "—"}</span>
        <IconKey label="Generate another" onClick={() => roll(options)}>
          <IconRefresh size={17} />
        </IconKey>
        <button
          type="button"
          className={`icon-btn${copied === "gen" ? " is-on" : ""}`}
          onClick={() => void copy("gen", value)}
          aria-label="Copy generated password"
          title="Copy"
          disabled={!value}
        >
          {copied === "gen" ? <IconCheck size={17} /> : <IconCopy size={17} />}
        </button>
      </div>

      <fieldset className="gen__modes" aria-label="Generator type">
        <button
          type="button"
          className="gen__mode"
          aria-pressed={mode === "characters"}
          onClick={() => setMode("characters")}
        >
          Characters
        </button>
        <button
          type="button"
          className="gen__mode"
          aria-pressed={mode === "passphrase"}
          onClick={() => setMode("passphrase")}
        >
          Passphrase
        </button>
      </fieldset>

      <div className="gen__opts">
        {mode === "characters" ? (
          <>
            <div className="gen__slider">
              <label htmlFor="gen-length" className="visually-hidden">
                Length
              </label>
              <input
                id="gen-length"
                type="range"
                min={8}
                max={64}
                value={charOptions.length}
                onChange={(e) =>
                  setCharOptions({
                    ...charOptions,
                    length: Number(e.target.value),
                  })
                }
              />
              <span className="gen__num">{charOptions.length}</span>
            </div>
            <div className="gen__checks">
              <Check
                label="A–Z"
                checked={charOptions.upper}
                onChange={(upper) => setCharOptions({ ...charOptions, upper })}
              />
              <Check
                label="a–z"
                checked={charOptions.lower}
                onChange={(lower) => setCharOptions({ ...charOptions, lower })}
              />
              <Check
                label="0–9"
                checked={charOptions.digits}
                onChange={(digits) =>
                  setCharOptions({ ...charOptions, digits })
                }
              />
              <Check
                label="Symbols"
                checked={charOptions.symbols}
                onChange={(symbols) =>
                  setCharOptions({ ...charOptions, symbols })
                }
              />
              <Check
                label="Avoid l1IO0"
                checked={charOptions.avoidAmbiguous}
                onChange={(avoidAmbiguous) =>
                  setCharOptions({ ...charOptions, avoidAmbiguous })
                }
              />
            </div>
          </>
        ) : (
          <>
            <div className="gen__slider">
              <label htmlFor="gen-words" className="visually-hidden">
                Word count
              </label>
              <input
                id="gen-words"
                type="range"
                min={3}
                max={10}
                value={phraseOptions.words}
                onChange={(e) =>
                  setPhraseOptions({
                    ...phraseOptions,
                    words: Number(e.target.value),
                  })
                }
              />
              <span className="gen__num">{phraseOptions.words}</span>
            </div>
            <div className="gen__checks">
              <Check
                label="Capitalise"
                checked={phraseOptions.capitalize}
                onChange={(capitalize) =>
                  setPhraseOptions({ ...phraseOptions, capitalize })
                }
              />
              <Check
                label="Add a number"
                checked={phraseOptions.includeNumber}
                onChange={(includeNumber) =>
                  setPhraseOptions({ ...phraseOptions, includeNumber })
                }
              />
              <label className="check">
                <span>Separator</span>
                <input
                  type="text"
                  value={phraseOptions.separator}
                  maxLength={1}
                  style={{ width: "3rem" }}
                  onChange={(e) =>
                    setPhraseOptions({
                      ...phraseOptions,
                      separator: e.target.value,
                    })
                  }
                />
              </label>
            </div>
          </>
        )}
      </div>

      {error ? (
        <p className="note note--err" role="alert">
          <span>{error}</span>
        </p>
      ) : (
        <p className="hint">
          {bits} bits of entropy — the generator's own configuration, not an
          estimate.
        </p>
      )}

      <FormCommit
        label="Use this password"
        disabled={!value}
        onClick={() => onUse(value)}
      >
        {onDismiss ? (
          <IconKey label="Close generator" onClick={onDismiss}>
            <IconX size={16} />
          </IconKey>
        ) : null}
      </FormCommit>
    </div>
  );
}
