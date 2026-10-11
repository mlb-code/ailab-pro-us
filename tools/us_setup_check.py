#!/usr/bin/env python3
"""
Post-setup verification of the real `ailab-us` Supabase project (run after tools/us_setup.py). Stdlib only.

Checks (Hebrew ✅/❌ lines, exit 1 on any ❌):
  1. RLS is enabled on every table in schema public
  2. anon has no table grants in public/private and can execute no function except public.ping()
  3. public.ping() answers 'ok' through the REST API with the public (publishable/anon) key
  4. pg_cron jobs ailab-us-retention + ailab-us-expire-quotes exist and are active
  5. `delete from auth.users` succeeds when run by a pg_cron job (TASKS Addendum 2, A2)

Check 5 — what it does and what is expected:
  * inserts one throw-away user `a2-delete-check+<random>@example.invalid` into auth.users,
  * schedules a one-off cron job `ailab-us-check_delete_job` that runs `delete from auth.users where email = <that>`,
  * waits (default up to 150 s) until the row is gone, reads cron.job_run_details, then ALWAYS unschedules the job
    and removes the test user if it is still there.
  Expected: the job status is `succeeded` and the user is gone. pg_cron runs the job as the role that scheduled it
  (`postgres` via the Management API — the same owner as private.run_retention()), and `postgres` may run DML on
  auth.users on hosted Supabase. Deleting the user cascades to public.profiles and the rows that reference it.
  If it is BLOCKED (`permission denied for table users`, or the job fails): retention keeps working (each client is
  wrapped in begin…exception → a `retention_error` event, nothing of that client changes). Fallback to build then:
  private.anonymize_client() stops at `delete from auth.users`, writes the user id to a queue, and the runtime
  (service role) deletes it through the Auth admin API: `DELETE {SUPABASE_URL}/auth/v1/admin/users/{id}` with the
  service-role key (supabase-js: `supabase.auth.admin.deleteUser(id)`), then marks the queue row done.

Usage:
  python3 tools/us_setup_check.py                    # project from site/assets/config.js or by name
  python3 tools/us_setup_check.py --ref <ref>
  python3 tools/us_setup_check.py --skip-delete-check
"""
import argparse
import os
import secrets as pysecrets
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import us_setup as U  # noqa: E402

JOB = "ailab-us-check_delete_job"
SLEEP = time.sleep


def check_rls(ctx):
    rows = ctx.api.sql(ctx.ref, """select c.relname as table from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity order by 1;""") or []
    if rows:
        ctx.fail("RLS כבוי בטבלאות: " + ", ".join("public." + r["table"] for r in rows))
    else:
        ctx.ok("RLS פעיל בכל טבלאות public")


def check_anon(ctx):
    tables = ctx.api.sql(ctx.ref, """select grantee, table_schema || '.' || table_name as object, privilege_type as privilege
  from information_schema.role_table_grants
 where grantee in ('anon', 'PUBLIC') and table_schema in ('public', 'private') order by 2, 3;""") or []
    funcs = ctx.api.sql(ctx.ref, """select distinct grantee, routine_schema || '.' || routine_name as object
  from information_schema.routine_privileges
 where grantee in ('anon', 'PUBLIC') and privilege_type = 'EXECUTE'
   and routine_schema in ('public', 'private') and not (routine_schema = 'public' and routine_name = 'ping')
 order by 2;""") or []
    bad = [f"{r['object']} ({r.get('privilege', 'EXECUTE')} ל-{r['grantee']})" for r in tables + funcs]
    if bad:
        ctx.fail("ל-anon יש הרשאות: " + ", ".join(bad))
    else:
        ctx.ok("ל-anon אין הרשאות על טבלאות, ופונקציה יחידה פתוחה: ping()")


def check_ping(ctx):
    try:
        U.step_ping(ctx)
    except (U.SetupError, U.ApiError) as e:
        ctx.fail("ping() לא עובד: " + str(e)[:200])


def check_cron(ctx):
    jobs = U.cron_jobs(ctx)
    missing = [j for j in U.CRON_JOBS if j not in jobs or not jobs[j].get("active", True)]
    if missing:
        ctx.fail("משימות cron חסרות או כבויות: " + ", ".join(missing))
    else:
        ctx.ok("cron: " + ", ".join(U.CRON_JOBS) + " פעילות")


