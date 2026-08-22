import { prisma } from "@/lib/db";

export class EmployerReviewError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

export async function reviewNewEmployer(options: {
  id: string;
  action: "approve" | "reject";
  officialDomain?: string;
  careersUrl?: string;
}) {
  const entry = await prisma.newEmployerReview.findUnique({ where: { id: options.id } });
  if (!entry) throw new EmployerReviewError("Not found", 404);

  if (options.action === "reject") {
    return prisma.newEmployerReview.update({
      where: { id: options.id },
      data: { status: "rejected", reviewedAt: new Date() },
    });
  }

  const officialDomain = options.officialDomain?.trim();
  const careersUrl = options.careersUrl?.trim();
  if (!officialDomain) {
    throw new EmployerReviewError("officialDomain is required to approve an employer.", 400);
  }

  await prisma.company.upsert({
    where: { name: entry.employerName },
    update: {
      allowlisted: true,
      source: "intern-list-approved",
      website: `https://${officialDomain}`,
      ...(careersUrl ? { careersUrl } : {}),
    },
    create: {
      name: entry.employerName,
      website: `https://${officialDomain}`,
      careersUrl: careersUrl ?? null,
      atsType: "unknown",
      priority: "standard",
      source: "intern-list-approved",
      allowlisted: true,
    },
  });

  return prisma.newEmployerReview.update({
    where: { id: options.id },
    data: { status: "approved", reviewedAt: new Date(), guessedDomain: officialDomain },
  });
}
