/**
 * Mints a browser-extension token for one account.
 *
 * The website's Settings → Browser extension panel is the normal way to do
 * this. This script exists for the local workflow where the browser is not
 * open, and it follows the same rule the Settings panel does: a token belongs
 * to exactly one user, and that user is named explicitly.
 *
 *   npx tsx scripts/extension-token.ts --email you@example.com
 *   npx tsx scripts/extension-token.ts --user <userId>
 *
 * The token is printed once and only its SHA-256 digest is stored.
 */

import "dotenv/config";
import { prisma } from "@/lib/db";
import { issueExtensionToken } from "@/lib/applications/extensionAuth";

async function resolveUserId(): Promise<string | null> {
  const argv = process.argv.slice(2);
  const emailIndex = argv.indexOf("--email");
  const userIndex = argv.indexOf("--user");

  if (userIndex !== -1 && argv[userIndex + 1]) {
    const user = await prisma.user.findUnique({
      where: { id: argv[userIndex + 1]! },
      select: { id: true },
    });
    if (!user) console.error("No account has that id.");
    return user?.id ?? null;
  }
  if (emailIndex !== -1 && argv[emailIndex + 1]) {
    const email = argv[emailIndex + 1]!.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) console.error("No account exists with that email address.");
    return user?.id ?? null;
  }

  console.error(
    "Name the account this extension belongs to:\n" +
      "  npx tsx scripts/extension-token.ts --email you@example.com\n" +
      "  npx tsx scripts/extension-token.ts --user <userId>\n\n" +
      "There is no installation-wide extension token any more. A token grants\n" +
      "access to one person's profile, documents and answers, so it has to say\n" +
      "whose.",
  );
  return null;
}

async function main(): Promise<void> {
  const userId = await resolveUserId();
  if (!userId) {
    process.exitCode = 1;
    return;
  }

  const issued = await issueExtensionToken(userId, "Local extension token");
  console.log("Paste this token into the Internship Pilot extension popup:");
  console.log(issued.token);
  console.log(
    "\nIt is shown once — only its fingerprint is stored. It grants access to\n" +
      "this account's profile, documents and saved answers, and to no other\n" +
      "account's. Revoke it any time from Settings → Browser extension.",
  );
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
