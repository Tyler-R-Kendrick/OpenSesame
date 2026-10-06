import {
  type AccountItem,
  type LoginMethod,
  apiKeyHeaderLine,
  bearerHeaderLine,
  handoff,
  producePassword,
} from "@opensesame/vault-core";
import { currentTotp } from "../../components/TotpCode.js";
import { methodTitle } from "./MethodPicker.js";

/**
 * One thing an account can put on the clipboard. An account holds several
 * credentials (a password, an API key, a token, a client secret, an
 * authenticator), so "copy" asks which; the menu lists these.
 */
export type CredentialChoice = {
  id: string;
  /** What the person reads in the menu: `Password`, `API key as header`. */
  label: string;
  /** What goes on the clipboard, or `null` when there is nothing to copy. */
  read: () => string | null | Promise<string | null>;
  /** The kind of method it comes from. */
  type: LoginMethod["type"];
  /** The one the `y` key copies for an account. */
  primary?: boolean;
};

const hasText = (value: string) => value.trim() !== "";

type Bare = Omit<CredentialChoice, "type">;

function bareChoices(
  methods: readonly LoginMethod[],
  method: LoginMethod,
): Bare[] {
  const title = methodTitle(methods, method);
  switch (method.type) {
    case "password": {
      const out = handoff(producePassword(method));
      if (out === null || out.now === "") return [];
      const choices: Bare[] = [
        {
          id: `${method.id}:password`,
          label: title,
          read: () => out.now,
          primary: true,
        },
      ];
      // A pepper in the middle leaves a rest to copy after the person's own.
      if (out.later !== "") {
        choices.push({
          id: `${method.id}:rest`,
          label: `Rest of ${title.toLowerCase()}`,
          read: () => out.later,
        });
      }
      return choices;
    }
    case "api-key":
      return hasText(method.key)
        ? [
            { id: `${method.id}:key`, label: title, read: () => method.key },
            {
              id: `${method.id}:line`,
              label: `${title} as header`,
              read: () => apiKeyHeaderLine(method.header, method.key),
              primary: true,
            },
          ]
        : [];
    case "token":
      return hasText(method.token)
        ? [
            {
              id: `${method.id}:token`,
              label: title,
              read: () => method.token,
            },
            {
              id: `${method.id}:line`,
              label: `${title} as bearer`,
              read: () => bearerHeaderLine(method.token),
              primary: true,
            },
          ]
        : [];
    case "oauth": {
      const oauth: (Bare | null)[] = [
        hasText(method.clientSecret)
          ? {
              id: `${method.id}:secret`,
              label: `${title} client secret`,
              read: () => method.clientSecret,
            }
          : null,
        hasText(method.refreshToken)
          ? {
              id: `${method.id}:refresh`,
              label: `${title} refresh token`,
              read: () => method.refreshToken,
            }
          : null,
      ];
      return oauth.filter((choice): choice is Bare => choice !== null);
    }
    case "authenticator":
      return hasText(method.secret)
        ? [
            {
              id: `${method.id}:code`,
              label: `${title} code`,
              read: () => currentTotp(method.secret).catch(() => null),
            },
          ]
        : [];
  }
}

function choicesFor(
  methods: readonly LoginMethod[],
  method: LoginMethod,
): CredentialChoice[] {
  return bareChoices(methods, method).map((choice) => ({
    ...choice,
    type: method.type,
  }));
}

/**
 * Every credential an account can copy, in the order its methods are kept. A
 * password gives the part before a pepper's slot (never asked for) and, when
 * the slot is inside it, the rest; an API key gives the key and the header
 * line a request takes; a token the token and its bearer line.
 *
 * `y` copies the first password, else the first API key or token as its line;
 * that is the choice marked `primary`, and the one the menu shows the key on.
 */
export function credentialChoices(
  item: Pick<AccountItem, "methods">,
): CredentialChoice[] {
  const all = item.methods.flatMap((method) =>
    choicesFor(item.methods, method),
  );
  // The order `y` copies in: the password, else an API key's line, else a
  // token's (`credentialLine`).
  const primary =
    all.find((choice) => choice.type === "password" && choice.primary) ??
    all.find((choice) => choice.type === "api-key" && choice.primary) ??
    all.find((choice) => choice.type === "token" && choice.primary);
  return all.map((choice) => ({ ...choice, primary: choice === primary }));
}
