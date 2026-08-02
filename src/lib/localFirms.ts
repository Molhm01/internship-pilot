import { prisma } from "@/lib/db";
import { classifyLocation, DEFAULT_RADIUS_MILES, haversineMiles } from "@/lib/geo/geofilter";

export { haversineMiles };

// Kept for backwards compatibility with existing callers/tests; now delegates
// to the central geofilter. Never invents distance zero for unknown locations.
export function trustedDistanceForLocation(location: string | null, storedDistance: number | null = null, radiusMiles: number = DEFAULT_RADIUS_MILES) {
  const c = classifyLocation(location, radiusMiles, storedDistance);
  if (c.precision === "remote") return { distanceMiles: null, trusted: true, reason: "Remote location stated on an exact LIVE_JOB_VERIFIED posting" };
  if (c.bucket === "unknown") return { distanceMiles: null, trusted: false, reason: "Location not yet verified" };
  return { distanceMiles: c.distanceMiles, trusted: true, reason: c.precision === "state" ? "Location resolved to the stated state; coordinates use the state centroid" : "Location stated on an exact LIVE_JOB_VERIFIED posting; coordinates use the verified city center" };
}

export async function buildLocalFirms(radiusMiles: number) {
  const radius = [25, 50, 100, 150].includes(radiusMiles) ? radiusMiles : DEFAULT_RADIUS_MILES;
  const [companies, jobs] = await Promise.all([
    prisma.company.findMany({ where: { allowlisted: true, source: { in: ["csv", "manual", "intern-list-approved"] } }, orderBy: { name: "asc" } }),
    prisma.job.findMany({ where: { verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK" }, select: { company: true, location: true, distanceMilesFromClifton: true, lastVerifiedAt: true, url: true } }),
  ]);
  const jobsByCompany = new Map<string, typeof jobs>();
  for (const job of jobs) { const key = job.company.trim().toLocaleLowerCase(); jobsByCompany.set(key, [...(jobsByCompany.get(key) ?? []), job]); }

  type FirmRow = { id: string; employer: string; highFit: boolean; location: string | null; distanceMiles: number | null; bucket: "local" | "outside" | "unknown"; careersUrl: string | null; verifiedInternships: number; lastCheckedAt: Date | null; monitoringStatus: string; trustedReason: string; insideRadius: boolean; isRemote: boolean };

  const allFirms: FirmRow[] = companies.map((company) => {
    const live = jobsByCompany.get(company.name.trim().toLocaleLowerCase()) ?? [];
    // Pick the CLOSEST resolvable posting location for this employer.
    const classified = live.map((job) => ({ job, c: classifyLocation(job.location, radius, job.distanceMilesFromClifton) }));
    const resolvable = classified.filter((x) => x.c.bucket !== "unknown");
    const best = resolvable.sort((a, b) => (a.c.distanceMiles ?? Number.MAX_VALUE) - (b.c.distanceMiles ?? Number.MAX_VALUE))[0];
    const bucket: "local" | "outside" | "unknown" = best ? best.c.bucket : "unknown";
    const isRemote = Boolean(best && best.c.precision === "remote");
    const reason = bucket === "unknown"
      ? "Location not yet verified — placed in Location Unknown, never counted as local"
      : isRemote
        ? "Remote location on an exact verified posting"
        : `Computed ${best?.c.distanceMiles} miles from Clifton, NJ using ${best?.c.precision}-level coordinates`;
    return {
      id: company.id, employer: company.name, highFit: /high/i.test(company.csvEeCpeFit ?? ""),
      location: best?.job.location ?? null, distanceMiles: best?.c.distanceMiles ?? null, bucket,
      careersUrl: company.careersUrl, verifiedInternships: live.length, lastCheckedAt: company.lastCheckedAt,
      monitoringStatus: company.monitoringStatus, trustedReason: reason,
      insideRadius: bucket === "local", isRemote,
    };
  });

  const sortFirms = (rows: FirmRow[]) => rows.sort((a, b) =>
    Number(b.employer === "L3Harris Technologies") - Number(a.employer === "L3Harris Technologies")
    || (a.distanceMiles ?? Number.MAX_VALUE) - (b.distanceMiles ?? Number.MAX_VALUE)
    || a.employer.localeCompare(b.employer),
  );

  // DEFAULT Local Firms list = ONLY firms proven within the radius. California
  // and other distant firms fall into `outside`; unresolvable ones into
  // `locationUnknown`. Neither appears in the default local list.
  const firms = sortFirms(allFirms.filter((f) => f.bucket === "local"));
  const outsideRadius = sortFirms(allFirms.filter((f) => f.bucket === "outside"));
  const locationUnknown = allFirms.filter((f) => f.bucket === "unknown").sort((a, b) => a.employer.localeCompare(b.employer));

  const diagnostics = {
    approvedEmployersChecked: companies.length,
    withVerifiedLocations: allFirms.filter((f) => f.bucket !== "unknown").length,
    insideRadius: firms.length,
    outsideRadius: outsideRadius.length,
    currentOfferingInternships: firms.filter((f) => f.verifiedInternships > 0).length,
    unknownLocations: locationUnknown.length,
    lastCompletedScan: new Date().toISOString(),
    errors: [] as string[],
  };
  await prisma.appSetting.upsert({ where: { key: "localFirmsDiagnostics" }, update: { value: JSON.stringify(diagnostics) }, create: { key: "localFirmsDiagnostics", value: JSON.stringify(diagnostics) } });
  return { center: "Clifton, New Jersey", radiusMiles: radius, firms, outsideRadius, locationUnknown, diagnostics };
}
