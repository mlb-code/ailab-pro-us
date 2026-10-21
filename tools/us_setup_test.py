#!/usr/bin/env python3
"""Offline tests for tools/us_setup.py and tools/us_setup_check.py: a fake Supabase Management API, no network.

Run: python3 tools/us_setup_test.py   (or: python3 tools/us_setup.py --self-test)
Fake credentials below are built at runtime so the secrets scanner never sees a key-shaped literal.
"""
import base64
import contextlib
import io
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import us_setup as S  # noqa: E402
import us_setup_check as C  # noqa: E402

TOKEN = "sbp_" + "a1" * 20
RESEND = "re_" + "Zz9" * 6
ANTHROPIC = "sk-ant-" + "q" * 30
GCID = "1234-test.apps.googleusercontent.com"
GSEC = "GOCSPX-" + "w" * 24
PUB = "sb_publishable_" + "p" * 24
REF = "abcdefghijklmnopqrst"
SRK = "eyJ" + "s" * 20 + "." + "t" * 30 + "." + "u" * 20   # fake service_role JWT


class FakeApi:
    """Tiny stateful stand-in for api.supabase.com/v1 + the project REST endpoint."""

    def __init__(self, orgs=None, projects=None, plan="free", coming_up=2, fail_migration=None,
                 rls="pass", echo_token_on=None, buckets=True, cron=True):
        self.orgs = orgs if orgs is not None else [{"id": "org-one", "slug": "org-one", "name": "New mailbox org"}]
        self.projects = projects if projects is not None else []
        self.plan = plan
        self.coming_up = coming_up
        self.fail_migration = fail_migration
        self.rls = rls
        self.echo_token_on = echo_token_on
        self.buckets = buckets
        self.cron = cron
        self.calls = []        # (method, url, headers, body bytes)
        self.sql = []
        self.auth_cfg = {}
        self.secrets = []
        self.deploys = []
        self.cron_deletes = 0

    def __call__(self, method, url, headers, data):
        self.calls.append((method, url, headers, data))
        body = json.loads(data) if data and headers.get("Content-Type") == "application/json" else None
        path = url.replace(S.API, "")

        def ok(obj, status=200):
            return status, json.dumps(obj).encode()

        if self.echo_token_on and self.echo_token_on in path:
            return 500, ("upstream said: bad token " + headers.get("Authorization", "")).encode()
        if url.startswith(f"https://{REF}.supabase.co/rest/v1/rpc/ping"):
            return (200, b'"ok"') if headers.get("apikey") == PUB else (401, b'{"message":"no key"}')
        if method == "GET" and path == "/organizations":
            return ok(self.orgs)
        if method == "GET" and path.startswith("/organizations/"):
            return ok({"id": path.split("/")[-1], "plan": self.plan})
        if method == "GET" and path == "/projects":
            return ok(self.projects)
        if method == "POST" and path == "/projects":
            p = {"id": REF, "ref": REF, "name": body["name"], "region": body["region"],
                 "organization_id": body.get("organization_slug") or body.get("organization_id"), "status": "COMING_UP"}
            self.projects.append(p)
            self.created = body
            return ok(p, 201)
        if method == "GET" and re.fullmatch(r"/projects/[a-z]+", path):
            if self.coming_up > 0:
                self.coming_up -= 1
                return ok({"status": "COMING_UP"})
            return ok({"status": "ACTIVE_HEALTHY"})
        if path.endswith("/database/query"):
            q = body["query"]
            self.sql.append(q)
            if self.fail_migration and self.fail_migration in q:
                return 400, b'{"message":"ERROR: 42P01: relation does not exist"}'
            if "RLS_TESTS_PASSED" in q and "do $test$" in q:
                if self.rls == "pass":
                    return 400, b'{"message":"ERROR:  P0001: RLS_TESTS_PASSED (159 checks)"}'
                return 400, b'{"message":"ERROR:  P0001: FAIL anon can read leads"}'
            if "from storage.buckets" in q:
                return ok([{"id": "client-files", "public": False}, {"id": "videos-public", "public": True}] if self.buckets else [])
            if "from cron.job" in q and "jobname" in q and "delete" not in q:
                return ok([{"jobname": j, "schedule": "x", "active": True} for j in S.cron_job_names()] if self.cron else [])
            return ok([])
        if path.endswith("/config/auth"):
            if method == "PATCH":
                self.auth_cfg.update(body)
                return ok(self.auth_cfg)
            return ok(self.auth_cfg)
        if path.endswith("/secrets") and method == "POST":
            self.secrets.append(body)
            return ok(None, 201)
        if "/functions/deploy" in path:
            self.deploys.append((path, headers.get("Content-Type"), data))
            return ok({"id": "f1", "slug": "x", "status": "ACTIVE"}, 201)
        if "/api-keys" in path:
            reveal = "reveal=true" in path
            return ok([{"name": "anon", "type": "legacy", "api_key": "eyJ.anon.key"},
                       {"name": "default", "type": "publishable", "api_key": PUB},
                       {"name": "service_role", "type": "legacy", "api_key": SRK if reveal else None}])
        return 404, b'{"message":"not in fake"}'

    def methods(self):
        return {m for m, *_ in self.calls}

    def paths(self, method=None):
        return [u.replace(S.API, "") for m, u, *_ in self.calls if method in (None, m)]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="us_setup_test_")
        self.saved = {k: getattr(S, k) for k in ("SECRETS_FILE", "CONFIG_JS", "BRAND_JSON", "FUNCTIONS_DIR", "SLEEP", "ROOT")}
        S.SECRETS_FILE = os.path.join(self.tmp, ".secrets.env")
        S.CONFIG_JS = os.path.join(self.tmp, "config.js")
        S.BRAND_JSON = os.path.join(self.tmp, "brand.json")
        S.FUNCTIONS_DIR = os.path.join(self.tmp, "functions")
        S.ROOT = self.tmp
        S.SLEEP = lambda s: None
        os.makedirs(S.FUNCTIONS_DIR)
        with open(S.BRAND_JSON, "w") as f:
            json.dump({"name": "Test Brand", "site_url": "https://example.test", "support_email": "help@example.test",
                       "senders": {"transactional": "Test Brand <hello@example.test>", "quotes": "Q <q@example.test>",
                                   "alerts": "A <a@example.test>", "reply_to": "help@example.test"},
                       "owner": {"admin_email": "owner@example.test"}, "show_founder_price": False, "legal_final": False}, f)
        with open(S.CONFIG_JS, "w") as f:
            f.write("window.SITE_CONFIG = { BACKEND: 'mock', SUPABASE_URL: '', SUPABASE_ANON_KEY: '',\n"
                    "  SUPABASE_JS: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js' };\n")
        self.secrets({"SUPABASE_ACCESS_TOKEN": TOKEN})

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(S, k, v)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def secrets(self, kv, extra=""):
        with open(S.SECRETS_FILE, "w") as f:
            f.write("# test\n" + "".join(f"{k}={v}\n" for k, v in kv.items()) + extra)

    def run_cli(self, argv, fake):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = S.run(argv, transport=fake)
        text = out.getvalue()
        for secret in (TOKEN, RESEND, ANTHROPIC, GSEC, SRK):
            self.assertNotIn(secret, text, "a secret was printed")
        self.assertNotIn("Bearer " + TOKEN[:6], text)
        return rc, text


