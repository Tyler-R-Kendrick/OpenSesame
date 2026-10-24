import type { Dispatch, SetStateAction } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconPlus } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

export type Person = Readonly<{
  id: string;
  name: string;
  hasPasskey: boolean;
}>;

type UnlockCircleFieldsProps = {
  name: string;
  setName: (value: string) => void;
  people: readonly Person[];
  selected: readonly string[];
  setSelected: Dispatch<SetStateAction<readonly string[]>>;
  maximum: number;
  wanted: number;
  setThreshold: (value: string) => void;
  onEnroll: (person: Person) => void;
  enrolling: string | null;
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
  onEnroll,
  enrolling,
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
              <li key={person.id} className="unlock-circle-person">
                <label>
                  <input
                    type="checkbox"
                    checked={selected.includes(person.id)}
                    disabled={
                      enrolling !== null ||
                      (!person.hasPasskey && !selected.includes(person.id))
                    }
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
                {person.hasPasskey ? null : (
                  <span className="unlock-circle-person__missing">
                    No passkey
                    <IconKey
                      small
                      label={`Enroll a passkey for ${person.name}`}
                      disabled={enrolling !== null}
                      onClick={() => onEnroll(person)}
                    >
                      <IconPlus size={14} />
                    </IconKey>
                  </span>
                )}
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
