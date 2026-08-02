/**
 * Local single-user mode.
 *
 * Internship Pilot runs on one person's machine against one SQLite file. In
 * that deployment an account is not a security boundary — anyone who can reach
 * the page can already read the database — so requiring a signup before the
 * user may type their own name into their own profile buys nothing and costs
 * them a login they did not ask for.
 *
 * So the profile is reachable without authenticating, and the account code
 * stays in the tree for the day this is deployed for more than one person.
 *
 * The flag is opt-*out*: local is the default, and multi-user has to be asked
 * for. A misread environment variable therefore fails towards "the user can
 * edit their profile", not towards "the user is locked out of it".
 */

/** The one profile row's id. `ApplicationProfile` has always been single-row. */
export const CANONICAL_PROFILE_ID = "default";

/**
 * True unless `INTERNSHIP_PILOT_SINGLE_USER` is explicitly set to a false-ish
 * value. Read per call rather than captured at module load so a test can set
 * the variable without fighting module caching.
 */
export function isSingleUserMode(): boolean {
  const raw = process.env.INTERNSHIP_PILOT_SINGLE_USER?.trim().toLowerCase();
  if (raw === undefined || raw === "") return true;
  return !["false", "0", "no", "off"].includes(raw);
}

/**
 * Whether the website's own login/signup pages are in play.
 *
 * Exactly the inverse of single-user mode, named separately because the two
 * read very differently at a call site and confusing them would either expose
 * the auth pages in local mode or lock the profile in multi-user mode.
 */
export function isWebsiteAuthEnabled(): boolean {
  return !isSingleUserMode();
}