class TestSetup(Base):
    def test_dry_run_makes_no_network_call(self):
        def boom(*a):
            raise AssertionError("network call in --dry-run")
        rc, out = self.run_cli(["--dry-run", "--create"], boom)
        self.assertEqual(rc, 0)
        self.assertIn("dry-run", out)
        for step in S.STEPS:
            self.assertIn(f"[{step}]", out)
        self.assertIn("us-east-1", out)
        self.assertIn("20261011100000_us_schema.sql", out)

    def test_dry_run_without_token(self):
        self.secrets({"SUPABASE_ACCESS_TOKEN": "<paste here>"})
        rc, out = self.run_cli(["--dry-run"], lambda *a: (_ for _ in ()).throw(AssertionError("net")))
        self.assertEqual(rc, 0)
        self.assertIn("טוקן Supabase אין", out)

    def test_missing_or_placeholder_token(self):
        self.secrets({"SUPABASE_ACCESS_TOKEN": ""})
        fake = FakeApi()
        rc, out = self.run_cli([], fake)
        self.assertEqual(rc, 1)
        self.assertIn("חסר SUPABASE_ACCESS_TOKEN", out)
        self.assertEqual(fake.calls, [])

    def test_wrong_token_kind(self):
        self.secrets({"SUPABASE_ACCESS_TOKEN": PUB})
        rc, out = self.run_cli([], FakeApi())
        self.assertEqual(rc, 1)
        self.assertIn("sbp_", out)

    def test_create_full_path(self):
        self.secrets({"SUPABASE_ACCESS_TOKEN": TOKEN, "RESEND_API_KEY": RESEND, "ANTHROPIC_API_KEY": ANTHROPIC,
                      "GOOGLE_OAUTH_CLIENT_ID": GCID, "GOOGLE_OAUTH_CLIENT_SECRET": GSEC})
        fake = FakeApi(coming_up=2)
        rc, out = self.run_cli(["--create"], fake)
        self.assertEqual(rc, 0, out)
        # project body: name, region, org, password from .secrets.env
        self.assertEqual(fake.created["name"], "ailab-us")
        self.assertEqual(fake.created["region"], "us-east-1")
        self.assertEqual(fake.created["organization_slug"], "org-one")
        sec = S.load_secrets()
        self.assertEqual(fake.created["db_pass"], sec["SUPABASE_DB_PASSWORD"])
        self.assertGreaterEqual(len(sec["SUPABASE_DB_PASSWORD"]), 40)
        self.assertNotIn(sec["SUPABASE_DB_PASSWORD"], out)
        self.assertEqual(stat.S_IMODE(os.stat(S.SECRETS_FILE).st_mode), 0o600)
        # polled until healthy
        self.assertGreaterEqual(fake.paths("GET").count(f"/projects/{REF}"), 3)
        # migrations in order, then the RLS test
        migs = S.migration_files()
        bodies = fake.sql[:len(migs)]
        for f, q in zip(migs, bodies):
            self.assertEqual(q, S.read_text(os.path.join(S.MIG_DIR, f)))
        self.assertIn("do $test$", fake.sql[len(migs)])
        self.assertIn("בדיקת RLS עברה", out)
        # settings from brand.json
        self.assertTrue(any("update private.settings" in q and "owner@example.test" in q and
                            "https://example.test/start/" in q for q in fake.sql))
        # auth: magic link + OTP, redirect list, SMTP via Resend, Google
        a = fake.auth_cfg
        self.assertEqual(a["mailer_otp_length"], 6)
        self.assertEqual(a["mailer_otp_exp"], 1800)
        self.assertEqual(a["site_url"], "https://example.test/start/")
        self.assertIn("http://localhost:*/**", a["uri_allow_list"])
        self.assertIn("{{ .Token }}", a["mailer_templates_magic_link_content"])
        self.assertIn("{{ .ConfirmationURL }}", a["mailer_templates_magic_link_content"])
        self.assertIn("Test Brand", a["mailer_templates_magic_link_content"])
        self.assertNotIn("{{BRAND_NAME}}", a["mailer_templates_magic_link_content"])
        self.assertEqual(a["smtp_host"], "smtp.resend.com")
        self.assertEqual(a["smtp_admin_email"], "hello@example.test")
        self.assertEqual(a["smtp_pass"], RESEND)
        self.assertTrue(a["external_google_enabled"])
        # vault + function secrets
        vault = [q for q in fake.sql if "vault.create_secret" in q]
        self.assertEqual(len(vault), 4)
        for name in ("ailab_us_project_url", "ailab_us_service_role_key", "resend_api_key", "anthropic_api_key"):
            self.assertTrue(any(f"'{name}'" in q for q in vault), name)
        self.assertTrue(any(SRK in q and "ailab_us_service_role_key" in q for q in vault))
        self.assertTrue(any(f"https://{REF}.supabase.co" in q and "ailab_us_project_url" in q for q in vault))
        # A8 e-mail cron jobs installed AFTER the vault secrets
        inst = next(i for i, q in enumerate(fake.sql) if q.strip() == "select private.install_email_jobs();")
        last_vault = max(i for i, q in enumerate(fake.sql) if "vault.create_secret" in q)
        self.assertGreater(inst, last_vault)
        self.assertEqual({s["name"] for s in fake.secrets[0]}, {"ANTHROPIC_API_KEY", "RESEND_API_KEY"})
        # config.js
        cfg = S.read_text(S.CONFIG_JS)
        self.assertIn("BACKEND: 'supabase'", cfg)
        self.assertIn(f'SUPABASE_URL: "https://{REF}.supabase.co"', cfg)
        self.assertIn(f'SUPABASE_ANON_KEY: "{PUB}"', cfg)
        self.assertIn("GOOGLE_ENABLED: true", cfg)
        self.assertIn('"show_founder_price": false', cfg)
        self.assertIn("supabase-js@2.117.2", cfg)
        self.assertNotIn("service_role", cfg)
        # ping with the public key only, never the management token
        ping = [c for c in fake.calls if "/rpc/ping" in c[1]][0]
        self.assertNotIn("Authorization", ping[2])
        # checklist printed in Hebrew; no destructive verbs used
        self.assertIn("מה נשאר לעשות ידנית", out)
        self.assertIn("הכל הסתיים בהצלחה", out)
        self.assertTrue(fake.methods() <= {"GET", "POST", "PATCH"})

    def test_rerun_existing_is_noop_except_migrations(self):
        fake = FakeApi(projects=[{"id": REF, "ref": REF, "name": "ailab-us", "organization_id": "org-one",
                                  "status": "ACTIVE_HEALTHY"}], coming_up=0)
        rc, out = self.run_cli(["--create"], fake)
        self.assertEqual(rc, 0, out)
        self.assertNotIn("/projects", fake.paths("POST")[:1])
        self.assertFalse(any(p == "/projects" for p in fake.paths("POST")))
        self.assertIn("משתמש בפרויקט קיים", out)
        self.assertNotIn("SUPABASE_DB_PASSWORD", S.read_text(S.SECRETS_FILE))
        self.assertIn("אין RESEND_API_KEY", out)

    def test_existing_db_password_is_reused(self):
        self.secrets({"SUPABASE_ACCESS_TOKEN": TOKEN, "SUPABASE_DB_PASSWORD": "Kept-" + "x" * 30})
        fake = FakeApi(coming_up=0)
        rc, out = self.run_cli(["--create", "--only", "test"], fake)
        self.assertEqual(rc, 0, out)
        self.assertEqual(fake.created["db_pass"], "Kept-" + "x" * 30)
        self.assertEqual(S.read_text(S.SECRETS_FILE).count("SUPABASE_DB_PASSWORD"), 1)

    def test_no_free_slot(self):
        fake = FakeApi(projects=[{"id": "p1", "name": "a", "organization_id": "org-one", "status": "ACTIVE_HEALTHY"},
                                 {"id": "p2", "name": "b", "organization_id": "org-one", "status": "ACTIVE_HEALTHY"}])
        rc, out = self.run_cli(["--create"], fake)
        self.assertEqual(rc, 1)
        self.assertIn("אין מקום פנוי", out)
        self.assertNotIn("/projects", fake.paths("POST"))
        self.assertFalse(os.path.exists(S.SECRETS_FILE) and "SUPABASE_DB_PASSWORD" in S.read_text(S.SECRETS_FILE))

    def test_free_limit_counts_all_orgs(self):
        orgs = [{"id": "org-one", "name": "One"}, {"id": "org-old", "name": "Old"}]
        fake = FakeApi(orgs=orgs, projects=[
            {"id": "p1", "name": "old-a", "organization_id": "org-old", "status": "ACTIVE_HEALTHY"},
            {"id": "p2", "name": "old-b", "organization_id": "org-old", "status": "ACTIVE_HEALTHY"}])
        rc, out = self.run_cli(["--create", "--org", "org-one"], fake)
        self.assertEqual(rc, 1)
        self.assertIn("בכל הארגונים", out)
        self.assertIn("old-a (p1)", out)
        self.assertNotIn("/projects", fake.paths("POST"))

    def test_network_error_is_hebrew_without_traceback(self):
        def down(method, url, headers, data):
            raise S.NetError(f"{method} {url}: timed out")
        rc, out = self.run_cli(["--create"], down)
        self.assertEqual(rc, 1)
        self.assertIn("אין חיבור ל-Supabase", out)
        self.assertNotIn("Traceback", out)

    def test_urllib_transport_wraps_url_errors(self):
        with self.assertRaises(S.NetError):
            S.urllib_transport("GET", "http://127.0.0.1:9/x", {}, None, timeout=2)

    def test_smtp_sender_fallback_order(self):
        b = {"senders": {"transactional": "T <t@new.test>", "fallback": "F <f@old.test>"}}
        self.assertEqual(S.parse_sender(S.smtp_sender(b))[1], "f@old.test")
        b["smtp_from"] = "N <n@new.test>"
        self.assertEqual(S.parse_sender(S.smtp_sender(b))[1], "n@new.test")
        self.assertEqual(S.parse_sender(S.smtp_sender(b, "O <o@x.test>"))[1], "o@x.test")
        self.assertEqual(S.parse_sender(S.smtp_sender({"senders": {"transactional": "T <t@new.test>"}}))[1], "t@new.test")

    def test_auth_uses_fallback_sender(self):
        brand = json.loads(S.read_text(S.BRAND_JSON))
        brand["senders"]["fallback"] = "Test Brand <pro@verified.test>"
        brand["smtp_from"] = ""
        with open(S.BRAND_JSON, "w") as f:
            json.dump(brand, f)
        self.secrets({"SUPABASE_ACCESS_TOKEN": TOKEN, "RESEND_API_KEY": RESEND})
        fake = FakeApi(projects=[{"id": REF, "name": "ailab-us", "status": "ACTIVE_HEALTHY"}], coming_up=0)
        rc, out = self.run_cli(["--only", "auth"], fake)
        self.assertEqual(rc, 0, out)
        self.assertEqual(fake.auth_cfg["smtp_admin_email"], "pro@verified.test")
        self.assertIn("pro@verified.test", out)

    def test_paused_project_does_not_count(self):
        fake = FakeApi(projects=[{"id": "p1", "name": "a", "organization_id": "org-one", "status": "INACTIVE"},
                                 {"id": "p2", "name": "b", "organization_id": "org-one", "status": "ACTIVE_HEALTHY"}],
                       coming_up=0)
        rc, out = self.run_cli(["--create", "--only", "config"], fake)
        self.assertEqual(rc, 0, out)

    def test_paid_org_refused(self):
        fake = FakeApi(plan="pro")
        rc, out = self.run_cli(["--create"], fake)
        self.assertEqual(rc, 1)
        self.assertIn("בתשלום", out)
        self.assertNotIn("/projects", fake.paths("POST"))

    def test_multiple_orgs_need_org_flag(self):
        orgs = [{"id": "org-one", "name": "One"}, {"id": "org-two", "name": "Two"}]
        rc, out = self.run_cli(["--create"], FakeApi(orgs=orgs))
        self.assertEqual(rc, 1)
        self.assertIn("--org org-two", out)
        fake = FakeApi(orgs=orgs, coming_up=0)
        rc, out = self.run_cli(["--create", "--org", "org-two", "--only", "config"], fake)
        self.assertEqual(rc, 0, out)
        self.assertEqual(fake.created["organization_slug"], "org-two")

    def test_failed_migration_stops(self):
        fake = FakeApi(projects=[{"id": REF, "name": "ailab-us", "status": "ACTIVE_HEALTHY"}], coming_up=0,
                       fail_migration="create extension if not exists pg_cron")
        rc, out = self.run_cli([], fake)
        self.assertEqual(rc, 1)
        self.assertIn("20261011100200_us_retention.sql נכשלה", out)
        self.assertFalse(any("do $test$" in q for q in fake.sql))
        self.assertEqual(fake.auth_cfg, {})
        self.assertIn("BACKEND: 'mock'", S.read_text(S.CONFIG_JS))

    def test_rls_failure_stops(self):
        fake = FakeApi(projects=[{"id": REF, "name": "ailab-us", "status": "ACTIVE_HEALTHY"}], coming_up=0, rls="fail")
        rc, out = self.run_cli([], fake)
        self.assertEqual(rc, 1)
        self.assertIn("בדיקת RLS נכשלה", out)
        self.assertIn("FAIL anon can read leads", out)
        self.assertEqual(fake.auth_cfg, {})

    def test_only_test_reports_pass(self):
        fake = FakeApi(projects=[{"id": REF, "name": "ailab-us", "status": "ACTIVE_HEALTHY"}], coming_up=0)
        rc, out = self.run_cli(["--only", "test"], fake)
        self.assertEqual(rc, 0)
        self.assertIn("159", out)
        self.assertEqual(len(fake.sql), 1)

    def test_ref_mode_and_unknown_ref(self):
        fake = FakeApi(projects=[{"id": REF, "name": "other-name", "status": "ACTIVE_HEALTHY"}], coming_up=0)
        rc, out = self.run_cli(["--ref", REF, "--only", "config,ping"], fake)
        self.assertEqual(rc, 0, out)
        rc, out = self.run_cli(["--ref", "zzzzzzzzzzzzzzzzzzzz", "--only", "config"], FakeApi())
        self.assertEqual(rc, 1)
        self.assertIn("לא נמצא בחשבון", out)

    def test_ref_from_config_js(self):
        with open(S.CONFIG_JS, "w") as f:
            f.write(f"window.SITE_CONFIG = {{ SUPABASE_URL: 'https://{REF}.supabase.co' }};")
        fake = FakeApi(projects=[{"id": REF, "name": "renamed", "status": "ACTIVE_HEALTHY"}], coming_up=0)
        rc, out = self.run_cli(["--only", "config"], fake)
        self.assertEqual(rc, 0, out)

    def test_unknown_step(self):
        rc, out = self.run_cli(["--only", "nuke"], FakeApi())
        self.assertEqual(rc, 1)
        self.assertIn("שלב לא מוכר", out)

    def test_error_text_is_redacted(self):
        fake = FakeApi(echo_token_on="/organizations")
        rc, out = self.run_cli(["--create"], fake)
        self.assertEqual(rc, 1)
        self.assertIn("***", out)

    def test_functions_deploy_via_api(self):
        os.makedirs(os.path.join(S.FUNCTIONS_DIR, "quote-view"))
        os.makedirs(os.path.join(S.FUNCTIONS_DIR, "_shared"))
        for rel, txt in (("quote-view/index.ts", "import '../_shared/p.ts';"), ("_shared/p.ts", "export const x = 1;")):
            with open(os.path.join(S.FUNCTIONS_DIR, rel), "w") as f:
                f.write(txt)
        fake = FakeApi(projects=[{"id": REF, "name": "ailab-us", "status": "ACTIVE_HEALTHY"}], coming_up=0)
        rc, out = self.run_cli(["--only", "functions", "--functions-via-api"], fake)
        self.assertEqual(rc, 0, out)
        path, ctype, data = fake.deploys[0]
        self.assertIn("slug=quote-view", path)
        self.assertTrue(ctype.startswith("multipart/form-data; boundary="))
        self.assertIn(b'"verify_jwt": false', data)
        self.assertIn(b'"entrypoint_path": "quote-view/index.ts"', data)
        self.assertIn(b'filename="quote-view/index.ts"', data)
        self.assertIn(b'filename="_shared/p.ts"', data)

    def test_functions_none_yet(self):
        fake = FakeApi(projects=[{"id": REF, "name": "ailab-us", "status": "ACTIVE_HEALTHY"}], coming_up=0)
        rc, out = self.run_cli(["--only", "functions"], fake)
        self.assertEqual(rc, 0)
        self.assertIn("אין עדיין פונקציות", out)

    def test_missing_cron_reruns_retention(self):
        fake = FakeApi(projects=[{"id": REF, "name": "ailab-us", "status": "ACTIVE_HEALTHY"}], coming_up=0, cron=False)
        rc, out = self.run_cli(["--only", "cron"], fake)
        self.assertEqual(rc, 1)
        self.assertTrue(any("cron.schedule('ailab-us-retention'" in q for q in fake.sql))
        self.assertIn("משימות cron חסרות", out)

    def test_cron_names_from_migrations(self):
        names = S.cron_job_names()
        for n in ("ailab-us-retention", "ailab-us-expire-quotes", "ailab-us-email-dispatch", "ailab-us-email-scan",
                  "ailab-us-monthly-invoice", "ailab-us-quote-expiring", "ailab-us-storage-purge"):
            self.assertIn(n, names)
        self.assertEqual(len(names), 7)
        self.assertTrue(S.has_email_jobs())
        self.assertIn("email-unsubscribe", S.NO_VERIFY_JWT)
        self.assertTrue({"quote-view", "quote-accept"} <= S.NO_VERIFY_JWT)
        self.assertIn("RESEND_API_KEY", S.FUNCTION_SECRET_KEYS)

    def test_only_vault_without_service_key_fails_loudly(self):
        fake = FakeApi(projects=[{"id": REF, "name": "ailab-us", "status": "ACTIVE_HEALTHY"}], coming_up=0)
        orig = fake.__call__

        def no_srk(method, url, headers, data):
            if "reveal=true" in url:
                return 200, json.dumps([{"name": "service_role", "api_key": None}]).encode()
            return orig(method, url, headers, data)
        rc, out = self.run_cli(["--only", "vault"], no_srk)
        self.assertEqual(rc, 1)
        self.assertIn("service_role", out)

    def test_bad_resend_key_rejected_before_sql(self):
        self.secrets({"SUPABASE_ACCESS_TOKEN": TOKEN, "RESEND_API_KEY": "re_x'; drop table x; --"})
        fake = FakeApi(projects=[{"id": REF, "name": "ailab-us", "status": "ACTIVE_HEALTHY"}], coming_up=0)
        rc, out = self.run_cli(["--only", "vault"], fake)
        self.assertEqual(rc, 1)
        self.assertEqual(fake.sql, [])

    def test_plan_mode_is_read_only(self):
        fake = FakeApi()
        rc, out = self.run_cli(["--plan"], fake)
        self.assertEqual(rc, 0, out)
        self.assertEqual(fake.methods(), {"GET"})
        self.assertIn("יש מקום פנוי", out)

    def test_no_destructive_calls_in_source(self):
        src = S.read_text(os.path.join(HERE, "us_setup.py"))
        self.assertNotIn('"DELETE"', src)
        for word in ("/pause", "/restore", "/remove", "vault.delete", "drop table", "cron.unschedule"):
            self.assertNotIn(word, src.lower())


