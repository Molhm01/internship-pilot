import { prisma } from "@/lib/db";
import { encryptToken, decryptToken } from "./crypto";
import { refreshAccessToken, type TokenResponse } from "./oauth";

export async function saveGmailAccount(emailAddress: string, tokens: TokenResponse): Promise<void> {
  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. This usually means Gmail was already connected once before — disconnect and try again with prompt=consent (already set), or revoke access at https://myaccount.google.com/permissions and retry.",
    );
  }
  await prisma.gmailAccount.upsert({
    where: { id: "default" },
    update: {
      emailAddress,
      encryptedRefreshToken: encryptToken(tokens.refresh_token),
      encryptedAccessToken: encryptToken(tokens.access_token),
      accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    },
    create: {
      id: "default",
      emailAddress,
      encryptedRefreshToken: encryptToken(tokens.refresh_token),
      encryptedAccessToken: encryptToken(tokens.access_token),
      accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    },
  });
}

export async function getGmailAccountStatus(): Promise<{ connected: boolean; emailAddress?: string; lastSyncAt?: Date | null }> {
  const account = await prisma.gmailAccount.findUnique({ where: { id: "default" } });
  if (!account) return { connected: false };
  return { connected: true, emailAddress: account.emailAddress, lastSyncAt: account.lastSyncAt };
}

export async function disconnectGmail(): Promise<void> {
  await prisma.gmailAccount.deleteMany({ where: { id: "default" } });
}

// Returns a valid (non-expired) access token, refreshing via the stored
// encrypted refresh token if needed. Never logs the token itself.
export async function getValidAccessToken(): Promise<string | null> {
  const account = await prisma.gmailAccount.findUnique({ where: { id: "default" } });
  if (!account) return null;

  const stillValid =
    account.encryptedAccessToken && account.accessTokenExpiresAt && account.accessTokenExpiresAt.getTime() - 60_000 > Date.now();
  if (stillValid) return decryptToken(account.encryptedAccessToken!);

  const refreshToken = decryptToken(account.encryptedRefreshToken);
  const tokens = await refreshAccessToken(refreshToken);
  await prisma.gmailAccount.update({
    where: { id: "default" },
    data: {
      encryptedAccessToken: encryptToken(tokens.access_token),
      accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    },
  });
  return tokens.access_token;
}
