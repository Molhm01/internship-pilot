import { randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";

const EXTENSION_TOKEN_KEY = "extensionApiToken";
export const EXTENSION_AUTH_HEADER = "authorization";

export async function getOrCreateExtensionApiToken(): Promise<string> {
  const configured = process.env.INTERNSHIP_PILOT_EXTENSION_TOKEN?.trim();
  if (configured) return configured;
  const existing = await prisma.appSetting.findUnique({ where: { key: EXTENSION_TOKEN_KEY } });
  if (existing?.value) {
    try {
      const parsed = JSON.parse(existing.value);
      if (typeof parsed === "string" && parsed.length >= 32) return parsed;
    } catch {
      // Replace malformed legacy/local values with a fresh strong token.
    }
  }
  const token = randomBytes(32).toString("base64url");
  await prisma.appSetting.upsert({
    where: { key: EXTENSION_TOKEN_KEY },
    create: { key: EXTENSION_TOKEN_KEY, value: JSON.stringify(token) },
    update: { value: JSON.stringify(token) },
  });
  return token;
}

function equalSecret(received: string, expected: string): boolean {
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes);
}

export async function isExtensionRequestAuthorized(request: Request): Promise<boolean> {
  const header = request.headers.get(EXTENSION_AUTH_HEADER) ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  return equalSecret(match[1], await getOrCreateExtensionApiToken());
}

export async function extensionUnauthorizedResponse(): Promise<Response> {
  return Response.json(
    { error: "Extension authentication failed. Open the extension popup and connect it with the local API token." },
    { status: 401, headers: { "cache-control": "no-store" } },
  );
}