# ------------------------------------------------------------------ --only paypal (fake PayPal REST API, no network)
PP_CID = "AbCdEfGhIjKlMnOp" + "QrSt-0123456789_x"
PP_SECRET = "EK" + "p4yp4l" * 8
PP_TOKEN = "A21AA" + "t0k3n" * 8


class FakePayPal:
    """PayPal OAuth + webhooks API in front of FakeApi (Supabase); records every PayPal call."""

    def __init__(self, supabase, hooks=None, auth_ok=True, env="sandbox"):
        self.supabase = supabase
        self.hooks = hooks if hooks is not None else []
        self.auth_ok = auth_ok
        self.base = S.PAYPAL_API[env]
        self.calls = []

    def __call__(self, method, url, headers, data):
        if not url.startswith(("https://api-m.sandbox.paypal.com", "https://api-m.paypal.com")):
            return self.supabase(method, url, headers, data)
        assert url.startswith(self.base), "wrong PayPal environment: " + url
        path = url[len(self.base):]
        self.calls.append((method, path, headers, data))
        if path == "/v1/oauth2/token":
            good = headers.get("Authorization") == "Basic " + base64.b64encode(f"{PP_CID}:{PP_SECRET}".encode()).decode()
            if not (self.auth_ok and good and data == b"grant_type=client_credentials"):
                return 401, b'{"error":"invalid_client","error_description":"Client Authentication failed"}'
            return 200, json.dumps({"access_token": PP_TOKEN, "expires_in": 32400}).encode()
        if headers.get("Authorization") != "Bearer " + PP_TOKEN:
            return 401, b'{"name":"AUTHENTICATION_FAILURE"}'
        if method == "GET" and path == "/v1/notifications/webhooks":
            return 200, json.dumps({"webhooks": self.hooks}).encode()
        if method == "POST" and path == "/v1/notifications/webhooks":
            body = json.loads(data)
            hook = {"id": "8PT597110X687430LKGECATA", "url": body["url"], "event_types": body["event_types"]}
            self.hooks.append(hook)
            return 201, json.dumps(hook).encode()
        if method == "PATCH" and path.startswith("/v1/notifications/webhooks/"):
            ops = json.loads(data)
            hook = next(h for h in self.hooks if h["id"] == path.rsplit("/", 1)[1])
            hook["event_types"] = ops[0]["value"]
            return 200, json.dumps(hook).encode()
        return 404, b'{"name":"NOT_IN_FAKE"}'