def check_delete_from_cron(ctx, wait_s):
    email = f"a2-delete-check+{pysecrets.token_hex(6)}@example.invalid"
    lit = U.sql_lit(email)
    try:
        ctx.api.sql(ctx.ref, f"""insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at)
values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', {lit},
  '{{}}'::jsonb, '{{}}'::jsonb, now(), now());""")
        ctx.api.sql(ctx.ref, f"select cron.schedule({U.sql_lit(JOB)}, '* * * * *', "
                             f"$job$delete from auth.users where email = {lit}$job$);  -- check_delete_job")
        say_wait = True
        gone = False
        for _ in range(max(1, wait_s // 10)):
            n = (ctx.api.sql(ctx.ref, f"select count(*)::int as n from auth.users where email = {lit};") or [{}])[0].get("n")
            if n == 0:
                gone = True
                break
            if say_wait:
                U.say("  ממתין שמשימת ה-cron תרוץ (עד דקה וחצי)…"); say_wait = False
            SLEEP(10)
        det = ctx.api.sql(ctx.ref, f"""select d.status, d.return_message from cron.job_run_details d
  join cron.job j on j.jobid = d.jobid where j.jobname = {U.sql_lit(JOB)} order by d.start_time desc limit 1;""") or []
        status = det[0].get("status") if det else "no-run"
        msg = (det[0].get("return_message") or "") if det else ""
        if gone and status == "succeeded":
            ctx.ok("delete from auth.users מתוך משימת pg_cron עובד (status succeeded). השמירה (retention) תמחק משתמשים כמתוכנן.")
        else:
            ctx.fail(f"delete from auth.users מתוך pg_cron לא הצליח (status {status}: {msg[:160]}). "
                     "צריך את המסלול החלופי דרך Auth admin API (ראו ראש הקובץ tools/us_setup_check.py).")
    finally:
        try:
            ctx.api.sql(ctx.ref, f"select cron.unschedule(jobid) from cron.job where jobname = {U.sql_lit(JOB)};")
            ctx.api.sql(ctx.ref, f"delete from auth.users where email = {lit};  -- cleanup of the test user only")
        except U.ApiError as e:
            ctx.fail("ניקוי בדיקת המחיקה נכשל, למחוק ידנית את המשימה " + JOB + ": " + e.text[:160])


def run(argv=None, transport=None):
    ap = argparse.ArgumentParser(description="Verify the real ailab-us project.")
    ap.add_argument("--ref")
    ap.add_argument("--skip-delete-check", action="store_true")
    ap.add_argument("--wait", type=int, default=150, help="seconds to wait for the cron delete job")
    a = ap.parse_args(argv)
    sec = U.load_secrets()
    token = sec.get("SUPABASE_ACCESS_TOKEN", "")
    if not token.startswith("sbp_"):
        U.say("❌ חסר SUPABASE_ACCESS_TOKEN תקין ב-.secrets.env.")
        return 1
    args = U.build_parser().parse_args(["--ref", a.ref] if a.ref else [])
    ctx = U.Ctx(args, sec, U.load_brand(), U.Api(token, U.Redactor(list(sec.values())), transport))
    try:
        ctx.ref = U.find_or_create(ctx)
        U.wait_healthy(ctx)
        for fn in (check_rls, check_anon, check_ping, check_cron):
            fn(ctx)
        if not a.skip_delete_check:
            check_delete_from_cron(ctx, a.wait)
    except (U.SetupError, U.ApiError) as e:
        U.say(str(e)[:500])
        return 1
    except U.NetError as e:
        U.say("❌ אין חיבור ל-Supabase: " + ctx.api.redact(str(e))[:300] + ". לבדוק אינטרנט/VPN ולהריץ שוב.")
        return 1
    failed = [t for ok, t in ctx.report if ok is False]
    U.say("\n" + ("❌ נמצאו בעיות: " + str(len(failed)) if failed else "✅ כל הבדיקות על הפרויקט האמיתי עברו."))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(run())
