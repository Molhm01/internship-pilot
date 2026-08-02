import "dotenv/config";
import { prisma } from "@/lib/db";
import { getOrCreateExtensionApiToken } from "@/lib/applications/extensionAuth";

async function main(): Promise<void> {
  const token = await getOrCreateExtensionApiToken();
  console.log("Paste this local token into the Internship Pilot extension popup:");
  console.log(token);
  console.log("Keep it private. It grants access to local candidate data while Internship Pilot is running.");
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
