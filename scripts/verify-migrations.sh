#!/usr/bin/env bash
#
# Verifies the integrity of the Prisma migration history.
#
# Checks run in three tiers; each tier runs only when its inputs are available,
# so the script is useful both locally (`npm run db:verify`) and in CI:
#
#   1. Static (always)
#        - prisma/schema.prisma is valid
#        - migration_lock.toml exists and matches the schema's datasource provider
#        - every migration directory is correctly named, uniquely timestamped and
#          contains a migration.sql with at least one statement
#        - SQL is lexically well-formed: no merge-conflict markers, balanced
#          parentheses, terminated strings/comments, final statement ends in ';'
#
#   2. History (when MIGRATION_BASE_REF is set and resolvable in git)
#        - migrations that already exist on the base ref are not modified or
#          deleted (deployed databases record a checksum per migration)
#        - new migrations sort after the newest migration on the base ref
#        - destructive statements in new migrations are reported as warnings
#
#   3. Database (when SHADOW_DATABASE_URL is set; the database is RESET)
#        - the full history replays cleanly, in order, on an empty database,
#          which validates SQL syntax and cross-migration dependencies
#        - schema.prisma has no changes missing from the migration history
#
# Environment:
#   MIGRATIONS_DIR          migrations directory      (default: prisma/migrations)
#   SCHEMA_PATH             Prisma schema file        (default: prisma/schema.prisma)
#   MIGRATION_BASE_REF      git ref to compare against, e.g. origin/main
#   SHADOW_DATABASE_URL     disposable database for replay and drift checks
#   CHECK_GIT_DIRTY=true    also fail if the git working tree is dirty
#   SKIP_SCHEMA_VALIDATION=true  skip `prisma validate` (used by the script's tests)
#
# Exits non-zero if any error is found. All errors are reported before exiting.

set -euo pipefail

# Prisma orders migration folders bytewise; compare and sort the same way.
export LC_ALL=C

MIGRATIONS_DIR="${MIGRATIONS_DIR:-prisma/migrations}"
SCHEMA_PATH="${SCHEMA_PATH:-prisma/schema.prisma}"
MIGRATION_BASE_REF="${MIGRATION_BASE_REF:-}"
SHADOW_DATABASE_URL="${SHADOW_DATABASE_URL:-}"

errors=0
warnings=0

# --- reporting ---------------------------------------------------------------

# Emits a GitHub Actions annotation in CI, or a plain prefixed line locally.
#   annotate <level> <file> <line> <message>
annotate() {
  local level="$1" file="$2" line="$3" message="$4"
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    local location=""
    [ -n "$file" ] && location=" file=${file}"
    [ -n "$file" ] && [ -n "$line" ] && location="${location},line=${line}"
    echo "::${level}${location}::${message}"
  else
    local where=""
    [ -n "$file" ] && where="${file}${line:+:$line}: "
    local label
    label="$(printf '%s' "$level" | tr '[:lower:]' '[:upper:]')"
    echo "${label}: ${where}${message}"
  fi
}

error() {
  errors=$((errors + 1))
  annotate error "${2:-}" "${3:-}" "$1" >&2
}

warn() {
  warnings=$((warnings + 1))
  annotate warning "${2:-}" "${3:-}" "$1" >&2
}

section() {
  echo
  echo "==> $1"
}

# --- SQL lexer ------------------------------------------------------------------

