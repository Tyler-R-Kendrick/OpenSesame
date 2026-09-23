import { overlapCast } from "@opensesame/os-domain";
/** Password generation and strength estimation. All randomness from crypto.getRandomValues. */

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const SYMBOLS = "!@#$%^&*()-_=+[]{};:,.?";
const AMBIGUOUS = "il1Lo0O";

export type CharOptions = {
  mode: "characters";
  length: number;
  lower: boolean;
  upper: boolean;
  digits: boolean;
  symbols: boolean;
  avoidAmbiguous: boolean;
};

export type PassphraseOptions = {
  mode: "passphrase";
  words: number;
  separator: string;
  capitalize: boolean;
  includeNumber: boolean;
};

export type GeneratorOptions = CharOptions | PassphraseOptions;

export const defaultCharOptions: CharOptions = {
  mode: "characters",
  length: 20,
  lower: true,
  upper: true,
  digits: true,
  symbols: true,
  avoidAmbiguous: true,
};

export const defaultPassphraseOptions: PassphraseOptions = {
  mode: "passphrase",
  words: 4,
  separator: "-",
  capitalize: true,
  includeNumber: true,
};

/** Uniform index in [0, max) without modulo bias. */
function randomIndex(max: number): number {
  if (max <= 0) throw new Error("randomIndex needs a positive bound");
  const limit = Math.floor(0xffffffff / max) * max;
  const buf = new Uint32Array(1);
  const view = new DataView(buf.buffer);
  let value: number;
  do {
    crypto.getRandomValues(buf);
    value = view.getUint32(0);
  } while (value >= limit);
  return value % max;
}

function pick(alphabet: string): string {
  return alphabet.charAt(randomIndex(alphabet.length));
}

function shuffle<T>(input: T[]): T[] {
  const out = [...input];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1);
    const a: T = overlapCast(out[i]);
    const b: T = overlapCast(out[j]);
    out[i] = b;
    out[j] = a;
  }
  return out;
}

export function generateCharacters(options: CharOptions): string {
  const pools: string[] = [];
  if (options.lower) pools.push(LOWER);
  if (options.upper) pools.push(UPPER);
  if (options.digits) pools.push(DIGITS);
  if (options.symbols) pools.push(SYMBOLS);
  if (pools.length === 0) {
    throw new Error("Choose at least one character set.");
  }

  const filter = (pool: string) =>
    options.avoidAmbiguous
      ? [...pool].filter((c) => !AMBIGUOUS.includes(c)).join("")
      : pool;

  const filtered = pools.map(filter).filter((pool) => pool.length > 0);
  const combined = filtered.join("");
  const length = Math.max(options.length, filtered.length);

  // One character from each selected set, remainder from the union, then shuffle.
  const required = filtered.map(pick);
  const rest = Array.from({ length: length - required.length }, () =>
    pick(combined),
  );
  return shuffle([...required, ...rest]).join("");
}

/**
 * EFF-style short wordlist subset. Bundled so generation works fully offline.
 * 1024 words would be ideal; this list is 256 words = 8 bits of entropy per word,
 * which the strength readout reports honestly rather than overstating.
 */
