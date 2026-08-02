import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { csvFileExists } from "@/lib/employers/csv";
import { getApprovedEmployerImportStatus, syncApprovedEmployersFromCsv } from "@/lib/employers/sync";

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const search = params.get("search")?.trim() ?? "";
  const sector = params.get("sector")?.trim() ?? "";
  const fit = params.get("fit")?.trim() ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = Math.min(100, Math.max(10, Number(params.get("pageSize")) || 25));
  const where = {
    source: "csv",
    allowlisted: true,
    ...(search ? { name: { contains: search } } : {}),
    ...(sector ? { csvSector: sector } : {}),
    ...(fit ? { csvEeCpeFit: { contains: fit } } : {}),
  };
  const [companies, total, sectors, importStatus, fileExists, liveJobs] = await Promise.all([
    prisma.company.findMany({ where, orderBy: { name: "asc" }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.company.count({ where }),
    prisma.company.findMany({ where: { source: "csv", allowlisted: true, csvSector: { not: null } }, distinct: ["csvSector"], select: { csvSector: true }, orderBy: { csvSector: "asc" } }),
    getApprovedEmployerImportStatus(),
    csvFileExists(),
    prisma.job.findMany({ where: { verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK" }, select: { company: true } }),
  ]);
  const counts = new Map<string, number>();
  for (const job of liveJobs) counts.set(job.company.trim().toLocaleLowerCase(), (counts.get(job.company.trim().toLocaleLowerCase()) ?? 0) + 1);
  return NextResponse.json({
    fileExists,
    importStatus,
    total,
    expectedTotal: 497,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    sectors: sectors.map((item) => item.csvSector).filter(Boolean),
    employers: companies.map((company) => ({
      ...company,
      portalStatus: "APPROVED_OFFICIAL_PORTAL",
      currentlyVerifiedInternshipOpenings: counts.get(company.name.trim().toLocaleLowerCase()) ?? 0,
    })),
  });
}

export async function POST() {
  const result = await syncApprovedEmployersFromCsv();
  return NextResponse.json({ result }, { status: result.ran ? 200 : 422 });
}