# Scans a migration.sql file, skipping comments and string/identifier/dollar-
# quoted literals, and prints one tab-separated finding per line:
#   E <line> <message>     lexical error
#   D <line> <statement>   destructive statement (reported for new migrations)
# Written for POSIX awk so it runs under mawk on ubuntu-latest.
lint_sql() {
  awk '
    BEGIN { state = "code"; depth = 0; open_stmt = 0; has_stmt = 0 }
    {
      sub(/\r$/, "")
      line = $0
      if (state == "code" && line ~ /^(<<<<<<<|=======|>>>>>>>)( |$)/) {
        printf "E\t%d\tunresolved merge-conflict marker\n", NR
        next
      }
      code = ""
      n = length(line)
      i = 1
      while (i <= n) {
        c = substr(line, i, 1)
        c2 = substr(line, i, 2)
        if (state == "block") {
          if (c2 == "*/") { state = "code"; i += 2 } else { i++ }
          continue
        }
        if (state == "squote") {
          if (c == "\047") {
            if (substr(line, i + 1, 1) == "\047") { i += 2; continue }
            state = "code"
          }
          i++
          continue
        }
        if (state == "dquote") {
          if (c == "\"") { state = "code" }
          i++
          continue
        }
        if (state == "dollar") {
          if (substr(line, i, length(tag)) == tag) { state = "code"; i += length(tag) } else { i++ }
          continue
        }

        # state == "code"
        if (c2 == "--") { break }
        if (c2 == "/*") { state = "block"; opened = NR; i += 2; continue }
        if (c != " " && c != "\t" && c != ";") { open_stmt = 1; has_stmt = 1; last = NR }
        if (c == "\047") { state = "squote"; opened = NR; code = code "\047\047"; i++; continue }
        if (c == "\"") { state = "dquote"; opened = NR; code = code "\"\""; i++; continue }
        if (c == "$" && match(substr(line, i), /^\$[A-Za-z_]*\$/)) {
          tag = substr(line, i, RLENGTH); state = "dollar"; opened = NR; i += RLENGTH
          continue
        }
        if (c == "(") {
          if (depth == 0) { paren = NR }
          depth++
        } else if (c == ")") {
          if (depth == 0) {
            printf "E\t%d\tunbalanced \")\" with no matching \"(\"\n", NR
          } else {
            depth--
          }
        } else if (c == ";") {
          if (depth > 0) {
            printf "E\t%d\tstatement ends with %d unclosed \"(\" (opened on line %d)\n", NR, depth, paren
            depth = 0
          }
          open_stmt = 0
        }
        code = code c
        i++
      }

      upper = toupper(code)
      if (upper ~ /DROP[ \t]+(TABLE|COLUMN|SCHEMA|TYPE|VIEW)/ ||
          upper ~ /TRUNCATE[ \t]/ ||
          upper ~ /DELETE[ \t]+FROM/ ||
          upper ~ /ALTER[ \t]+COLUMN.*[ \t]TYPE[ \t]/ ||
          upper ~ /SET[ \t]+NOT[ \t]+NULL/ ||
          upper ~ /RENAME[ \t]+(TO|COLUMN)/) {
        stmt = line
        gsub(/^[ \t]+|[ \t]+$/, "", stmt)
        printf "D\t%d\t%s\n", NR, stmt
      }
    }
    END {
      if (state == "block") {
        printf "E\t%d\tunterminated /* comment (opened on line %d)\n", NR, opened
      } else if (state == "squote") {
        printf "E\t%d\tunterminated string literal (opened on line %d)\n", NR, opened
      } else if (state == "dquote") {
        printf "E\t%d\tunterminated quoted identifier (opened on line %d)\n", NR, opened
      } else if (state == "dollar") {
        printf "E\t%d\tunterminated dollar-quoted string %s (opened on line %d)\n", NR, tag, opened
      }
      if (depth > 0) {
        printf "E\t%d\t%d unclosed \"(\" (opened on line %d)\n", NR, depth, paren
      }
      if (!has_stmt) {
        printf "E\t1\tcontains no SQL statements (only comments or whitespace)\n"
      } else if (open_stmt && state == "code") {
        printf "E\t%d\tfinal statement is not terminated with \";\"\n", last
      }
    }
  ' "$1"
}

# --- 1. static checks ------------------------------------------------------------

echo "Verifying Prisma migrations in ${MIGRATIONS_DIR}"

section "Schema"
if [ ! -f "$SCHEMA_PATH" ]; then
  error "Prisma schema not found" "$SCHEMA_PATH"
elif [ "${SKIP_SCHEMA_VALIDATION:-false}" = "true" ]; then
  echo "Skipping prisma validate (SKIP_SCHEMA_VALIDATION=true)."
else
  # `prisma validate` resolves env() in the datasource; a placeholder keeps the
  # check usable without a configured database. It never connects.
  if ! DATABASE_URL="${DATABASE_URL:-postgresql://placeholder:placeholder@localhost:5432/placeholder}" \
    npx --no-install prisma validate --schema "$SCHEMA_PATH"; then
    error "Prisma schema is invalid; see the prisma validate output above" "$SCHEMA_PATH"
  fi
fi