export const WORDS: readonly string[] = [
  "acorn",
  "agile",
  "album",
  "alloy",
  "amber",
  "anchor",
  "angle",
  "ankle",
  "apple",
  "apron",
  "arbor",
  "arena",
  "armor",
  "arrow",
  "aspen",
  "atlas",
  "attic",
  "auburn",
  "audio",
  "autumn",
  "bacon",
  "badge",
  "bagel",
  "baker",
  "balsa",
  "bamboo",
  "banjo",
  "barge",
  "basil",
  "basin",
  "batch",
  "beach",
  "beacon",
  "beagle",
  "beam",
  "bean",
  "bebop",
  "bedrock",
  "beech",
  "beetle",
  "bellow",
  "bench",
  "berry",
  "bison",
  "blade",
  "blaze",
  "bloom",
  "blossom",
  "bluff",
  "blush",
  "boat",
  "bobcat",
  "bolt",
  "bonsai",
  "boulder",
  "bounce",
  "bramble",
  "branch",
  "brass",
  "bread",
  "breeze",
  "bridge",
  "bright",
  "bronze",
  "brook",
  "broom",
  "brush",
  "bubble",
  "bucket",
  "buffalo",
  "bugle",
  "bundle",
  "bunker",
  "burrow",
  "butter",
  "button",
  "cabin",
  "cactus",
  "camel",
  "canal",
  "candle",
  "canopy",
  "canyon",
  "carbon",
  "cargo",
  "carrot",
  "castle",
  "cattle",
  "cavern",
  "cedar",
  "cellar",
  "cement",
  "cherry",
  "chess",
  "chime",
  "chisel",
  "cider",
  "cinder",
  "circus",
  "citrus",
  "clamp",
  "clarity",
  "clay",
  "cliff",
  "cloak",
  "clover",
  "cobalt",
  "cocoa",
  "comet",
  "compass",
  "copper",
  "coral",
  "cork",
  "cotton",
  "cougar",
  "cove",
  "crater",
  "crayon",
  "creek",
  "crescent",
  "crisp",
  "crown",
  "crystal",
  "cumin",
  "curry",
  "cypress",
  "dagger",
  "dahlia",
  "daisy",
  "damper",
  "dapple",
  "dawn",
  "decoy",
  "delta",
  "denim",
  "desert",
  "diner",
  "dingo",
  "dolphin",
  "domino",
  "donut",
  "dragon",
  "drift",
  "drum",
  "dune",
  "dusk",
  "eagle",
  "earth",
  "easel",
  "echo",
  "eclipse",
  "elder",
  "ember",
  "emerald",
  "engine",
  "ermine",
  "escape",
  "ether",
  "fable",
  "falcon",
  "fathom",
  "feather",
  "fennel",
  "fern",
  "ferry",
  "fiber",
  "fiddle",
  "filter",
  "finch",
  "fjord",
  "flame",
  "flannel",
  "flask",
  "flint",
  "floral",
  "flute",
  "forest",
  "fossil",
  "fox",
  "frost",
  "galaxy",
  "garden",
  "garnet",
  "gazelle",
  "geode",
  "ginger",
  "glacier",
  "glider",
  "gopher",
  "granite",
  "grape",
  "gravel",
  "grotto",
  "grove",
  "guitar",
  "gully",
  "gusto",
  "gypsum",
  "hammock",
  "harbor",
  "harvest",
  "hazel",
  "heather",
  "hedge",
  "helix",
  "hemlock",
  "heron",
  "hickory",
  "hollow",
  "honey",
  "hornet",
  "hurdle",
  "husky",
  "indigo",
  "inkwell",
  "iris",
  "island",
  "ivory",
  "jacket",
  "jasmine",
  "jetty",
  "jigsaw",
  "jungle",
  "juniper",
  "kayak",
  "kelp",
  "kernel",
  "kettle",
  "keystone",
  "kindle",
  "kite",
  "koala",
  "lagoon",
  "lantern",
  "larch",
  "lattice",
  "lava",
  "lavender",
  "ledger",
  "lemon",
  "lentil",
  "levee",
  "lichen",
  "lilac",
  "linen",
  "lobster",
  "locket",
  "lotus",
  "lumber",
  "lunar",
  "lyric",
  "magnet",
  "mahogany",
  "mallard",
  "mango",
  "maple",
  "marble",
  "marina",
] as const;

