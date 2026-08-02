import "dotenv/config";
import { prisma } from "@/lib/db";
import { buildLocalFirms, trustedDistanceForLocation } from "@/lib/localFirms";
import { getNearbySearchPreference, runNearbyFirmSearch, setNearbySearchPreference } from "@/lib/sync/nearbyDiscovery";

let failures = 0;
function check(condition: boolean, message: string) {
  if (condition) console.log(`  PASS: ${message}`);
  else { console.error(`  FAIL: ${message}`); failures++; }
}

async function main() {
  console.log("1) Search center is fixed at Clifton and radius is configurable");
  await setNearbySearchPreference({ centerAddress: "Clifton, NJ", lat: 40.8584, lng: -74.1638, radiusMiles: 100 });
  const preference = await getNearbySearchPreference();
  check(preference.centerAddress === "Clifton, NJ", `center is Clifton, NJ (got ${preference.centerAddress})`);
  check(preference.radiusMiles === 100, `radius persists (got ${preference.radiusMiles})`);

  console.log("\n2) Deterministic verified-location fixtures never invent distance");
  const near = trustedDistanceForLocation("Newark, NJ");
  const far = trustedDistanceForLocation("Albany, NY", 145.2);
  const remote = trustedDistanceForLocation("Remote - United States");
  const unknown = trustedDistanceForLocation("Somewhere in New Jersey");
  check(near.trusted && near.distanceMiles !== null && near.distanceMiles < 25, `known near city gets a derived distance (${near.distanceMiles})`);
  check(far.trusted && far.distanceMiles === 145.2, "an exact stored verified distance is preserved");
  check(remote.trusted && remote.distanceMiles === null && /Remote/.test(remote.reason), "remote fixture remains remote without an invented distance");
  check(!unknown.trusted && unknown.distanceMiles === null && unknown.reason === "Location not yet verified", "unknown location is visibly unverified");

  console.log("\n3) Local Firms uses only approved employer records and verified jobs");
  const result = await buildLocalFirms(150);
  const allowedCompanyIds = new Set((await prisma.company.findMany({ where: { allowlisted: true, source: { in: ["csv", "manual", "intern-list-approved"] } }, select: { id: true } })).map((row) => row.id));
  check(result.firms.every((firm) => allowedCompanyIds.has(firm.id)), "every displayed firm belongs to the approved-source set");
  check(result.diagnostics.approvedEmployersChecked === result.firms.length, "diagnostic checked count matches displayed approved firms");

  console.log("\n4) L3Harris uses the official careers URL and is marked high fit");
  const l3 = result.firms.find((firm) => firm.employer === "L3Harris Technologies");
  check(l3?.careersUrl === "https://careers.l3harris.com/", `official L3Harris careers URL is retained (got ${l3?.careersUrl})`);
  check(l3?.highFit === true, "L3Harris is marked high fit");

  console.log("\n5) Compatibility search wrapper uses the same approved-source builder");
  const wrapper = await runNearbyFirmSearch();
  check(wrapper.configured === true, "Local Firms does not depend on Google Places configuration");
  check(wrapper.discovered === result.firms.length, "wrapper reports only approved firms");
  await setNearbySearchPreference({ centerAddress: "Clifton, NJ", lat: 40.8584, lng: -74.1638, radiusMiles: 50 });

  console.log(failures === 0 ? "\nAll Local Firms tests PASSED." : `\n${failures} test(s) FAILED.`);
  if (failures) process.exitCode = 1;
}

main().catch((error) => { console.error("Local Firms test crashed:", error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