schema_provider=""
if [ -f "$SCHEMA_PATH" ]; then
  schema_provider="$(awk '
    /^[ \t]*datasource[ \t]/ { in_ds = 1 }
    in_ds && /^[ \t]*provider[ \t]*=/ {
      match($0, /"[^"]*"/); print substr($0, RSTART + 1, RLENGTH - 2); exit
    }
    in_ds && /^[ \t]*}/ { in_ds = 0 }
  ' "$SCHEMA_PATH")"
fi

section "Migration structure"

migrations=()
if [ ! -d "$MIGRATIONS_DIR" ]; then
  if [ -f "$SCHEMA_PATH" ] && grep -qE '^[[:space:]]*model[[:space:]]' "$SCHEMA_PATH"; then
    error "Migrations directory not found, but the schema defines models. Create one with: npx prisma migrate dev --name init" "$MIGRATIONS_DIR"
  else
    echo "No migrations directory found at ${MIGRATIONS_DIR}."
  fi
else
  lock_file="${MIGRATIONS_DIR}/migration_lock.toml"
  if [ ! -f "$lock_file" ]; then
    error "migration_lock.toml is missing; it is generated by prisma migrate dev and must be committed" "$lock_file"
  else
    lock_provider="$(sed -n 's/^[[:space:]]*provider[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$lock_file" | head -n 1)"
    if [ -z "$lock_provider" ]; then
      error "migration_lock.toml does not declare a provider" "$lock_file"
    elif [ -n "$schema_provider" ] && [ "$lock_provider" != "$schema_provider" ]; then
      error "migration_lock.toml provider \"${lock_provider}\" does not match the schema datasource provider \"${schema_provider}\"" "$lock_file"
    fi
  fi

  declare -A seen_timestamps=()
  for entry in "$MIGRATIONS_DIR"/*; do
    [ -e "$entry" ] || continue
    name="$(basename "$entry")"

    if [ ! -d "$entry" ]; then
      [ "$name" = "migration_lock.toml" ] && continue
      error "Unexpected file in migrations directory; migrations must live in their own folder as <folder>/migration.sql" "$entry"
      continue
    fi

    migrations+=("$name")

    # Prisma applies migrations in lexicographic folder order, so names must be
    # <14-digit timestamp>_<snake_case_name>. A "0_" prefix is Prisma's
    # documented convention for a baseline migration and sorts first.
    if [[ "$name" =~ ^([0-9]{14})_[a-z0-9_]+$ ]]; then
      ts="${BASH_REMATCH[1]}"
      if [ -n "${seen_timestamps[$ts]:-}" ]; then
        error "Timestamp ${ts} is shared with '${seen_timestamps[$ts]}'; regenerate one of them with prisma migrate dev so their order is deterministic" "$entry"
      else
        seen_timestamps[$ts]="$name"
      fi
    elif [[ ! "$name" =~ ^0_[a-z0-9_]+$ ]]; then
      error "Invalid migration folder name '${name}'; expected <YYYYMMDDHHMMSS>_<snake_case_name> as generated by prisma migrate dev" "$entry"
    fi

    sql_file="${entry}/migration.sql"
    if [ ! -f "$sql_file" ]; then
      error "Missing migration.sql; every migration folder must contain one (was the migration generated with --create-only and never saved?)" "$entry"
      continue
    fi

    for extra in "$entry"/* "$entry"/.[!.]*; do
      [ -e "$extra" ] || continue
      [ "$(basename "$extra")" = "migration.sql" ] && continue
      warn "Unexpected file '$(basename "$extra")' in migration folder; Prisma only applies migration.sql" "$entry"
    done

    while IFS=$'\t' read -r kind line message; do
      [ "$kind" = "E" ] && error "Invalid SQL: ${message}" "$sql_file" "$line"
    done < <(lint_sql "$sql_file")
  done

  echo "Inspected ${#migrations[@]} migration folder(s)."
fi

# --- 2. history checks ---------------------------------------------------------

section "Migration history"

if [ -z "$MIGRATION_BASE_REF" ]; then
  echo "Skipping: set MIGRATION_BASE_REF (e.g. origin/main) to check that merged migrations are unchanged."
elif [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "Skipping: no migrations directory."
elif ! base_commit="$(git -C "$MIGRATIONS_DIR" merge-base "$MIGRATION_BASE_REF" HEAD 2>/dev/null)"; then
  warn "Skipping history checks: cannot resolve a merge base with '${MIGRATION_BASE_REF}' (is the ref fetched? CI needs fetch-depth: 0)"
else
  echo "Comparing against ${MIGRATION_BASE_REF} (merge base ${base_commit:0:12})."

  # Folder names are passed relative to MIGRATIONS_DIR, so git resolves them
  # regardless of where the repository root is.
  base_migrations=()
  while IFS= read -r name; do
    [ -n "$name" ] && base_migrations+=("$name")
  done < <(git -C "$MIGRATIONS_DIR" ls-tree -d --name-only "$base_commit" ./ | sed 's#.*/##' | sort)

  newest_base=""
  declare -A on_base=()
  for name in "${base_migrations[@]}"; do
    on_base[$name]=1
    newest_base="$name"
    if [ ! -d "${MIGRATIONS_DIR}/${name}" ]; then
      error "Migration '${name}' exists on ${MIGRATION_BASE_REF} but was deleted; applied migrations must never be removed" "${MIGRATIONS_DIR}/${name}"
    elif ! git -C "$MIGRATIONS_DIR" diff --quiet "$base_commit" -- "${name}/migration.sql"; then
      error "Migration '${name}' already exists on ${MIGRATION_BASE_REF} and was modified. Databases that applied it will report a checksum mismatch; revert the edit and add a new migration instead" "${MIGRATIONS_DIR}/${name}/migration.sql"
    fi
  done

  new_count=0
  for name in "${migrations[@]}"; do
    [ -n "${on_base[$name]:-}" ] && continue
    new_count=$((new_count + 1))
    echo "New migration: ${name}"

    if [ -n "$newest_base" ] && [[ ! "$name" > "$newest_base" ]]; then
      error "New migration '${name}' sorts before '${newest_base}', the newest migration on ${MIGRATION_BASE_REF}; Prisma would apply it out of order. Regenerate it with a current timestamp" "${MIGRATIONS_DIR}/${name}"
    fi

    sql_file="${MIGRATIONS_DIR}/${name}/migration.sql"
    [ -f "$sql_file" ] || continue
    while IFS=$'\t' read -r kind line statement; do
      [ "$kind" = "D" ] && warn "Potentially destructive statement; confirm it is intended and that existing data is migrated: ${statement}" "$sql_file" "$line"
    done < <(lint_sql "$sql_file")
  done
  echo "${new_count} new migration(s) relative to ${MIGRATION_BASE_REF}."
