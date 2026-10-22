import { isString } from "@opensesame/os-domain";
/** ICAO 9303 TD3 passport MRZ: check digits, a parser, and a synthetic generator. */
import type { FieldValues } from "@opensesame/vault-item-types";
import type { ItemFormat } from "./types.js";

const WEIGHTS = [7, 3, 1] as const;
const COUNTRY = /^[A-Z]{3}$/u;
const LINE = /^[A-Z0-9<]+$/u;

const DOCUMENT_TYPES: Readonly<Record<string, string>> = {
  "P<": "ordinary",
  PO: "official",
  PD: "diplomatic",
  PS: "service",
  PE: "emergency",
};

function text(values: FieldValues, id: string): string {
  const value = values[id];
  return isString(value) ? value : "";
}

function checkDigit(input: string): string {
  let sum = 0;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "<";
    const value =
      char === "<"
        ? 0
        : char >= "0" && char <= "9"
          ? Number(char)
          : char >= "A" && char <= "Z"
            ? char.charCodeAt(0) - 55
            : 0;
    sum += value * (WEIGHTS[index % 3] ?? 1);
  }
  return String(sum % 10);
}

function dateFromMrz(raw: string, birthday: boolean): string | null {
  if (!/^\d{6}$/u.test(raw)) return null;
  const yy = Number(raw.slice(0, 2));
  const year = birthday
    ? yy <= new Date().getUTCFullYear() % 100
      ? 2000 + yy
      : 1900 + yy
    : 2000 + yy;
  const month = raw.slice(2, 4);
  const day = raw.slice(4, 6);
  const date = new Date(Date.UTC(year, Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  )
    return null;
  return `${year}-${month}-${day}`;
}

function mrzDate(iso: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(iso);
  if (!match) return null;
  return `${match[1]?.slice(2)}${match[2]}${match[3]}`;
}

function mrzName(value: string): string {
  const parts = value
    .toUpperCase()
    .replaceAll(/[^A-Z ]/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (parts.length === 0) return "";
  const [surname, ...given] = parts;
  return `${surname}${given.length > 0 ? `<<${given.join("<")}` : "<<"}`;
}

function nameFromMrz(value: string): string {
  return value.replaceAll("<", " ").replaceAll(/\s+/gu, " ").trim();
}

function sexFromMrz(value: string): string {
  return value === "M" || value === "F" ? value : "";
}

function sexForMrz(value: string): string {
  return value === "M" || value === "F" ? value : "<";
}

function line2(values: FieldValues): string | null {
  const number = text(values, "documentNumber")
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]/gu, "");
  const birth = mrzDate(text(values, "dateOfBirth"));
  const expiry = mrzDate(text(values, "expiresAt"));
  const nationality = text(values, "nationality").toUpperCase();
  if (!number || !birth || !expiry || !COUNTRY.test(nationality)) return null;
  const document = number.padEnd(9, "<").slice(0, 9);
  const personal = "<".repeat(14);
  const partial = `${document}${checkDigit(document)}${nationality}${birth}${checkDigit(birth)}${sexForMrz(text(values, "sex"))}${expiry}${checkDigit(expiry)}${personal}${checkDigit(personal)}`;
  const composite = checkDigit(
    `${document}${checkDigit(document)}${birth}${checkDigit(birth)}${expiry}${checkDigit(expiry)}${personal}${checkDigit(personal)}`,
  );
  return `${partial}${composite}`;
}

function line1(values: FieldValues): string | null {
  const country = text(values, "issuingCountry").toUpperCase();
  if (!COUNTRY.test(country)) return null;
  const type =
    Object.entries(DOCUMENT_TYPES).find(
      ([, label]) => label === text(values, "documentType"),
    )?.[0] ?? "P<";
  return `${type}${country}${mrzName(text(values, "fullName")).padEnd(39, "<").slice(0, 39)}`;
}

function canonical(values: FieldValues): string | null {
  const first = line1(values);
  const second = line2(values);
  return first && second ? `${first}\n${second}` : null;
}

function mrzLines(value: string): [string, string] | null {
  const lines = value.trim().split(/\r?\n/u);
  if (lines.length !== 2) return null;
  const [first = "", second = ""] = lines;
  if (first.length !== 44 || second.length !== 44) return null;
  if (!LINE.test(first) || !LINE.test(second)) return null;
  return [first, second];
}

function checksPass(second: string): boolean {
  const checks = [
    [second.slice(0, 9), second[9]],
    [second.slice(13, 19), second[19]],
    [second.slice(21, 27), second[27]],
  ] as const;
  return checks.every(([input, digit]) => checkDigit(input) === digit);
}

function datesOf(second: string): {
  dateOfBirth: string;
  expiresAt: string;
} | null {
  const dateOfBirth = dateFromMrz(second.slice(13, 19), true);
  const expiresAt = dateFromMrz(second.slice(21, 27), false);
  return dateOfBirth && expiresAt ? { dateOfBirth, expiresAt } : null;
}

function parse(value: string): FieldValues | null {
  const lines = mrzLines(value);
  if (!lines) return null;
  const [first, second] = lines;
  const documentType = DOCUMENT_TYPES[first.slice(0, 2)];
  if (!documentType) return null;
  const country = first.slice(2, 5);
  if (!COUNTRY.test(country) || !checksPass(second)) return null;
  const composite = `${second.slice(0, 10)}${second.slice(13, 20)}${second.slice(21, 28)}${second.slice(28, 43)}`;
  if (checkDigit(composite) !== second[43]) return null;
  const dates = datesOf(second);
  if (!dates) return null;
  return {
    issuingCountry: country,
    documentNumber: second.slice(0, 9).replaceAll("<", ""),
    documentType,
    fullName: nameFromMrz(first.slice(5)),
    nationality: second.slice(10, 13),
    dateOfBirth: dates.dateOfBirth,
    sex: sexFromMrz(second[20] ?? "<"),
    expiresAt: dates.expiresAt,
  };
}

function generate({
  random,
  now,
}: { random: import("./random.js").Random; now: Date }): FieldValues {
  const date = new Date(now.getTime());
  date.setUTCFullYear(date.getUTCFullYear() + 5);
  const expiresAt = date.toISOString().slice(0, 10);
  return {
    issuingCountry: "GBR",
    documentNumber: random.string("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 9),
    documentType: "ordinary",
    fullName: "SPECIMEN TEST",
    nationality: "GBR",
    dateOfBirth: "1990-01-01",
    sex: "",
    expiresAt,
  };
}

export const passportFormat: ItemFormat = {
  id: "passport:mrz-td3",
  typeId: "passport",
  label: "Passport MRZ",
  specificity: 100,
  parse,
  generate,
  canonical,
};
