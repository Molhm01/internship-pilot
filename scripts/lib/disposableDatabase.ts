/**
 * The one gate every destructive fixture goes through.
 *
 * The application-agent regressions used to work by copying the user's real
 * SQLite `dev.db` to a scratch file and mutating the copy. That architecture
 * died with the move to PostgreSQL, and it should not be recreated: copying a
 * production database to run tests against means the fixtures are one bug away
 * from touching real rows, and it cannot work at all against a hosted server.
 *
 * What replaces it is a refusal. A fixture that creates and deletes rows runs
 * only against a database the operator has declared disposable — one whose name
 * says so, or one they pointed at explicitly with ISOLATED_TEST_MODE=1. Against
 * anything else the process exits before opening a connection.
 *
 * One trap worth naming, because it looks like isolation and is not: a local
 * `prisma dev` instance serves a single database regardless of the database
 * name in the connection URL. Renaming the database in the URL — or creating
 * another one on that server — still lands on the same rows. Isolating fixtures
 * from a real local install therefore means starting a SEPARATE instance
 * (`npx prisma dev --detach --name <something>-audit`, which gets its own port
 * and its own storage), not a different database name on the existing one.
 */

export type DisposableDatabase = {
  /** The database name, for log lines. Never the credentials. */
  name: string;
  /** How this database was accepted, so failures name the right knob. */
  reason: "explicit-isolated-mode" | "disposable-name";
};

const DISPOSABLE_NAME = /(?:audit|test)/i;

/**
 * Asserts DATABASE_URL points at a PostgreSQL database that is safe to mutate.
 *
 * Throws — never returns a boolean — because every caller's correct response to
 * "this is the real database" is to stop, and a boolean invites a caller to
 * carry on.
 */
export function assertDisposablePostgres(fixture: string): DisposableDatabase {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) {
    throw new Error(`${fixture} requires DATABASE_URL to point at a disposable PostgreSQL database.`);
  }
  if (raw.startsWith("file:")) {
    throw new Error(
      `${fixture} no longer runs on SQLite. Internship Pilot is PostgreSQL-only; point DATABASE_URL at a disposable PostgreSQL database (the CI job runs a postgres service for exactly this).`,
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${fixture} could not parse DATABASE_URL. It must be a PostgreSQL connection string.`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${fixture} is PostgreSQL-only; DATABASE_URL uses "${url.protocol}".`);
  }

  const name = url.pathname.replace(/^\//, "") || "(default)";
  if (process.env.ISOLATED_TEST_MODE === "1") return { name, reason: "explicit-isolated-mode" };
  if (DISPOSABLE_NAME.test(name)) return { name, reason: "disposable-name" };

  throw new Error(
    `${fixture} refuses to create and delete rows in database "${name}". ` +
    "Point DATABASE_URL at a database whose name contains \"test\" or \"audit\", or set ISOLATED_TEST_MODE=1 once you have pointed it at a disposable database. " +
    "This fixture never copies or mutates a real database.",
  );
}

/** Prints the accepted database once, so a run's blast radius is in the log. */
export function announceDisposableDatabase(fixture: string, database: DisposableDatabase): void {
  console.log(`${fixture}: using disposable PostgreSQL database "${database.name}" (${database.reason}).`);
}
