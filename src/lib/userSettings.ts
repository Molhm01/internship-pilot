import { prisma } from "@/lib/db";

/**
 * Per-user settings.
 *
 * `AppSetting` stays as it is and keeps what genuinely belongs to the
 * installation: the scheduler's pause state, sync cursors, import status. What
 * moved here is everything that was a *preference* — the application mode, the
 * auto-submit threshold and allowlist, the nearby-search centre and radius.
 * Those were global key/value rows, so one person turning the agent off turned
 * it off for everybody, and one person's search centre was everybody's.
 *
 * Values are JSON-encoded, like `AppSetting`, so this is a drop-in for the
 * call sites that moved across.
 */

export async function readUserSetting<T>(
  userId: string,
  key: string,
  fallback: T,
): Promise<T> {
  const row = await prisma.userSetting.findUnique({ where: { userId_key: { userId, key } } });
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    // A malformed row is treated as absent rather than as a failure: a settings
    // page that 500s because one JSON value was hand-edited is worse than one
    // that shows the default.
    return fallback;
  }
}

/** Reads several keys at once, so a settings page is one query. */
export async function readUserSettings(
  userId: string,
  keys: readonly string[],
): Promise<Map<string, unknown>> {
  const rows = await prisma.userSetting.findMany({ where: { userId, key: { in: [...keys] } } });
  const values = new Map<string, unknown>();
  for (const row of rows) {
    try {
      values.set(row.key, JSON.parse(row.value));
    } catch {
      /* treated as absent */
    }
  }
  return values;
}

export async function writeUserSetting(userId: string, key: string, value: unknown): Promise<void> {
  const encoded = JSON.stringify(value);
  await prisma.userSetting.upsert({
    where: { userId_key: { userId, key } },
    create: { userId, key, value: encoded },
    update: { value: encoded },
  });
}
