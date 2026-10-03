#!/usr/bin/env bash
#
# Verifies the Prisma database migrations for the Astroid API.
#
# What it does, in order:
#   1. Static verification (no database required):
#      - Every migration directory contains a migration.sql file.
#      - Every migration.sql is non-empty and contains executable SQL
#        statements (not just comments/whitespace).
#      - Migration directory names follow the Prisma convention
#        `<UTC-timestamp>_<snake_case_name>` (plus the reserved `0_init`-style
#        migration and `migration_lock.toml`).
#      - Unbalanced parentheses / unclosed quote heuristics catch truncated
#        or hand-broken SQL before it reaches a database.
#      - Migration timestamp prefixes must be unique.
#   2. Validates schema.prisma and generates the Prisma client.
#   3. (DATABASE_URL set) Applies every pending migration (idempotent) and
#      checks `prisma migrate status`.
#   4. (SHADOW_DATABASE_URL set) Drift check: rebuilds the schema purely from
#      the committed migrations in an ephemeral shadow database and fails if
#      it does not match prisma/schema.prisma. This catches schema edits that
#      were never captured in a migration.
#
# Env:
#   DATABASE_URL          (optional) Target PostgreSQL the migrations are
#                         applied to. When unset the script runs in static
#                         mode only — suitable for containerized CI runners
#                         without an active database connection.
#   SHADOW_DATABASE_URL   (optional) An empty scratch database used for the
#                         drift check. Requires DATABASE_URL to be set.
#   CHECK_GIT_DIRTY       (optional) Set to `true` to fail when the git
#                         working tree is dirty (catches migrations that were
#                         never committed).
#
# Exit codes:
#   0  verification passed
#   1  a migration file is missing/empty, invalid SQL, a name violates the
#      naming convention, migrations fail to apply, or schema drift exists.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="${REPO_ROOT}/prisma/migrations"
SCHEMA_FILE="${REPO_ROOT}/prisma/schema.prisma"

# The Prisma naming convention is a 14-digit UTC timestamp followed by an
# underscore-separated name (e.g. 20260830174000_sync_schema). Prisma also
# permits a trailing suffix when a name is regenerated (-, +, <, >). The
# baseline `0_init` migration (any single-0-prefixed name) is allowed.
readonly MIGRATION_NAME_RE='^(0|[0-9]{14})_[a-z0-9_]+([-+<>][a-zA-Z0-9_]+)?$'

errors=0

fail() {
  echo "!! ${1}" >&2
  errors=$((errors + 1))
}

# --------------------------------------------------------------------------
# 1. Static verification — pure filesystem checks, no database required.
# --------------------------------------------------------------------------
echo "==> Verifying migrations directory structure (${MIGRATIONS_DIR})"

if [[ ! -f "${SCHEMA_FILE}" ]]; then
  fail "Prisma schema not found at ${SCHEMA_FILE}"
fi

if [[ ! -d "${MIGRATIONS_DIR}" ]]; then
  fail "Migrations directory not found at ${MIGRATIONS_DIR}"
  # Nothing else can be verified without the directory.
  exit 1
fi

# ---------------------------------------------------------------------------
# SQL structural sanity check for a single migration file.
# A migration is considered structurally sound when it contains at least one
# executable statement (anything that is not a comment/whitespace) and has
# balanced quotes. Parentheses balance is checked only when the file does not
# use dollar-quoted strings or `$$` bodies (functions/triggers), where naive
# counting is unreliable.
# ---------------------------------------------------------------------------
check_sql_integrity() {
  local file="$1"
  local name
  name="$(basename "$(dirname "${file}")")"

  if [[ ! -s "${file}" ]]; then
    fail "${name}: migration.sql is empty"
    return
  fi

  # Statements = non-empty lines that are not pure comments or whitespace.
  if ! grep -Ev '^[[:space:]]*(--.*)?$' "${file}" > /dev/null; then
    fail "${name}: migration.sql contains no executable SQL (comments/blank lines only)"
    return
  fi

  local content
  content="$(cat "${file}")"

  # Unclosed single-quote detection: strip line comments, then count the
  # single-quote characters left over. An ODD total means a quote literal was
  # left open — common in truncated or hand-broken SQL files.
  local quotes
  quotes="$(sed 's/--.*$//' "${file}" | tr -cd "'" | wc -c)"
  if [[ $((quotes % 2)) -ne 0 ]]; then
    fail "${name}: migration.sql appears to contain an unclosed single-quoted string"
  fi

  # Skip parenthesis balance when the file declares functions, triggers or
  # dollar-quoted bodies — a naive count would false-positive there.
  if ! grep -Eq '\$\$|CREATE[[:space:]]+(OR[[:space:]]+REPLACE[[:space:]]+)?(FUNCTION|TRIGGER|PROCEDURE)' "${file}"; then
    local open close
    open="$(sed 's/--.*$//' "${file}" | tr -cd '(' | wc -c)"
    close="$(sed 's/--.*$//' "${file}" | tr -cd ')' | wc -c)"
    if [[ "${open}" -ne "${close}" ]]; then
      fail "${name}: migration.sql has unbalanced parentheses (${open} open vs ${close} close)"
    fi
  fi
}

