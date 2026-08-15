import { prisma } from "@/lib/db";
import { encryptToken, decryptToken } from "./crypto";
import { refreshAccessToken, type TokenResponse } from "./oauth";

/**
 * The connected mailbox, per user.
 *
 * Every function here used to key on `id: "default"` — a single row, so one
 * person's inbox, refresh token and tracked mail were the installation's. The
 * key is now the user, and `GmailAccount.userId` is unique so an account can
 * connect exactly one mailbox.
 *
 * Tokens remain AES-256-GCM encrypted at rest and are never logged.
 */
export async function saveGmailAccount(
  userId: string,
  emailAddress: string,
  tokens: TokenResponse,
): Promise<void> {
  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. This usually means Gmail was already connected once before — disconnect and try again with prompt=consent (already set), or revoke access at https://myaccount.google.com/permissions and retry.",
    );
  }
  await prisma.gmailAccount.upsert({
    where: { userId },
    update: {
      emailAddress,
      encryptedRefreshToken: encryptToken(tokens.refresh_token),
      encryptedAccessToken: encryptToken(tokens.access_token),
      accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    },
    create: {
      userId,
      emailAddress,
      encryptedRefreshToken: encryptToken(tokens.refresh_token),
      encryptedAccessToken: encryptToken(tokens.access_token),
      accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    },
  });
}

export async function getGmailAccountStatus(
  userId: string,
): Promise<{ connected: boolean; emailAddress?: string; lastSyncAt?: Date | null }> {
  const account = await prisma.gmailAccount.findUnique({ where: { userId } });
  if (!account) return { connected: false };
  return { connected: true, emailAddress: account.emailAddress, lastSyncAt: account.lastSyncAt };
}

export async function disconnectGmail(userId: string): Promise<void> {
  await prisma.gmailAccount.deleteMany({ where: { userId } });
}

// Returns a valid (non-expired) access token, refreshing via the stored
// encrypted refresh token if needed. Never logs the token itself.
export async function getValidAccessToken(userId: string): Promise<string | null> {
  const account = await prisma.gmailAccount.findUnique({ where: { userId } });
  if (!account) return null;

  const stillValid =
    account.encryptedAccessToken && account.accessTokenExpiresAt && account.accessTokenExpiresAt.getTime() - 60_000 > Date.now();
  if (stillValid) return decryptToken(account.encryptedAccessToken!);

  const refreshToken = decryptToken(account.encryptedRefreshToken);
  const tokens = await refreshAccessToken(refreshToken);
  await prisma.gmailAccount.update({
    where: { userId },
    data: {
      encryptedAccessToken: encryptToken(tokens.access_token),
      accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    },
  });
  return tokens.access_token;
}
