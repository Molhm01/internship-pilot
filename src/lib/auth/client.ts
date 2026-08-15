"use client";

import { createAuthClient } from "better-auth/react";

/**
 * The browser half of authentication.
 *
 * Deliberately thin, and deliberately holding no configuration: the base URL is
 * the page's own origin, and there is nothing here to leak because everything
 * that matters — the secret, the OAuth client secret, the session record — is
 * server-side. The cookie this talks to is HttpOnly, so this module cannot read
 * it either; it asks the server who is signed in and believes the answer.
 */
export const authClient = createAuthClient();

export const { signIn, signUp, signOut, useSession, linkSocial, unlinkAccount, listAccounts } =
  authClient;