declare -A seen_timestamps

found_migrations=0
for dir in "${MIGRATIONS_DIR}"/*; do
  [[ -d "${dir}" ]] || continue
  found_migrations=$((found_migrations + 1))
  name="$(basename "${dir}")"

  if [[ "${name}" == "migration_lock.toml" || "${name}" == *.toml ]]; then
    continue
  fi

  if [[ ! "${name}" =~ ${MIGRATION_NAME_RE} ]]; then
    fail "'${name}' violates the migration naming convention '<UTC-timestamp>_<snake_case_name>'"
  fi

  # Timestamp prefixes must be unique: two migrations sharing one would make
  # the applied order ambiguous.
  if [[ "${name}" =~ ^([0-9]{14}) ]]; then
    ts="${BASH_REMATCH[1]}"
    if [[ -n "${seen_timestamps[${ts}]:-}" ]]; then
      fail "'${name}' shares its timestamp prefix with '${seen_timestamps[${ts}]}'"
    else
      seen_timestamps["${ts}"]="${name}"
    fi
  fi

  sql_file="${dir}/migration.sql"
  if [[ ! -f "${sql_file}" ]]; then
    fail "'${name}' is missing its migration.sql file"
    continue
  fi

  check_sql_integrity "${sql_file}"
done

if [[ "${found_migrations}" -eq 0 ]]; then
  fail "No migration directories found under prisma/migrations"
fi

echo "    Checked ${found_migrations} migration director(ies)"

# Duplicated migration names (case variants) would silently shadow history.
duplicate="$(find "${MIGRATIONS_DIR}" -maxdepth 1 -type d \( -iname '[0-9]*' -o -iname '0_*' \) -printf '%f\n' 2>/dev/null | tr '[:upper:]' '[:lower:]' | sort | uniq -d || true)"
if [[ -n "${duplicate}" ]]; then
  fail "Duplicate migration directory names detected (case-insensitive): ${duplicate//$'\n'/, }"
fi

if [[ "${errors}" -gt 0 ]]; then
  echo "!! Static migration verification failed with ${errors} error(s)" >&2
  exit 1
fi
echo "==> Static migration verification passed"

# --------------------------------------------------------------------------
# Optional: fail on a dirty git working tree (opt-in via CHECK_GIT_DIRTY).
# --------------------------------------------------------------------------
if [[ "${CHECK_GIT_DIRTY:-false}" == "true" ]]; then
  echo "==> Checking git working tree state"
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "!! Git working tree is dirty. Uncommitted migration or schema changes detected." >&2
    git status --porcelain >&2
    exit 1
  fi
fi

# --------------------------------------------------------------------------
# 2. Prisma schema validation + client generation.
# --------------------------------------------------------------------------
# `prisma validate` resolves env("DATABASE_URL") and rejects an empty value,
# so static mode (no real database) validates the schema against a placeholder
# URL — it is never connected to.
if [[ -z "${DATABASE_URL:-}" ]]; then
  DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder" npx prisma validate
else
  npx prisma validate
fi

echo "==> Generating Prisma client (validates schema.prisma syntax)"
npx prisma generate

# --------------------------------------------------------------------------
# 3. Apply migrations when a database is available (skipped in static mode).
# --------------------------------------------------------------------------
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "==> DATABASE_URL unset — skipping database apply/status/drift checks"
  echo "==> Migration verification passed (static mode)"
  exit 0
fi

echo "==> Applying migrations to ${DATABASE_URL}"
npx prisma migrate deploy

echo "==> Checking migration status"
npx prisma migrate status

# --------------------------------------------------------------------------
# 4. Drift check (requires an empty shadow database).
# --------------------------------------------------------------------------
if [[ -n "${SHADOW_DATABASE_URL:-}" ]]; then
  echo "==> Drift check: rebuilding schema from migrations only"
  echo "    shadow database: ${SHADOW_DATABASE_URL}"
  # `--script` prints the SQL that would reconcile the migrations-built schema
  # with schema.prisma: nothing when in sync, the full delta when out of sync.
  # Strip blank lines and SQL comment markers so an "empty migration" counts as
  # in sync.
  drift="$(npx prisma migrate diff \
    --from-migrations prisma/migrations \
    --to-schema-datamodel prisma/schema.prisma \
    --script \
    --shadow-database-url "${SHADOW_DATABASE_URL}" \
    | grep -Ev '^[[:space:]]*$|^--' || true)"

  if [[ -n "${drift//[[:space:]]/}" ]]; then
    echo "!! Schema drift detected — schema.prisma differs from the applied migrations." >&2
    echo "${drift}" >&2
    exit 1
  fi

  echo "==> Migrations are in sync with the schema"
else
  echo "!! SHADOW_DATABASE_URL unset — skipping drift check" >&2
fi

echo "==> Migration verification passed"
