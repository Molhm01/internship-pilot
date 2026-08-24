import "dotenv/config";
import { prisma } from "@/lib/db";
import { buildLocalFirms, trustedDistanceForLocation } from "@/lib/localFirms";
import { getNearbySearchPreference, runNearbyFirmSearch, setNearbySearchPreference } from "@/lib/sync/nearbyDiscovery";

let failures = 0;
function check(condition: boolean, message: string) {
  if (condition) console.log(`  PASS: ${message}`);
  else { console.error(`  FAIL: ${message}`); failures++; }
}

const PREFIX = "Nearby Release Audit";
const EMAIL_PREFIX = "nearby-release-audit";

async function cleanup() {
  await prisma.job.deleteMany({ where: { company: { startsWith: PREFIX } } });
  await prisma.company.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
}

async function main() {
  await cleanup();
  const user = await prisma.user.create({
    data: { email: `${EMAIL_PREFIX}-${Date.now()}@example.com`, name: "Nearby Audit", emailVerified: true },
  });

  console.log("1) Nearby radius is stored per user; the default center remains Clifton");
  await setNearbySearchPreference(user.id, { centerAddress: "Clifton, NJ", lat: 40.8584, lng: -74.1638, radiusMiles: 100 });
  const preference = await getNearbySearchPreference(user.id);
  check(preference.centerAddress === "Clifton, NJ", `center is Clifton, NJ (got ${preference.centerAddress})`);
  check(preference.radiusMiles === 100, `radius persists for this user (got ${preference.radiusMiles})`);

  console.log("\n2) Deterministic verified-location fixtures never invent distance");
  const near = trustedDistanceForLocation("Newark, NJ");
  const far = trustedDistanceForLocation("Albany, NY", 145.2);
  const remote = trustedDistanceForLocation("Remote - United States");
  const unknown = trustedDistanceForLocation("Somewhere in New Jersey");
  check(near.trusted && near.distanceMiles !== null && near.distanceMiles < 25, `known near city gets a derived distance (${near.distanceMiles})`);
  check(far.trusted && far.distanceMiles === 145.2, "an exact stored verified distance is preserved");
  check(remote.trusted && remote.distanceMiles === null && /Remote/.test(remote.reason), "remote fixture remains remote without an invented distance");
  check(!unknown.trusted && unknown.distanceMiles === null && unknown.reason === "Location not yet verified", "unknown location is visibly unverified");

  console.log("\n3) Local Firms includes only approved employers and uses verified job locations");
  const localCompany = await prisma.company.create({
    data: {
      name: `${PREFIX} Local`,
      source: "manual",
      allowlisted: true,
      careersUrl: "https://nearby-release-audit.example/careers",
      csvEeCpeFit: "High",
    },
  });
  const farCompany = await prisma.company.create({
    data: { name: `${PREFIX} Far`, source: "manual", allowlisted: true, careersUrl: "https://far.nearby-release-audit.example/careers" },
  });
  const unapproved = await prisma.company.create({
    data: { name: `${PREFIX} Unapproved`, source: "seed", allowlisted: false },
  });

  await prisma.job.createMany({
    data: [
      {
        title: "Electrical Engineering Intern",
        company: localCompany.name,
        location: "Newark, NJ",
        description: "Release fixture.",
        source: "greenhouse",
        verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
        activeFeed: true,
      },
      {
        title: "Hardware Engineering Intern",
        company: farCompany.name,
        location: "Los Angeles, CA",
        description: "Release fixture.",
        source: "greenhouse",
        verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
        activeFeed: true,
      },
      {
        title: "Electrical Engineering Intern",
        company: unapproved.name,
        location: "Clifton, NJ",
        description: "Must never make an unapproved employer visible.",
        source: "greenhouse",
        verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
        activeFeed: true,
      },
    ],
  });

  const result = await buildLocalFirms(150);
  const local = result.firms.find((firm) => firm.id === localCompany.id);
  const farResult = result.outsideRadius.find((firm) => firm.id === farCompany.id);
  const leakedUnapproved = [...result.firms, ...result.outsideRadius, ...result.locationUnknown].some((firm) => firm.id === unapproved.id);
  check(!!local, "approved Newark employer is inside the 150-mile Local Firms result");
  check(!!farResult, "approved Los Angeles employer is outside the radius rather than falsely local");
  check(!leakedUnapproved, "unapproved employer is excluded even when its job location is local");
  check(local?.careersUrl === "https://nearby-release-audit.example/careers", "official careers URL is retained");
  check(local?.highFit === true, "high-fit metadata is retained");
  check((local?.verifiedInternships ?? 0) === 1, "verified internship count is based on exact verified jobs");

  console.log("\n4) Scheduler compatibility wrapper uses the same approved-source builder with its default radius");
  const defaultBuild = await buildLocalFirms(50);
  const wrapper = await runNearbyFirmSearch();
  check(wrapper.configured === true, "Local Firms does not depend on Google Places configuration");
  check(wrapper.discovered === defaultBuild.firms.length, "scheduler wrapper reports the same approved local firms as the 50-mile builder");

  await cleanup();
  console.log(failures === 0 ? "\nAll Local Firms tests PASSED." : `\n${failures} test(s) FAILED.`);
  if (failures) process.exitCode = 1;
}

main()
  .catch((error) => { console.error("Local Firms test crashed:", error); process.exitCode = 1; })
  .finally(async () => { await cleanup().catch(() => undefined); await prisma.$disconnect(); });
