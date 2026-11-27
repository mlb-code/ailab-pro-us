"""Automatic provisioning jobs (table `provisioning_jobs`, created by the database when a FirstRing subscription starts
and when the client finishes the setup checklist). Run by the cron `POST /jobs/tick`; retried from the admin.

Kinds:
  number      buy a US local number near the client's area code and point its four webhooks at this runtime
              (voice incoming / fallback / status, SMS incoming), then write `tenants.twilio_number`.
  golive_sim  run the simulator checks against the client's real config (app.golive). The job row's result is what
              the database trigger reads: passed + subscription trialing/active -> client and tenant go live.

SAFETY: buying a number costs money. It happens ONLY when TWILIO_PROVISION_LIVE=1 (default: unset = dry run).
Dry run = search and buy are simulated, nothing reaches Twilio:
  - simulator / tests (RUNTIME_MODE=sim) or TWILIO_PROVISION_DRY_WRITE=1: a fictional number +1 <area> 555-01xx is
    written to the tenant, so the rest of the flow can be tried end to end;
  - production dry run: the job is held (status `held`) and Meir gets an English note with the number that WOULD be
    bought, so no customer ever sees a fake number.
Live purchase is idempotent: the number is bought with FriendlyName = the tenant slug, and before buying the job looks
for a number that already has that name (a retry after a crash never buys a second one).
Failures: retried 3 times (5 and 15 minutes apart), then `failed` + an English e-mail to Meir. Never silent.

Phase 2 (2026-11-25):
  golive_sim  with GOLIVE_LIVE_AI_CHECK=1 also runs ONE scripted conversation on the real model (app.golive.live_ai_check);
              model down after the retries -> the job is `held` (Meir approves by hand), a failed check -> `failed` +
              the transcript in Meir's e-mail.
  releases    `number_releases` rows (scheduled by the database when the service ended): 7-day warning e-mail to the
              customer, then the release. SAFETY: deleting a number happens ONLY when TWILIO_RELEASE_LIVE=1; default =
              dry run (row `held` + English note with the number that would be released). See run_releases().
              The warning goes to the business's alert addresses AND the account e-mail (store.account_email = RPC
              runtime_account_email), deduplicated; no address at all or a send error -> English note to Meir.
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

import httpx

from .store import Store, StoreError

log = logging.getLogger("rt.provisioning")

MAX_ATTEMPTS = 3
BACKOFF_MIN = (5, 15)
STALE_RUNNING = timedelta(minutes=30)
TWILIO_API = "https://api.twilio.com"
_ON = ("1", "true", "yes", "on")
WARN_DAYS = 7  # the customer's warning comes at least this many days before the number is released


def provision_live(env: dict[str, str] | None = None) -> bool:
    return ((os.environ if env is None else env).get("TWILIO_PROVISION_LIVE") or "").strip().lower() in _ON


def release_live(env: dict[str, str] | None = None) -> bool:
    """TWILIO_RELEASE_LIVE=1: a due number release really deletes the number at Twilio. Default (unset) = dry run."""
    return ((os.environ if env is None else env).get("TWILIO_RELEASE_LIVE") or "").strip().lower() in _ON


def _f(v: Any) -> datetime | None:
    return _iso(v) if v else None


def release_eligible(sub: dict[str, Any] | None, plan: dict[str, Any] | None, now: datetime) -> tuple[bool, str]:
    """The runtime's own last check before a number is released (the database schedules; this re-checks at the moment of
    release). True only when the service has ENDED: the subscription was cancelled and its paid time is over, or the free
    trial ended without a paid plan, AND the tenant's config.plan (written by the database) says message-only for that
    reason. Never for an active, trialing (inside the trial), past-due (any) or paused subscription."""
    if not sub:
        return False, "no subscription"
    reason = str((plan or {}).get("service_reason") or "")
    if (plan or {}).get("service") != "message_only" or reason not in ("canceled", "trial_ended"):
        return False, f"service is {(plan or {}).get('service') or 'full'} {reason}".strip()
    st = sub.get("status")
    if st == "canceled":
        end = _f(sub.get("ends_at")) or _f(sub.get("canceled_at"))
        return (bool(end and end <= now), "canceled" if end and end <= now else "paid time not over")
    if st == "active":
        end = _f(sub.get("current_period_end"))
        ok = bool(sub.get("cancel_at_period_end") and end and end < now)
        return ok, "canceled at period end" if ok else "subscription active"
    if st == "trialing":
        end = _f(sub.get("trial_ends_at"))
        return (bool(end and end < now), "trial ended unpaid" if end and end < now else "in trial")
    return False, f"subscription {st}"


def dry_write(settings: Any, env: dict[str, str] | None = None) -> bool:
    e = os.environ if env is None else env
    return bool(getattr(settings, "is_sim", False)) or (e.get("TWILIO_PROVISION_DRY_WRITE") or "").strip().lower() in _ON


def webhooks(base_url: str) -> dict[str, str]:
    """The four webhooks every number needs (docs: b9-readiness §2.5-2.6). ConversationRelay is returned by the runtime."""
    b = base_url.rstrip("/")
    return {"VoiceUrl": f"{b}/voice/incoming", "VoiceMethod": "POST",
            "VoiceFallbackUrl": f"{b}/voice/fallback", "VoiceFallbackMethod": "POST",
            "StatusCallback": f"{b}/voice/status", "StatusCallbackMethod": "POST",
            "SmsUrl": f"{b}/sms/incoming", "SmsMethod": "POST"}


def area_code(e164: str | None) -> str | None:
    m = re.match(r"^\+1([2-9]\d{2})\d{7}$", e164 or "")
    return m.group(1) if m else None


def simulated_number(area: str | None, seed: str, taken: set[str]) -> str:
    """Fictional +1 <area> 555-01xx (the 555-0100..0199 range is reserved for fiction), unique in `taken`."""
    a = area or "202"
    start = int(hashlib.sha256(seed.encode()).hexdigest(), 16) % 100
    for i in range(100):
        n = f"+1{a}55501{(start + i) % 100:02d}"
        if n not in taken:
            return n
    raise RuntimeError("no fictional number left for this area code")


class TwilioNumbers:
    """Twilio REST (AvailablePhoneNumbers + IncomingPhoneNumbers). `transport` = httpx.MockTransport in tests."""

    def __init__(self, account_sid: str, auth_token: str, transport: httpx.BaseTransport | None = None,
                 base_url: str = TWILIO_API, timeout: float = 15.0):
        if not account_sid or not auth_token:
            raise RuntimeError("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are needed to buy numbers")
        self.sid = account_sid
        self.http = httpx.Client(base_url=base_url, auth=(account_sid, auth_token), timeout=timeout, transport=transport)

    def _ok(self, r: httpx.Response) -> dict[str, Any]:
        if r.status_code >= 400:
            code = ""
            try:
                code = str(r.json().get("code", ""))
            except ValueError:
                pass
            raise RuntimeError(f"twilio {r.request.method} {r.request.url.path} -> {r.status_code} {code}".strip())
        return r.json()

    def search(self, *, area: str | None = None, near: str | None = None, limit: int = 5) -> list[str]:
        params: dict[str, Any] = {"VoiceEnabled": "true", "SmsEnabled": "true", "PageSize": limit}
        if area:
            params["AreaCode"] = area
        if near:
            params.update(NearNumber=near, Distance=50)
        data = self._ok(self.http.get(f"/2010-04-01/Accounts/{self.sid}/AvailablePhoneNumbers/US/Local.json", params=params))
        return [x["phone_number"] for x in data.get("available_phone_numbers") or [] if x.get("phone_number")]

    def owned(self, friendly_name: str) -> str | None:
        data = self._ok(self.http.get(f"/2010-04-01/Accounts/{self.sid}/IncomingPhoneNumbers.json",
                                      params={"FriendlyName": friendly_name, "PageSize": 5}))
        rows = data.get("incoming_phone_numbers") or []
        return rows[0]["phone_number"] if rows else None

    def buy(self, number: str, base_url: str, friendly_name: str) -> dict[str, Any]:
        return self._ok(self.http.post(f"/2010-04-01/Accounts/{self.sid}/IncomingPhoneNumbers.json",
                                       data={"PhoneNumber": number, "FriendlyName": friendly_name, **webhooks(base_url)}))

    def sid_of(self, number: str) -> str | None:
        data = self._ok(self.http.get(f"/2010-04-01/Accounts/{self.sid}/IncomingPhoneNumbers.json",
                                      params={"PhoneNumber": number, "PageSize": 5}))
        rows = [r for r in data.get("incoming_phone_numbers") or [] if r.get("phone_number") == number]
        return rows[0].get("sid") if rows else None

    def release(self, number: str) -> bool:
        """Release (delete) an owned number. False = not on the account any more (released before: nothing to do)."""
        sid = self.sid_of(number)
        if not sid:
            return False
        r = self.http.delete(f"/2010-04-01/Accounts/{self.sid}/IncomingPhoneNumbers/{sid}.json")
        if r.status_code == 404:
            return False
        if r.status_code >= 400:
            self._ok(r)
        return True


def _iso(v: Any) -> datetime | None:
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


class Provisioner:
    def __init__(self, store: Store, settings: Any, *, admin_alert: Callable[[str, str, str, str, str], None] | None = None,
                 numbers: TwilioNumbers | None = None, env: dict[str, str] | None = None,
                 golive: Callable[..., dict[str, Any]] | None = None,
                 owner_email: Callable[[dict[str, Any], str, str, str, str, list[str]], bool] | None = None,
                 ai_model: Any = None, account_email: Callable[[str | None], str | None] | None = None):
        self.store = store
        self.settings = settings
        self.env = dict(os.environ if env is None else env)
        self._numbers = numbers
        self.admin_alert = admin_alert or (lambda *a: None)
        self.owner_email = owner_email or (lambda *a: False)
        # the account owner's e-mail for a client id (production: store RPC runtime_account_email); tests inject it
        self.account_email = account_email or getattr(store, "account_email", None) or (lambda cid: None)
        self.ai_model = ai_model  # go-live live AI check: an LLMClient-like object (tests: a fake); None = built from settings
        if golive is None:
            from .golive import run_checks
            golive = run_checks
        self.golive = golive

    # --- the queue -----------------------------------------------------------------------------------
    def due(self, now: datetime) -> list[dict[str, Any]]:
        out = []
        for j in self.store.select("provisioning_jobs"):
            st = j.get("status")
            if st == "pending":
                at = _iso(j.get("next_attempt_at"))
                if at is None or at <= now:
                    out.append(j)
            elif st == "running" and (_iso(j.get("updated_at")) or now) < now - STALE_RUNNING:
                out.append(j)  # a crashed worker left it running: pick it up again
        return sorted(out, key=lambda j: str(j.get("created_at") or ""))

    def run_due(self, now: datetime, limit: int = 20) -> dict[str, int]:
        rep = {"done": 0, "held": 0, "failed": 0, "retry": 0}
        for job in self.due(now)[:limit]:
            rep[self.run(job, now)] += 1
        return rep

    def run(self, job: dict[str, Any], now: datetime) -> str:
        attempts = int(job.get("attempts") or 0) + 1
        self._update(job, {"status": "running", "attempts": attempts, "updated_at": now.isoformat()})
        tenant = (self.store.select("tenants", id=job.get("tenant_id")) or [None])[0]
        try:
            if tenant is None:
                raise RuntimeError("tenant not found")
            if job.get("kind") == "number":
                status, result = self._number(tenant, now)
            elif job.get("kind") == "golive_sim":
                status, result = self._golive(tenant, now)
            else:
                raise RuntimeError(f"unknown job kind {job.get('kind')!r}")
        except Exception as exc:  # noqa: BLE001 - every failure is recorded and retried, never raised into the cron
            err = f"{type(exc).__name__}: {exc}"[:400]
            log.warning("provisioning %s failed for %s: %s", job.get("kind"), (tenant or {}).get("slug"), err)
            if attempts < MAX_ATTEMPTS:
                nxt = now + timedelta(minutes=BACKOFF_MIN[min(attempts, len(BACKOFF_MIN)) - 1])
                self._update(job, {"status": "pending", "last_error": err, "next_attempt_at": nxt.isoformat(),
                                   "updated_at": now.isoformat()})
                return "retry"
            self._update(job, {"status": "failed", "last_error": err, "updated_at": now.isoformat()})
            self._alert("provisioning_failed", tenant, job, f"{self._what(job)} failed {attempts} times. Error: {err}", now)
            return "failed"
        patch = {"status": status, "result": result, "last_error": None, "updated_at": now.isoformat(),
                 "dry_run": bool(result.get("dry_run"))}
        self._update(job, patch)
        if status == "held" and job.get("kind") == "golive_sim":  # the live AI check could not run: manual approval
            ai = result.get("ai_check") or {}
            self._alert("golive_ai_manual", tenant, job,
                        f"The test call with the real model couldn't run after {ai.get('attempts', 0)} attempts "
                        f"({ai.get('error') or 'error'}). The 14 simulator checks: "
                        + ("passed" if all(c.get("ok") for c in result.get("checks") or [] if c.get("name") != "live_ai") else
                           "failed: " + ", ".join(x for x in result.get("failed") or [] if x != "live_ai"))
                        + ". The client stays in testing. To approve by hand: admin → Subscriptions → 'Go live manually', or 'Run the check again'."
                        + _transcript_text(ai), now)
        elif status == "held":
            self._alert("number_dry_run", tenant, job,
                        "Number purchase in test mode (TWILIO_PROVISION_LIVE is off), no number was bought. "
                        f"The number that would have been bought: {result.get('would_buy') or 'none found'}. "
                        "To turn it on: TWILIO_PROVISION_LIVE=1 in Railway, then 'Retry' in the admin, or assign a number by hand.", now)
        elif status == "failed":  # golive checks did not pass: Meir looks, the client keeps the test line
            ai = result.get("ai_check") or {}
            extra = ""
            if ai.get("status") == "failed":
                extra = (" The test call with the real model failed: " + "; ".join(ai.get("problems_he") or ai.get("problems") or [])
                         + ". The client stays in testing. If the answers look fine: admin → Subscriptions → 'Go live manually'." + _transcript_text(ai))
            self._alert("golive_check_failed", tenant, job,
                        "The simulator check before go-live failed: " + ", ".join(result.get("failed") or []) + extra, now)
        return "held" if status == "held" else "failed" if status == "failed" else "done"

    # --- kinds ------------------------------------------------------------------------------------------
    def _number(self, tenant: dict[str, Any], now: datetime) -> tuple[str, dict[str, Any]]:
        if tenant.get("twilio_number"):
            return "done", {"number": tenant["twilio_number"], "existing": True}
        cfg = tenant.get("config") or {}
        main = ((cfg.get("business") or {}).get("main_phone")) or ""
        area = area_code(main)
        slug = str(tenant.get("slug") or tenant.get("id"))
        if not provision_live(self.env):
            rows = self.store.select("tenants")  # never a number in use, nor any client's own business line
            taken = {r.get("twilio_number") for r in rows if r.get("twilio_number")} | {
                ((r.get("config") or {}).get("business") or {}).get("main_phone") for r in rows}
            fake = simulated_number(area, str(tenant.get("id")), taken)
            if dry_write(self.settings, self.env):
                self.store.update("tenants", tenant["id"], {"twilio_number": fake})
                return "done", {"number": fake, "dry_run": True, "area_code": area}
            return "held", {"would_buy": fake, "dry_run": True, "area_code": area, "reason": "TWILIO_PROVISION_LIVE off"}
        base = (getattr(self.settings, "public_base_url", "") or "").rstrip("/")
        if not base.startswith("https://"):
            raise RuntimeError("PUBLIC_BASE_URL (https) is needed for the number's webhooks")
        tw = self.numbers()
        number = tw.owned(slug)  # bought before a crash: reuse, never buy twice
        bought = False
        if not number:
            found = (tw.search(area=area) if area else []) or (self._search_near(tw, main) if area else []) or tw.search()
            if not found:
                raise RuntimeError(f"no US local number available near area code {area}")
            number = found[0]
            tw.buy(number, base, slug)
            bought = True
        self.store.update("tenants", tenant["id"], {"twilio_number": number})
        return "done", {"number": number, "dry_run": False, "area_code": area, "bought": bought,
                        "same_area": bool(area and number.startswith(f"+1{area}"))}

    def _golive(self, tenant: dict[str, Any], now: datetime) -> tuple[str, dict[str, Any]]:
        from .golive import live_ai_enabled
        kw: dict[str, Any] = {"store": self.store, "now": now,
                              "sms": bool(getattr(self.settings, "sms_enabled", False))}  # greeting as it will play
        if live_ai_enabled(self.env):  # GOLIVE_LIVE_AI_CHECK=1: one scripted conversation on the real model too
            kw["ai"] = {"model": self.ai_model, "settings": self.settings, "env": self.env}
        rep = self.golive(tenant, **kw)
        ai = rep.get("ai_check") or {}
        if ai.get("status") == "error":  # the model did not answer after the retries: never stuck, Meir approves by hand
            return "held", rep
        return ("done" if rep.get("passed") else "failed"), rep

    # --- number release after the service ended (table `number_releases`, scheduled by the database) -------------
    # The database (private.number_release_sync, on every subscription write + hourly) keeps one row per tenant:
    # status 'scheduled' with warn_at (= release_at - 7 days) and release_at (= end of service + 30 days). A resubscribe
    # before release cancels the row. This tick sends the 7-day warning and, when due, releases the number:
    #   - the warning goes out once (idempotent e-mail key); the customer always gets 7 days: a release that comes due
    #     before a warning was sent is moved to warning + 7 days (unless Meir pressed "release now": `force`).
    #   - right before releasing, release_eligible() re-reads the subscription; anything not ended -> row 'canceled'.
    #   - TWILIO_RELEASE_LIVE off (default): nothing reaches Twilio; the row is 'held' (dry run) and Meir gets an English
    #     note with the number that WOULD be released. On: the number is deleted at Twilio, tenants.twilio_number = null,
    #     row 'released' (the database then removes the old 'number' job, so a later resubscribe buys a new number).
    #   - Twilio errors: retried 3 times (5 and 15 minutes apart), then 'failed' + an English note. Never silent.
    def releases_due(self, now: datetime) -> list[dict[str, Any]]:
        try:
            rows = self.store.select("number_releases", status="scheduled")
        except StoreError:
            log.exception("could not read number_releases")
            return []
        out = []
        for r in rows:
            nxt = _iso(r.get("next_attempt_at"))
            if nxt is not None and nxt > now:
                continue
            warn, rel = _iso(r.get("warn_at")), _iso(r.get("release_at"))
            if (not r.get("warned_at") and warn is not None and warn <= now) or (rel is not None and rel <= now):
                out.append(r)
        return sorted(out, key=lambda r: str(r.get("release_at") or ""))

    def run_releases(self, now: datetime, limit: int = 20) -> dict[str, int]:
        rep = {"warned": 0, "released": 0, "held": 0, "canceled": 0, "failed": 0, "retry": 0}
        for row in self.releases_due(now)[:limit]:
            rep[self.run_release(row, now)] += 1
        return rep

    def run_release(self, row: dict[str, Any], now: datetime) -> str:
        tenant = (self.store.select("tenants", id=row.get("tenant_id")) or [None])[0]
        number = row.get("number")
        try:
            subs = self.store.select("subscriptions", client_id=row.get("client_id"))
        except StoreError as exc:  # cannot verify -> never release; try again next tick
            return self._release_retry(row, tenant, now, f"subscriptions unreadable: {exc}"[:300])
        sub = max(subs, key=lambda s: str(s.get("created_at") or ""), default=None)
        plan = (((tenant or {}).get("config") or {}).get("plan")) or {}
        ok, why = release_eligible(sub, plan, now)
        if tenant is None or not number or tenant.get("twilio_number") != number or not ok:
            why = "tenant not found" if tenant is None else "number changed" if tenant.get("twilio_number") != number else why
            self._update_release(row, {"status": "canceled", "canceled_at": now.isoformat(), "cancel_reason": why[:200],
                                       "updated_at": now.isoformat()})
            log.info("number release for %s canceled: %s", (tenant or {}).get("slug"), why)
            return "canceled"
        release_at = _iso(row.get("release_at")) or now
        if not row.get("warned_at") and not row.get("force"):
            sent = self._warn_owner(tenant, row, release_at if release_at > now + timedelta(days=WARN_DAYS) - timedelta(hours=1)
                                    else now + timedelta(days=WARN_DAYS))
            patch: dict[str, Any] = {"warned_at": now.isoformat(), "updated_at": now.isoformat(),
                                     "result": {**(row.get("result") or {}), "warning_sent": bool(sent)}}
            if release_at < now + timedelta(days=WARN_DAYS) - timedelta(hours=1):  # the customer always gets 7 days
                patch["release_at"] = (now + timedelta(days=WARN_DAYS)).isoformat()
            self._update_release(row, patch)
            if not sent:  # no address at all (alerts + account) / e-mail error: Meir tells the customer himself
                self._alert("number_release_warn_failed", tenant, {"id": row.get("id"), "attempts": 0},
                            f"The release warning was not sent to the client (no alert address and no account email, or an email error). Number {number} will be released on "
                            f"{str(row.get('release_at'))[:10]}. Contact the client, or 'Postpone' in the admin.", now)
            return "warned"
        if release_at > now:
            return "warned"  # warned already, not due yet (picked because warn_at passed)
        if not release_live(self.env):
            self._update_release(row, {"status": "held", "dry_run": True, "updated_at": now.isoformat(),
                                       "result": {**(row.get("result") or {}), "would_release": number, "dry_run": True}})
            self._alert("number_release_dry_run", tenant, {"id": row.get("id"), "attempts": 0},
                        f"Number release in test mode (TWILIO_RELEASE_LIVE is off), the number was not released. The number that would have been released: {number}. "
                        f"The service ended on {str(row.get('service_ended_at') or '')[:10]} ({why}). "
                        "To turn it on: TWILIO_RELEASE_LIVE=1 in Railway, then 'Release now' in the admin, or 'Postpone' to keep the number.", now)
            return "held"
        try:
            existed = self.numbers().release(number)
        except Exception as exc:  # noqa: BLE001 - recorded and retried, never raised into the cron
            return self._release_retry(row, tenant, now, f"{type(exc).__name__}: {exc}"[:400])
        self.store.update("tenants", tenant["id"], {"twilio_number": None})
        self._update_release(row, {"status": "released", "released_at": now.isoformat(), "dry_run": False, "last_error": None,
                                   "updated_at": now.isoformat(),
                                   "result": {**(row.get("result") or {}), "released": number, "was_on_account": existed}})
        self._alert("number_released", tenant, {"id": row.get("id"), "attempts": 0},
                    f"Number {number} was released in Twilio (the service ended on {str(row.get('service_ended_at') or '')[:10]}).", now)
        return "released"

    def _release_retry(self, row: dict[str, Any], tenant: dict[str, Any] | None, now: datetime, err: str) -> str:
        attempts = int(row.get("attempts") or 0) + 1
        log.warning("number release for %s failed: %s", (tenant or {}).get("slug"), err)
        if attempts < MAX_ATTEMPTS:
            nxt = now + timedelta(minutes=BACKOFF_MIN[min(attempts, len(BACKOFF_MIN)) - 1])
            self._update_release(row, {"attempts": attempts, "last_error": err, "next_attempt_at": nxt.isoformat(),
                                       "updated_at": now.isoformat()})
            return "retry"
        self._update_release(row, {"status": "failed", "attempts": attempts, "last_error": err, "updated_at": now.isoformat()})
        self._alert("number_release_failed", tenant, {"id": row.get("id"), "attempts": attempts},
                    f"Release of number {row.get('number')} failed {attempts} times. Error: {err}", now)
        return "failed"

    def warning_recipients(self, tenant: dict[str, Any], row: dict[str, Any]) -> list[str]:
        """The business's alert addresses (notify.email) + the account e-mail, deduplicated (case-insensitive, first spelling
        kept). The account lookup failing never blocks the warning to the alert addresses."""
        out: list[str] = []
        acct = None
        try:
            acct = self.account_email(row.get("client_id") or tenant.get("client_id"))
        except Exception:  # noqa: BLE001 - a lookup error: warn the alert addresses (or tell Meir when there are none)
            log.warning("account e-mail lookup failed for %s", tenant.get("slug"))
        for addr in [*(((tenant.get("config") or {}).get("notify") or {}).get("email") or []), acct]:
            a = str(addr or "").strip()
            if "@" in a and a.lower() not in {x.lower() for x in out}:
                out.append(a)
        return out

    def _warn_owner(self, tenant: dict[str, Any], row: dict[str, Any], release_at: datetime) -> bool:
        from .notify import templates as T
        cfg = tenant.get("config") or {}
        subject, text, html = T.number_release_warning(str((cfg.get("business") or {}).get("name") or ""),
                                                       str(row.get("number") or ""), release_at)
        to = self.warning_recipients(tenant, row)
        if not to:
            return False
        try:
            return bool(self.owner_email(tenant, subject, text, html, f"number_release_warning:{row.get('id')}:{row.get('number')}", to))
        except Exception:  # noqa: BLE001 - the warning is recorded as not sent; Meir sees it in the admin
            log.exception("number release warning e-mail failed for %s", tenant.get("slug"))
            return False

    def _update_release(self, row: dict[str, Any], patch: dict[str, Any]) -> None:
        row.update(patch)
        try:
            self.store.update("number_releases", row["id"], patch)
        except StoreError:
            log.exception("could not update number release %s", row.get("id"))

    # --- helpers -----------------------------------------------------------------------------------------
    @staticmethod
    def _search_near(tw: "TwilioNumbers", main: str | None) -> list[str]:
        """Numbers near the business line. Twilio answers 400 ("Geodata not available") for some numbers; that must
        not fail the job, the caller falls back to any US local number."""
        if not main:
            return []
        try:
            return tw.search(near=main)
        except RuntimeError:
            return []

    def numbers(self) -> TwilioNumbers:
        if self._numbers is None:
            self._numbers = TwilioNumbers(self.env.get("TWILIO_ACCOUNT_SID", "") or getattr(self.settings, "twilio_account_sid", ""),
                                          getattr(self.settings, "twilio_auth_token", "") or self.env.get("TWILIO_AUTH_TOKEN", ""))
        return self._numbers

    def _update(self, job: dict[str, Any], patch: dict[str, Any]) -> None:
        job.update(patch)
        try:
            self.store.update("provisioning_jobs", job["id"], patch)
        except StoreError:
            log.exception("could not update provisioning job %s", job.get("id"))

    @staticmethod
    def _what(job: dict[str, Any]) -> str:
        return {"number": "Phone number purchase", "golive_sim": "Go-live check"}.get(job.get("kind"), str(job.get("kind")))

    def _alert(self, kind: str, tenant: dict[str, Any] | None, job: dict[str, Any], summary: str, now: datetime) -> None:
        name = str((((tenant or {}).get("config") or {}).get("business") or {}).get("name") or "Client")
        try:
            self.admin_alert(kind, name, str((tenant or {}).get("slug") or "?"), summary,
                             f"{job.get('id')}:{kind}:{job.get('attempts')}")
        except Exception:  # noqa: BLE001
            log.exception("provisioning admin alert failed")


def _transcript_text(ai: dict[str, Any]) -> str:
    lines = []
    for t in ai.get("transcript") or []:
        lines.append(f"{'Caller' if t.get('who') == 'customer' else 'Agent'}: {t.get('text', '')}")
        if t.get("model_text"):  # the guard replaced what the model wrote: show what it tried to say
            lines.append(f"   (the model wrote: {t['model_text']}; fixed by the guard: {', '.join(t.get('guard') or [])})")
    return ("\n\nCall transcript:\n" + "\n".join(lines)) if lines else ""


def owner_email_via(notifier: Any) -> Callable[[dict[str, Any], str, str, str, str, list[str]], bool]:
    """English e-mail through the B6 notifier, once per key, to `to` (the release warning: alert addresses + account e-mail;
    None = the tenant's alert addresses, notify.email)."""
    from .tenants import load_record

    def send(tenant_row: dict[str, Any], subject: str, text: str, html: str, key: str, to: list[str] | None = None) -> bool:
        res = notifier._owner_email(load_record(tenant_row), "number_release", subject, text, html, key, to=to)
        return any(r.get("status") in ("sent", "duplicate") for r in res)
    return send


def admin_alert_via(notifier: Any, now_fn: Callable[[], datetime]) -> Callable[[str, str, str, str, str], None]:
    """English e-mail to Meir through the B6 notifier (urgent: sent at any hour, once per key)."""
    from .notify import templates as T

    def send(kind: str, business: str, slug: str, summary: str, key: str) -> None:
        subject, text, html = T.admin_alert(kind, business, slug, summary)
        notifier._admin_send(kind, subject, text, html, now_fn(), key=key, urgent=True)
    return send
