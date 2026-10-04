/**
 * Where the time goes in `verify:siop`, and a bound on every step.
 *
 * A step that runs past its budget fails with its own name, so a slow runner
 * says which journey is slow instead of letting the job's own timeout cancel
 * the whole run with nothing said. Each finished step prints `TIME <seconds>
 * <name>`, and `printTimings` prints the table the next CI log is read from.
 */

const finished = [];

/** The longest any single journey step may take before it is called hung. */
export const STEP_BUDGET_MS = 90_000;

/**
 * Run `work` and fail with a clear message if it takes longer than `budgetMs`.
 * The work itself is not cancelled (a Playwright wait has its own timeout);
 * the run stops waiting for it and says which step it was.
 *
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} work
 * @param {number} [budgetMs]
 * @returns {Promise<T>}
 */
export async function timed(name, work, budgetMs = STEP_BUDGET_MS) {
  const started = Date.now();
  let timer;
  const hung = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `verify:siop step "${name}" did not finish within ${budgetMs / 1000}s`,
        ),
      );
    }, budgetMs);
  });
  try {
    return await Promise.race([work(), hung]);
  } finally {
    clearTimeout(timer);
    const seconds = (Date.now() - started) / 1000;
    finished.push({ name, seconds });
    console.log(`TIME ${seconds.toFixed(1).padStart(6)}s ${name}`);
  }
}

/** The slowest steps first, then the total of the steps measured. */
export function printTimings() {
  const rows = [...finished].sort((a, b) => b.seconds - a.seconds);
  const total = rows.reduce((sum, row) => sum + row.seconds, 0);
  console.log("TIMINGS (slowest first)");
  for (const row of rows) {
    console.log(`  ${row.seconds.toFixed(1).padStart(6)}s  ${row.name}`);
  }
  console.log(`  ${total.toFixed(1).padStart(6)}s  total of measured steps`);
}
