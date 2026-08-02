import "dotenv/config";
import { classifyLocation, haversineMiles, CLIFTON_NJ, resolveCoordinates } from "@/lib/geo/geofilter";

let failures = 0;
function check(cond: boolean, msg: string) { if (cond) console.log(`  PASS: ${msg}`); else { console.error(`  FAIL: ${msg}`); failures++; } }

function main() {
  console.log("Local Firms geofilter (origin: Clifton, NJ)\n");

  console.log("1) Default radius = 50 miles");
  const r = 50;
  const clifton = classifyLocation("Clifton, NJ", r);
  check(clifton.bucket === "local" && clifton.distanceMiles === 0, `Clifton, NJ → local, ${clifton.distanceMiles}mi`);
  const newark = classifyLocation("Newark, NJ", r);
  check(newark.bucket === "local" && (newark.distanceMiles ?? 99) < 15, `Newark, NJ → local, ${newark.distanceMiles}mi`);
  const nyc = classifyLocation("New York, NY", r);
  check(nyc.bucket === "local" && (nyc.distanceMiles ?? 99) < 20, `New York, NY → local (within 50mi), ${nyc.distanceMiles}mi`);
  const parsippany = classifyLocation("Parsippany, NJ", r);
  check(parsippany.bucket === "local" && (parsippany.distanceMiles ?? 99) < 25, `Parsippany, NJ → local, ${parsippany.distanceMiles}mi`);

  console.log("\n2) Philadelphia depends on radius");
  const phillyAt50 = classifyLocation("Philadelphia, PA", 50);
  const phillyAt100 = classifyLocation("Philadelphia, PA", 100);
  check(phillyAt50.bucket === "outside", `Philadelphia, PA @50mi → outside (${phillyAt50.distanceMiles}mi)`);
  check(phillyAt100.bucket === "local", `Philadelphia, PA @100mi → local (${phillyAt100.distanceMiles}mi)`);

  console.log("\n3) Distant states are excluded");
  const la = classifyLocation("Los Angeles, CA", r);
  check(la.bucket === "outside" && (la.distanceMiles ?? 0) > 2000, `Los Angeles, CA → outside (${la.distanceMiles}mi)`);
  const sf = classifyLocation("San Francisco, CA", r);
  check(sf.bucket === "outside" && (sf.distanceMiles ?? 0) > 2000, `San Francisco, CA → outside (${sf.distanceMiles}mi)`);
  // Even with only a state (no city), California resolves far away and is excluded.
  const caState = classifyLocation("Somewhere, CA", r);
  check(caState.bucket === "outside", `"Somewhere, CA" (state centroid) → outside (${caState.distanceMiles}mi)`);

  console.log("\n4) Unknown locations are excluded from default local list (never distance 0)");
  const empty = classifyLocation("", r);
  check(empty.bucket === "unknown" && empty.distanceMiles === null, `empty location → unknown, null distance`);
  const gibberish = classifyLocation("Undisclosed", r);
  check(gibberish.bucket === "unknown" && gibberish.distanceMiles === null, `"Undisclosed" → unknown, null distance`);
  check(resolveCoordinates("Undisclosed").coords === null, `unresolvable location yields null coords (not 0,0)`);

  console.log("\n5) Remote is local with a null distance");
  const remote = classifyLocation("Remote, USA", r);
  check(remote.bucket === "local" && remote.distanceMiles === null && remote.precision === "remote", `Remote → local, null distance`);

  console.log("\n6) Stored exact distance is trusted");
  const stored = classifyLocation("Anywhere, ZZ", 50, 12.3);
  check(stored.bucket === "local" && stored.distanceMiles === 12.3, `stored 12.3mi → local`);
  const storedFar = classifyLocation("Anywhere, ZZ", 50, 300);
  check(storedFar.bucket === "outside" && storedFar.distanceMiles === 300, `stored 300mi → outside`);

  console.log("\n7) Haversine sanity");
  check(haversineMiles(CLIFTON_NJ, CLIFTON_NJ) === 0, "distance to self is 0");

  console.log(failures === 0 ? "\nAll local-firms geofilter tests PASSED." : `\n${failures} test(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main();