class TestPaypal(Base):
    def setUp(self):
        super().setUp()
        self.synced = 0
        self._sync = S.run_sync_config
        S.run_sync_config = lambda: setattr(self, "synced", self.synced + 1)

    def tearDown(self):
        S.run_sync_config = self._sync
        super().tearDown()

    def fake(self, **kw):
        return FakePayPal(FakeApi(projects=[{"id": REF, "name": "ailab-us", "status": "ACTIVE_HEALTHY"}], coming_up=0), **kw)

    def run_pp(self, argv, fake):
        rc, out = self.run_cli(argv, fake)
        for s in (PP_SECRET, PP_TOKEN, base64.b64encode(f"{PP_CID}:{PP_SECRET}".encode()).decode()):
            self.assertNotIn(s, out, "a PayPal secret was printed")
        return rc, out

    def brand_pp(self):
        return json.loads(S.read_text(S.BRAND_JSON)).get("payments", {}).get("paypal")

    def test_not_in_a_full_run_and_listed_in_only(self):
        self.assertNotIn("paypal", S.STEPS)
        self.assertEqual(S.parse_only("paypal,functions"), ["paypal", "functions"])

    def test_missing_keys_stop_before_any_call(self):
        fake = self.fake()
        rc, out = self.run_pp(["--only", "paypal"], fake)
        self.assertEqual(rc, 1)
        self.assertIn("PAYPAL_SANDBOX_CLIENT_ID", out)
        self.assertEqual(fake.calls, [])
        self.assertEqual(fake.supabase.secrets, [])
        self.assertIsNone(self.brand_pp())

    def test_bad_key_rejected_before_any_call(self):
        self.secrets({"SUPABASE_ACCESS_TOKEN": TOKEN, "PAYPAL_SANDBOX_CLIENT_ID": PP_CID, "PAYPAL_SANDBOX_CLIENT_SECRET": "x'; drop"})
        fake = self.fake()
        rc, out = self.run_pp(["--only", "paypal"], fake)
        self.assertEqual(rc, 1)
        self.assertEqual(fake.calls, [])

    def test_sandbox_creates_webhook_sets_secrets_config_stays_off(self):
        self.secrets({"SUPABASE_ACCESS_TOKEN": TOKEN, "PAYPAL_SANDBOX_CLIENT_ID": PP_CID, "PAYPAL_SANDBOX_CLIENT_SECRET": PP_SECRET})
        fake = self.fake()
        rc, out = self.run_pp(["--only", "paypal", "--paypal-env", "sandbox"], fake)
        self.assertEqual(rc, 0, out)
        create = [c for c in fake.calls if c[0] == "POST" and c[1] == "/v1/notifications/webhooks"]
        self.assertEqual(len(create), 1)
        body = json.loads(create[0][3])
        self.assertEqual(body["url"], f"https://{REF}.supabase.co/functions/v1/paypal-webhook")
        self.assertEqual([e["name"] for e in body["event_types"]], list(S.PAYPAL_EVENTS))
        sec = {s["name"]: s["value"] for s in fake.supabase.secrets[0]}
        self.assertEqual(sec, {"PAYPAL_CLIENT_ID": PP_CID, "PAYPAL_CLIENT_SECRET": PP_SECRET, "PAYPAL_ENV": "sandbox",
                               "PAYPAL_WEBHOOK_ID": "8PT597110X687430LKGECATA"})
        self.assertEqual(self.brand_pp(), {"enabled": False, "env": "sandbox", "client_id": PP_CID})
        self.assertEqual(self.synced, 1)
        self.assertIn("--only functions", out)

    def test_live_enable_reuses_webhook_and_adds_missing_events(self):
        self.secrets({"SUPABASE_ACCESS_TOKEN": TOKEN, "PAYPAL_LIVE_CLIENT_ID": PP_CID, "PAYPAL_LIVE_CLIENT_SECRET": PP_SECRET})
        url = f"https://{REF}.supabase.co/functions/v1/paypal-webhook"
        fake = self.fake(env="live", hooks=[{"id": "1JE4291016473214C", "url": url, "event_types": [{"name": "PAYMENT.CAPTURE.COMPLETED"}]}])
        rc, out = self.run_pp(["--only", "paypal", "--paypal-env", "live", "--paypal-enable"], fake)
        self.assertEqual(rc, 0, out)
        self.assertFalse(any(c[0] == "POST" and c[1] == "/v1/notifications/webhooks" for c in fake.calls), "no second webhook")
        patch = [c for c in fake.calls if c[0] == "PATCH"]
        self.assertEqual(len(patch), 1)
        self.assertEqual([e["name"] for e in fake.hooks[0]["event_types"]], list(S.PAYPAL_EVENTS))
        sec = {s["name"]: s["value"] for s in fake.supabase.secrets[0]}
        self.assertEqual([sec["PAYPAL_ENV"], sec["PAYPAL_WEBHOOK_ID"]], ["live", "1JE4291016473214C"])
        self.assertEqual(self.brand_pp(), {"enabled": True, "env": "live", "client_id": PP_CID})

    def test_wrong_keys_stop_with_hebrew_and_change_nothing(self):
        self.secrets({"SUPABASE_ACCESS_TOKEN": TOKEN, "PAYPAL_SANDBOX_CLIENT_ID": PP_CID, "PAYPAL_SANDBOX_CLIENT_SECRET": PP_SECRET})
        fake = self.fake(auth_ok=False)
        rc, out = self.run_pp(["--only", "paypal"], fake)
        self.assertEqual(rc, 1)
        self.assertIn("PayPal (sandbox) לא קיבל את המפתחות", out)
        self.assertEqual(fake.supabase.secrets, [])
        self.assertIsNone(self.brand_pp())

    def test_disable_touches_only_the_config(self):
        self.secrets({"SUPABASE_ACCESS_TOKEN": TOKEN})
        fake = self.fake()
        rc, out = self.run_pp(["--only", "paypal", "--paypal-disable"], fake)
        self.assertEqual(rc, 0, out)
        self.assertEqual(fake.calls, [])
        self.assertEqual(fake.supabase.secrets, [])
        self.assertEqual(self.brand_pp()["enabled"], False)

    def test_events_and_public_endpoints_match_the_functions(self):
        src = S.read_text(os.path.join(S.ROOT if os.path.isdir(os.path.join(S.ROOT, "supabase")) else os.path.dirname(HERE),
                                       "supabase", "functions", "paypal-webhook", "index.ts"))
        m = re.search(r"WEBHOOK_EVENTS = \[([^\]]+)\]", src)
        self.assertEqual(tuple(re.findall(r'"([A-Z._]+)"', m.group(1))), S.PAYPAL_EVENTS)
        self.assertTrue({"pay-create", "pay-capture", "pay-upwork", "paypal-webhook"} <= S.NO_VERIFY_JWT)
        self.assertNotIn("pay-refund", S.NO_VERIFY_JWT, "the refund needs the admin's JWT")

    def test_dry_run_lists_paypal_without_network(self):
        def boom(*a):
            raise AssertionError("network call in --dry-run")
        rc, out = self.run_cli(["--dry-run", "--only", "paypal", "--paypal-env", "live", "--paypal-enable"], boom)
        self.assertEqual(rc, 0)
        self.assertIn("[paypal] PayPal live", out)