fi

# --- 3. database checks --------------------------------------------------------

section "Database replay and drift"

if [ -z "$SHADOW_DATABASE_URL" ]; then
  echo "Skipping: set SHADOW_DATABASE_URL to a disposable database to replay migrations and detect schema drift."
elif [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "Skipping: no migrations directory."
else
  # Replays every migration, in order, on the (reset) shadow database, then
  # diffs the result against schema.prisma. Exit codes: 0 = no drift,
  # 2 = drift, anything else = a migration failed to apply.
  set +e
  diff_output="$(DATABASE_URL="${DATABASE_URL:-$SHADOW_DATABASE_URL}" npx --no-install prisma migrate diff \
    --from-migrations "$MIGRATIONS_DIR" \
    --to-schema-datamodel "$SCHEMA_PATH" \
    --shadow-database-url "$SHADOW_DATABASE_URL" \
    --script \
    --exit-code 2>&1)"
  status=$?
  set -e

  case "$status" in
    0)
      echo "All migrations replayed cleanly and match ${SCHEMA_PATH}."
      ;;
    2)
      echo "$diff_output"
      error "${SCHEMA_PATH} has changes that are not captured by any migration (SQL needed shown above). Generate one with: npx prisma migrate dev --name <change>" "$SCHEMA_PATH"
      ;;
    *)
      echo "$diff_output"
      error "Replaying the migration history on an empty database failed (see output above). A migration has invalid SQL or depends on an object created by a later migration" "$MIGRATIONS_DIR"
      ;;
  esac
fi

# --- working tree ------------------------------------------------------------

if [ "${CHECK_GIT_DIRTY:-false}" = "true" ]; then
  section "Working tree"
  if [ -n "$(git status --porcelain)" ]; then
    git status --porcelain
    error "Git working tree is dirty; uncommitted migration or schema changes detected"
  else
    echo "Working tree is clean."
  fi
fi

# --- summary -------------------------------------------------------------------

echo
if [ "$errors" -gt 0 ]; then
  echo "Migration verification FAILED: ${errors} error(s), ${warnings} warning(s)."
  exit 1
fi
echo "Migration verification passed with ${warnings} warning(s)."