export function generatePassphrase(options: PassphraseOptions): string {
  const count = Math.max(3, Math.min(options.words, 12));
  const parts = Array.from({ length: count }, () => {
    const word: string = overlapCast(WORDS[randomIndex(WORDS.length)]);
    return options.capitalize
      ? word.charAt(0).toUpperCase() + word.slice(1)
      : word;
  });
  if (options.includeNumber) {
    const at = randomIndex(parts.length);
    parts[at] = `${parts[at]}${randomIndex(10)}`;
  }
  return parts.join(options.separator || "-");
}

export function generate(options: GeneratorOptions): string {
  return options.mode === "characters"
    ? generateCharacters(options)
    : generatePassphrase(options);
}

/** Entropy of a generator's own configuration — exact, not estimated. */
export function generatorEntropyBits(options: GeneratorOptions): number {
  if (options.mode === "passphrase") {
    const base =
      Math.max(3, Math.min(options.words, 12)) * Math.log2(WORDS.length);
    return Math.round(base + (options.includeNumber ? Math.log2(10) : 0));
  }
  let alphabet = 0;
  if (options.lower) alphabet += options.avoidAmbiguous ? 24 : 26;
  if (options.upper) alphabet += options.avoidAmbiguous ? 24 : 26;
  if (options.digits) alphabet += options.avoidAmbiguous ? 8 : 10;
  if (options.symbols) alphabet += SYMBOLS.length;
  if (alphabet === 0) return 0;
  return Math.round(options.length * Math.log2(alphabet));
}

export type Strength = {
  bits: number;
  score: 0 | 1 | 2 | 3 | 4;
  label: "Very weak" | "Weak" | "Fair" | "Strong" | "Excellent";
};

const COMMON = new Set([
  "password",
  "123456",
  "123456789",
  "qwerty",
  "111111",
  "12345678",
  "abc123",
  "1234567",
  "password1",
  "12345",
  "1234567890",
  "letmein",
  "welcome",
  "monkey",
  "dragon",
  "admin",
  "iloveyou",
  "sunshine",
  "princess",
  "football",
  "charlie",
  "aa123456",
  "donald",
  "qwerty123",
]);

const SEQUENCES = [
  "abcdefghijklmnopqrstuvwxyz",
  "01234567890",
  "qwertyuiop",
  "asdfghjkl",
];

/**
 * Entropy estimate for a password we did not generate. Deliberately pessimistic:
 * it penalises dictionary hits, repetition, and keyboard runs rather than
 * rewarding a password for merely containing a symbol.
 */
function estimateStrengthDefault(password: string): Strength {
  if (!password) return { bits: 0, score: 0, label: "Very weak" };

  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return { bits: 4, score: 0, label: "Very weak" };

  let alphabet = 0;
  if (/[a-z]/.test(password)) alphabet += 26;
  if (/[A-Z]/.test(password)) alphabet += 26;
  if (/[0-9]/.test(password)) alphabet += 10;
  if (/[^A-Za-z0-9]/.test(password)) alphabet += 33;

  const unique = new Set(password).size;
  const repetitionFactor = unique / password.length;
  let bits =
    password.length * Math.log2(Math.max(alphabet, 2)) * repetitionFactor;

  for (const sequence of SEQUENCES) {
    for (let i = 0; i + 3 <= sequence.length; i += 1) {
      if (lower.includes(sequence.slice(i, i + 3))) {
        bits -= 8;
        break;
      }
    }
  }
  if (/^\d+$/.test(password)) bits *= 0.55;
  if (/(.)\1{2,}/.test(password)) bits -= 6;

  bits = Math.max(0, Math.round(bits));
  const score: Strength["score"] =
    bits < 28 ? 0 : bits < 48 ? 1 : bits < 68 ? 2 : bits < 96 ? 3 : 4;
  const label = (["Very weak", "Weak", "Fair", "Strong", "Excellent"] as const)[
    score
  ];
  return { bits, score, label };
}

export const passwordSeams = {
  estimateStrength: estimateStrengthDefault,
};

export function estimateStrength(password: string): Strength {
  return passwordSeams.estimateStrength(password);
}
