// Idempotent Company Watchlist seed — safe to re-run any time (upsert by
// unique company name). This does NOT touch Job/ResumeFact data.
import "dotenv/config";
import { prisma } from "@/lib/db";

type SeedCompany = {
  name: string;
  industry: string;
  website: string;
  careersUrl: string;
  atsType?: string;
  atsIdentifier?: string;
  priority?: "priority" | "standard" | "low";
};

// Real, publicly known corporate domains (general knowledge, not scraped).
// atsType/atsIdentifier are left "unknown" unless directly confirmed —
// the discovery check auto-detects them on first run rather than guessing.
const NAMED_EMPLOYERS: SeedCompany[] = [
  { name: "Google", industry: "Technology", website: "https://www.google.com", careersUrl: "https://careers.google.com" },
  { name: "Amazon", industry: "Technology", website: "https://www.amazon.com", careersUrl: "https://www.amazon.jobs" },
  { name: "Apple", industry: "Technology", website: "https://www.apple.com", careersUrl: "https://jobs.apple.com" },
  { name: "Meta", industry: "Technology", website: "https://www.meta.com", careersUrl: "https://www.metacareers.com" },
  { name: "Microsoft", industry: "Technology", website: "https://www.microsoft.com", careersUrl: "https://careers.microsoft.com" },
  { name: "NVIDIA", industry: "Semiconductor", website: "https://www.nvidia.com", careersUrl: "https://www.nvidia.com/en-us/about-nvidia/careers/" },
  { name: "AMD", industry: "Semiconductor", website: "https://www.amd.com", careersUrl: "https://careers.amd.com" },
  { name: "Intel", industry: "Semiconductor", website: "https://www.intel.com", careersUrl: "https://jobs.intel.com" },
  { name: "Qualcomm", industry: "Semiconductor", website: "https://www.qualcomm.com", careersUrl: "https://careers.qualcomm.com" },
  {
    name: "Micron Technology",
    industry: "Semiconductor",
    website: "https://www.micron.com",
    careersUrl: "https://www.micron.com/careers",
    atsType: "workday",
    atsIdentifier: "micron/External",
  },
  { name: "Texas Instruments", industry: "Semiconductor", website: "https://www.ti.com", careersUrl: "https://careers.ti.com" },
  { name: "Analog Devices", industry: "Semiconductor", website: "https://www.analog.com", careersUrl: "https://careers.analog.com" },
  { name: "L3Harris Technologies", industry: "Aerospace & Defense", website: "https://www.l3harris.com", careersUrl: "https://www.l3harris.com/careers" },
  { name: "Lockheed Martin", industry: "Aerospace & Defense", website: "https://www.lockheedmartin.com", careersUrl: "https://www.lockheedmartinjobs.com" },
  { name: "RTX (Raytheon)", industry: "Aerospace & Defense", website: "https://www.rtx.com", careersUrl: "https://www.rtx.com/careers" },
  { name: "Northrop Grumman", industry: "Aerospace & Defense", website: "https://www.northropgrumman.com", careersUrl: "https://careers.northropgrumman.com" },
  { name: "BAE Systems", industry: "Aerospace & Defense", website: "https://www.baesystems.com", careersUrl: "https://jobs.baesystems.com" },
  { name: "Boeing", industry: "Aerospace & Defense", website: "https://www.boeing.com", careersUrl: "https://jobs.boeing.com" },
  { name: "General Dynamics", industry: "Aerospace & Defense", website: "https://www.gd.com", careersUrl: "https://www.gd.com/careers" },
  { name: "Honeywell", industry: "Industrial Automation", website: "https://www.honeywell.com", careersUrl: "https://careers.honeywell.com" },
  { name: "Siemens", industry: "Industrial Automation", website: "https://www.siemens.com", careersUrl: "https://jobs.siemens.com" },
  { name: "Schneider Electric", industry: "Industrial Automation", website: "https://www.se.com", careersUrl: "https://www.se.com/us/en/about-us/careers/" },
  { name: "ABB", industry: "Industrial Automation", website: "https://global.abb", careersUrl: "https://careers.abb" },
  { name: "Eaton", industry: "Industrial Automation", website: "https://www.eaton.com", careersUrl: "https://www.eaton.com/us/en-us/company/careers.html" },
  { name: "Emerson", industry: "Industrial Automation", website: "https://www.emerson.com", careersUrl: "https://www.emerson.com/en-us/careers" },
  { name: "Stryker", industry: "Medical Devices", website: "https://www.stryker.com", careersUrl: "https://www.stryker.com/us/en/careers.html" },
  { name: "Johnson & Johnson", industry: "Medical Devices", website: "https://www.jnj.com", careersUrl: "https://careers.jnj.com" },
  { name: "BD (Becton Dickinson)", industry: "Medical Devices", website: "https://www.bd.com", careersUrl: "https://jobs.bd.com" },
  { name: "PSEG", industry: "Utilities", website: "https://www.pseg.com", careersUrl: "https://careers.pseg.com" },
  { name: "Verizon", industry: "Telecommunications", website: "https://www.verizon.com", careersUrl: "https://www.careers.verizon.com" },
  { name: "Nokia Bell Labs", industry: "Telecommunications", website: "https://www.nokia.com", careersUrl: "https://www.nokia.com/about-us/careers/" },
];

// Additional hardware/aerospace employers confirmed (live, during
// development) to run public Greenhouse boards — real, working examples of
// the Watchlist being expandable beyond the fixed named-employer list.
const DISCOVERED_EMPLOYERS: SeedCompany[] = [
  {
    name: "Astranis",
    industry: "Aerospace & Defense",
    website: "https://www.astranis.com",
    careersUrl: "https://www.astranis.com/careers",
    atsType: "greenhouse",
    atsIdentifier: "astranis",
    priority: "standard",
  },
  {
    name: "Redwood Materials",
    industry: "Hardware / Manufacturing",
    website: "https://www.redwoodmaterials.com",
    careersUrl: "https://www.redwoodmaterials.com/careers",
    atsType: "greenhouse",
    atsIdentifier: "redwoodmaterials",
    priority: "standard",
  },
  {
    name: "Vast",
    industry: "Aerospace & Defense",
    website: "https://www.vastspace.com",
    careersUrl: "https://www.vastspace.com/careers",
    atsType: "greenhouse",
    atsIdentifier: "vast",
    priority: "standard",
  },
];

async function main() {
  let created = 0;
  let updated = 0;

  for (const c of [...NAMED_EMPLOYERS, ...DISCOVERED_EMPLOYERS]) {
    const existing = await prisma.company.findUnique({ where: { name: c.name } });
    if (existing) {
      // Don't clobber ATS info we may have already auto-detected.
      await prisma.company.update({
        where: { name: c.name },
        data: {
          industry: c.industry,
          website: c.website,
          careersUrl: c.careersUrl,
          ...(existing.atsType ? {} : { atsType: c.atsType ?? "unknown", atsIdentifier: c.atsIdentifier ?? null }),
        },
      });
      updated++;
    } else {
      await prisma.company.create({
        data: {
          name: c.name,
          industry: c.industry,
          website: c.website,
          careersUrl: c.careersUrl,
          atsType: c.atsType ?? "unknown",
          atsIdentifier: c.atsIdentifier ?? null,
          priority: c.priority ?? "priority",
          source: "seed",
        },
      });
      created++;
    }
  }

  const total = NAMED_EMPLOYERS.length + DISCOVERED_EMPLOYERS.length;
  console.log(`Company Watchlist seed: ${created} created, ${updated} updated (of ${total} employers).`);
}

main()
  .catch((err) => {
    console.error("Company seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
