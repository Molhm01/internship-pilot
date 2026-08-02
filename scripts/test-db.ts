import "dotenv/config";
import { prisma } from "@/lib/db";

async function main() {
  const count = await prisma.job.count();
  console.log(`OK: connected to database. Job count = ${count}`);
}

main()
  .catch((err) => {
    console.error("Database connection test failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
