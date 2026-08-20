import { MINIMUM_PASSWORD_LENGTH, MAXIMUM_PASSWORD_LENGTH } from "@/lib/auth/constants";

/**
 * Turns a Better Auth client error into a clear, safe user message.
 *
 * The generic "That did not work" is the LAST resort, not the only case. Better
 * Auth returns a `code` (and often a `status`); this maps the ones a person can
 * act on to plain language, and — critically — never surfaces SQL, a stack
 * trace, a connection string, a secret, or an internal path even when the raw
 * message happens to contain one. That is what makes a production failure
 * legible instead of a wall of "check your details".
 */

export type AuthClientError = {
  code?: string | null;
  status?: number | null;
  message?: string | null;
} | null | undefined;

/** Redact anything that looks like infrastructure detail before showing a message. */
function looksSensitive(message: string): boolean {
  return /\b(sql|prisma|postgres|postgresql|econn|stack|node_modules|\/var\/|c:\\|select\s|insert\s|relation\s|at\s+\/)/i.test(message)
    || /secret|password=|:\/\/[^@\s]+@/i.test(message);
}

export function authErrorMessage(error: AuthClientError, mode: "signup" | "login" = "login"): string {
  const code = (error?.code ?? "").toUpperCase();

  switch (code) {
    case "USER_ALREADY_EXISTS":
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
      return "This email already has an Internship Pilot account. Log in instead.";
    case "INVALID_EMAIL":
      return "Enter a valid email address.";
    case "PASSWORD_TOO_SHORT":
      return `Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`;
    case "PASSWORD_TOO_LONG":
      return "That password is too long. Choose a shorter one.";
    case "INVALID_EMAIL_OR_PASSWORD":
    case "INVALID_PASSWORD":
    case "CREDENTIAL_ACCOUNT_NOT_FOUND":
      return "Incorrect email or password.";
    case "EMAIL_NOT_VERIFIED":
      return "Please verify your email address before signing in.";
    case "INVALID_ORIGIN":
      return "Authentication is temporarily unavailable. Please reload the page and try again.";
    case "UNPROCESSABLE_ENTITY":
      return mode === "signup" ? "Check your details and try again." : "Incorrect email or password.";
  }

  const status = error?.status ?? undefined;
  if (status === 429) return "Too many attempts. Wait a moment, then try again.";
  if (status === 403) return "Authentication is temporarily unavailable. Please reload the page and try again.";
  if (status !== undefined && status >= 500) return "Account service is temporarily unavailable. Try again in a moment.";
  // An explicit network-level failure (status 0, set by the form's catch when
  // no HTTP response came back at all).
  if (status === 0) return "Account service is temporarily unavailable. Try again in a moment.";

  // Better Auth sometimes carries a clean, human message — use it, but only if
  // it cannot leak infrastructure detail.
  const message = error?.message?.trim();
  if (message && !looksSensitive(message)) return message;

  return "That did not work. Check your details and try again.";
}

/**
 * Client-side validation run BEFORE the request, so obvious problems get an
 * instant, specific message instead of a round trip. Returns null when valid.
 */
export function validateAuthInput(
  input: { email: string; password: string; name?: string; confirmPassword?: string },
  mode: "signup" | "login",
): string | null {
  const email = input.email.trim();
  if (!email) return "Enter your email address.";
  // Deliberately permissive: the server is the authority. This only catches the
  // obviously-wrong (missing @, spaces, no domain) to save a round trip.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Enter a valid email address.";
  if (!input.password) return "Enter your password.";
  if (mode === "signup") {
    if (input.password.length < MINIMUM_PASSWORD_LENGTH) return `Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`;
    if (input.password.length > MAXIMUM_PASSWORD_LENGTH) return "That password is too long. Choose a shorter one.";
    if (input.confirmPassword !== undefined && input.password !== input.confirmPassword) return "The two passwords do not match.";
  }
  return null;
}
