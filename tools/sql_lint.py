#!/usr/bin/env python3
"""Static lint for Supabase migrations (stdlib only, no database needed).

Usage: python3 tools/sql_lint.py supabase/migrations

Fails (exit 1) when:
  * a `create table public.X` has no `alter table public.X enable row level security`
  * a public table has no `create policy ... on public.X`
  * a table in schema private has RLS off (defence in depth)
  * a policy uses `using (true)` / `with check (true)`
  * a migration is missing `set check_function_bodies = off` while defining functions
  * a `create table` / `create index` / `create policy` / `create trigger` is not idempotent
    (missing `if not exists`, or no preceding `drop ... if exists`)
"""
import pathlib
import re
import sys


def strip_comments(sql: str) -> str:
    return re.sub(r"--[^\n]*", "", sql)


def main(path: str) -> int:
    files = sorted(pathlib.Path(path).glob("*.sql"))
    if not files:
        print(f"❌ no .sql files in {path}")
        return 1
    errors: list[str] = []
    all_sql = ""
    for f in files:
        raw = f.read_text(encoding="utf-8")
        sql = strip_comments(raw).lower()
        all_sql += sql + "\n"
        if re.search(r"create\s+(or\s+replace\s+)?function", sql) and "set check_function_bodies = off" not in sql:
            errors.append(f"{f.name}: defines functions without `set check_function_bodies = off`")
        for m in re.finditer(r"create\s+table\s+(?!if\s+not\s+exists)([\w.]+)", sql):
            errors.append(f"{f.name}: `create table {m.group(1)}` is not idempotent (use if not exists)")
        for m in re.finditer(r"create\s+(unique\s+)?index\s+(?!if\s+not\s+exists)(\w+)", sql):
            errors.append(f"{f.name}: `create index {m.group(2)}` is not idempotent")
        for kind in ("policy", "trigger"):
            for m in re.finditer(rf"create\s+{kind}\s+(\w+)\s+on\s+([\w.]+)", sql):
                name, table = m.group(1), m.group(2)
                if not re.search(rf"drop\s+{kind}\s+if\s+exists\s+{name}\s+on\s+{re.escape(table)}\b", sql[: m.start()]):
                    errors.append(f"{f.name}: `create {kind} {name}` has no preceding `drop {kind} if exists`")
        if re.search(r"(using|with\s+check)\s*\(\s*true\s*\)", sql):
            errors.append(f"{f.name}: policy with `(true)` condition")

    tables = re.findall(r"create\s+table\s+if\s+not\s+exists\s+(public|private)\.(\w+)", all_sql)
    for schema, name in tables:
        if not re.search(rf"alter\s+table\s+{schema}\.{name}\s+enable\s+row\s+level\s+security", all_sql):
            errors.append(f"{schema}.{name}: RLS not enabled")
        if schema == "public" and not re.search(rf"create\s+policy\s+\w+\s+on\s+public\.{name}\b", all_sql):
            errors.append(f"public.{name}: no policy")

    n_pub = sum(1 for s, _ in tables if s == "public")
    n_priv = len(tables) - n_pub
    if errors:
        for e in errors:
            print(f"❌ {e}")
        return 1
    print(f"✅ {len(files)} migration files, {n_pub} public + {n_priv} private tables: RLS on, policies present, idempotent DDL")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "supabase/migrations"))