class TestCheck(Base):
    def setUp(self):
        super().setUp()
        self._csleep = C.SLEEP
        C.SLEEP = lambda s: None

    def tearDown(self):
        C.SLEEP = self._csleep
        super().tearDown()

    def test_check_happy_path(self):
        fake = FakeApi(projects=[{"id": REF, "name": "ailab-us", "status": "ACTIVE_HEALTHY"}], coming_up=0)

        def transport(method, url, headers, data):
            body = json.loads(data) if data and headers.get("Content-Type") == "application/json" else {}
            q = body.get("query", "") if isinstance(body, dict) else ""
            if "relrowsecurity" in q or "role_table_grants" in q or "routine_privileges" in q:
                fake.calls.append((method, url, headers, data))
                return 200, b"[]"
            if "check_delete_job" in q and "cron.schedule" in q:
                fake.calls.append((method, url, headers, data))
                return 200, b"[]"
            if "from auth.users" in q and "count" in q:
                fake.calls.append((method, url, headers, data))
                fake.cron_deletes += 1
                return 200, json.dumps([{"n": 0 if fake.cron_deletes > 1 else 1}]).encode()
            if "job_run_details" in q:
                fake.calls.append((method, url, headers, data))
                return 200, b'[{"status":"succeeded","return_message":"DELETE 1"}]'
            return fake(method, url, headers, data)

        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = C.run(["--ref", REF], transport=transport)
        text = out.getvalue()
        self.assertEqual(rc, 0, text)
        self.assertIn("RLS פעיל", text)
        self.assertIn("delete from auth.users", text)
        self.assertNotIn(TOKEN, text)

    def test_check_reports_rls_off(self):
        fake = FakeApi(projects=[{"id": REF, "name": "ailab-us", "status": "ACTIVE_HEALTHY"}], coming_up=0)

        def transport(method, url, headers, data):
            body = json.loads(data) if data and headers.get("Content-Type") == "application/json" else {}
            q = body.get("query", "") if isinstance(body, dict) else ""
            if "relrowsecurity" in q:
                return 200, b'[{"table":"calls"}]'
            if "role_table_grants" in q:
                return 200, b'[{"grantee":"anon","object":"public.leads","privilege":"SELECT"}]'
            if "routine_privileges" in q:
                return 200, b"[]"
            return fake(method, url, headers, data)

        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = C.run(["--ref", REF, "--skip-delete-check"], transport=transport)
        self.assertEqual(rc, 1)
        self.assertIn("public.calls", out.getvalue())
        self.assertIn("public.leads", out.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=1)
