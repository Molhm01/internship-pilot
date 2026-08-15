// Standard Google OAuth 2.0 authorization-code flow, read-only Gmail scope
// only. Requires the user's own Google Cloud OAuth client (GMAIL_CLIENT_ID /
// GMAIL_CLIENT_SECRET in .env) — see SETUP.md. This app never requests any
// scope beyond gmail.readonly, and never sends/deletes/archives/modifies
// anything in the mailbox with these credentials.
import { absoluteAppUrl } from "@/lib/runtime/appUrl";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export class GmailNotConfiguredError extends Error {
  constructor() {
    super(
      "Gmail integration isn't configured yet. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env first — see SETUP.md.",
    );
  }
}

function getConfig() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  // Google matches the redirect URI exactly against the one registered on the
  // OAuth client, so a deployment must send its own HTTPS callback rather than
  // a localhost address that only ever resolved on the developer's machine.
  // GMAIL_REDIRECT_URI still wins when set, because some OAuth clients are
  // registered against a custom domain that this app has no other way to know.
  const redirectUri = process.env.GMAIL_REDIRECT_URI?.trim()
    || absoluteAppUrl("/api/gmail/auth/callback");
  if (!clientId || !clientSecret) throw new GmailNotConfiguredError();
  return { clientId, clientSecret, redirectUri };
}

export function isGmailConfigured(): boolean {
  return !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET);
}

export function buildAuthUrl(): string {
  const { clientId, redirectUri } = getConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_READONLY_SCOPE,
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
};

export async function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
  const { clientId, clientSecret, redirectUri } = getConfig();
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    throw new Error(`Google rejected the authorization code (status ${res.status}). Try connecting Gmail again.`);
  }
  return res.json();
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const { clientId, clientSecret } = getConfig();
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`Could not refresh the Gmail access token (status ${res.status}). You may need to reconnect Gmail.`);
  }
  return res.json();
}

export async function fetchUserEmailAddress(accessToken: string): Promise<string> {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error("Could not fetch the connected Gmail account's email address.");
  const data = await res.json();
  return data.email;
}
