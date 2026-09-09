import { setTimeout } from "node:timers/promises";
import { stampRelease, verifyRelease } from "./lib/pages-release.mjs";

const [mode, target, revision] = process.argv.slice(2);
if (process.argv.length !== 5 || !["stamp", "verify"].includes(mode))
  throw new Error("Usage: pages-release.mjs stamp|verify DIRECTORY|URL SHA");
if (mode === "stamp") {
  stampRelease(target, revision);
  console.log(`Stamped Pages release ${revision}`);
} else {
  // Pages/CDN propagation is asynchronous; every attempt checks the same SHA.
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      await verifyRelease(target, revision);
      console.log(`Verified live Pages release ${revision}`);
      break;
    } catch (error) {
      if (attempt === 8) throw error;
      console.log(`Release not visible yet (attempt ${attempt}/8)`);
      await setTimeout(5000);
    }
  }
}
