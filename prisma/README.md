# Database: SQLite → PostgreSQL

Internship Pilot used to run on a local SQLite file (`dev.db`) through the
libsql driver adapter. It now runs on PostgreSQL everywhere.

## Why one provider instead of two

Prisma cannot take its provider from an environment variable, so "SQLite in
development, PostgreSQL in production" means two schema files and two migration
histories that drift the moment someone adds a column to one of them. It also
means every feature is written against a database it will never ship on:
SQLite's `LIKE` ignores ASCII case and PostgreSQL's does not, so a search that
worked locally would quietly stop matching in production. Case-insensitive
filters are now explicit (`mode: "insensitive"`) precisely because that
difference was found and fixed rather than deployed.

Local development still needs no Docker and no install:

```bash
npx prisma dev
```

That starts a local Prisma Postgres and prints a connection string. Put it in
`.env` as `DATABASE_URL`, then:

```bash
npm run db:migrate      # prisma migrate dev — applies prisma/migrations
```

## Migration history

- `prisma/migrations/20260814000000_init_postgresql/` — the whole schema as one
  baseline. Generated with `prisma migrate diff --from-empty`, so it is exactly
  the current `schema.prisma` and nothing else.
- `prisma/migrations-sqlite-archive/` — the original 33 SQLite migrations, kept
  verbatim. They are no longer applied (their `migration_lock.toml` names the
  `sqlite` provider) and exist so the reasoning behind each schema change is
  still readable.

Nothing was deleted. `dev.db` and every `dev.db.bak-*` are untouched on disk.

## Bringing existing local data across

The SQLite file still holds real data — discovered jobs, approved résumé facts,
verification evidence, generated-document rows. `scripts/migrate-sqlite-to-postgres.ts`
copies it into the new database.

It reads `dev.db` **read-only** through the libsql driver and writes through
Prisma, so every row goes through the same validation as an ordinary write.
Two conversions matter and are handled: SQLite stored `DateTime` as epoch
milliseconds and `Boolean` as `0`/`1`, and the PostgreSQL columns are
`timestamp` and `boolean`.

```bash
# 1. Point DATABASE_URL at the destination and create the schema.
npm run db:deploy

# 2. See what would move, without writing anything.
npm run db:import-sqlite -- --dry-run

# 3. Move it.
npm run db:import-sqlite
```

Options:

- `--source file:./dev.db.bak-pre-auth-20260802-060906` — import a different
  snapshot instead of the live file.
- `--dry-run` — read and convert everything, write nothing, print the counts.

Rows are inserted parents-first and with `skipDuplicates`, so the import is
safe to re-run: a second pass over the same source adds nothing.

### What does not come across automatically

`GeneratedDocument.storagePath` and `ResumeDocument.storagePath` hold storage
keys, not bytes. A key written by the local driver is a repository-relative
path such as `data/generated/<jobId>/resume-v1.pdf`, and it stays valid on the
machine where those files exist.

A **cloud** deployment cannot resolve those paths — there is no `data/`
directory there. The rows import cleanly and the documents simply read as
missing until they are regenerated, which is the honest outcome: the download
route returns 404 with "The generated file could not be read from storage."
rather than serving something wrong. New documents generated after the move
are written to object storage and carry a blob URL as their key, and the
storage layer routes reads by the shape of the key, so both kinds coexist in
one database without a rewrite.

## Going back

The archived migrations plus the untouched `dev.db` are enough to run the old
SQLite setup again: restore `datasource db { provider = "sqlite" }`, swap
`prisma/migrations` for `prisma/migrations-sqlite-archive`, and reinstate the
libsql adapter in `src/lib/db.ts`. Nothing in this change is one-way.
