import type { Dispatch, SetStateAction } from "react";
import { StatusMark } from "../../components/StatusMark.js";

export type Person = Readonly<{ id: string; name: string }>;

type UnlockCircleFieldsProps = {
  name: string;
  setName: (value: string) => void;
  people: readonly Person[];
  selected: readonly string[];
  setSelected: Dispatch<SetStateAction<readonly string[]>>;
  maximum: number;
  wanted: number;
  setThreshold: (value: string) => void;
};

export function UnlockCircleFields({
  name,
  setName,
  people,
  selected,
  setSelected,
  maximum,
  wanted,
  setThreshold,
}: UnlockCircleFieldsProps) {
  return (
    <>
      <div className="field">
        <label htmlFor="unlock-circle-name">Name</label>
        <input
          id="unlock-circle-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <fieldset className="f">
        <legend className="f__label">People</legend>
        {people.length === 0 ? (
          <StatusMark
            tone="idle"
            label="Add a person with a passkey in Identity first."
          />
        ) : (
          <ul className="unlock-circle-people">
            {people.map((person) => (
              <li key={person.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.includes(person.id)}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, person.id]
                          : current.filter((id) => id !== person.id),
                      )
                    }
                  />
                  {person.name}
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      {maximum > 0 ? (
        <div className="field">
          <label htmlFor="unlock-circle-threshold">Required approvals</label>
          <select
            id="unlock-circle-threshold"
            value={String(wanted)}
            onChange={(event) => setThreshold(event.target.value)}
          >
            {Array.from({ length: maximum }, (_, index) => index + 1).map(
              (count) => (
                <option key={count} value={count}>
                  {count} of {maximum}
                </option>
              ),
            )}
          </select>
        </div>
      ) : null}
    </>
  );
}
