"""Runtime settings, read from environment variables only.

Modes
- RUNTIME_MODE=prod (default): every secret must come from the environment (Railway).
  A missing Twilio auth token makes every Twilio webhook fail closed (503).
- RUNTIME_MODE=sim: used by `python -m sim`. Uses fixed, non-secret development values
  for the Twilio auth token and the credential key so the simulator needs no accounts.

The Anthropic key is never read here. `app.llm` reads it lazily, only in live/record mode.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

RUNTIME_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = RUNTIME_DIR.parent

# Non-secret values for the simulator. They only ever authenticate the local fake Twilio.
SIM_TWILIO_AUTH_TOKEN = "sim-auth-token-not-a-secret"
SIM_CRED_KEY = "c2ltLWNyZWQta2V5LW5vdC1hLXNlY3JldC0zMmJ5dGU="  # base64 of 32 ASCII bytes

BRAIN_MODES = ("mock", "replay", "record", "live")
VOICE_MODES = ("stream", "gather")
STORE_BACKENDS = ("json", "supabase")


class SettingsError(ValueError):
    pass


def brand() -> dict:
    """brand.json: the synced copy next to the app first (tools/sync_config.py), then config/brand.json."""
    for path in (Path(__file__).resolve().parent / "brand.json", REPO_DIR / "config" / "brand.json"):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
    return {}


def _brand_model() -> str:
    model = (brand().get("claude") or {}).get("model")
    if not isinstance(model, str) or not model:
        raise SettingsError("claude.model missing: run tools/sync_config.py or set CLAUDE_MODEL")
    return model


def _brand_claude() -> dict:
    claude = brand().get("claude") or {}
    return claude if isinstance(claude, dict) else {}


@dataclass(frozen=True)
class Settings:
    mode: str = "prod"
    store_backend: str = "json"
    data_dir: Path = field(default_factory=lambda: RUNTIME_DIR / "data")
    supabase_url: str = ""
    supabase_service_key: str = field(default="", repr=False)
    twilio_auth_token: str = field(default="", repr=False)
    public_base_url: str = ""
    # Calendar OAuth (connect link + redirect URI) on our own domain, e.g. https://rt.ailabpro.co. Google's verification
    # needs every redirect URI on a verified, authorized domain; *.up.railway.app is a public suffix and can never be one.
    # Empty = public_base_url (unchanged behaviour). Twilio webhooks keep using public_base_url.
    oauth_base_url: str = ""
    cred_key: str = field(default="", repr=False)
    brain_mode: str = "live"
    model: str = ""            # claude.model: the general default (health ping fallback, cost tests)
    # claude.voice_model: every realtime turn (voice, SMS, web chat demo). Quotes use claude.quote_model (Edge).
    voice_model: str = ""
    voice_max_tokens: int = 400
    voice_thinking: str = "disabled"   # "disabled" | "adaptive" (see docs/reports/VOICE-LATENCY.md)
    prompt_cache: bool = True
    voice_fillers: bool = True         # fixed "One moment." style line when a turn starts with a tool call
    replay_dir: Path = field(default_factory=lambda: RUNTIME_DIR / "sim" / "replays")
    secrets_file: Path = field(default_factory=lambda: REPO_DIR / ".secrets.env")
    twilio_protected_prefixes: tuple[str, ...] = ("/voice/", "/sms/")
    global_daily_budget_usd: float = 25.0
    brand_name: str = "Receptionist"
    # Voice: "stream" = Twilio ConversationRelay over a WebSocket (production default, < 1 s target);
    # "gather" = turn-based <Gather>/<Say> (simulator fallback, and automatic fallback when a relay
    # session fails). Silence timeout = voice_silence_s + estimated TTS time (words / voice_tts_wps).
    voice_mode: str = "stream"
    voice_silence_s: float = 7.0
    voice_tts_wps: float = 2.5
    # Hold a caller prompt that arrives while the greeting (with the call notice) is still playing until its
    # estimated end, so nothing the caller says reaches Claude before the notice is complete (SA §8).
    # The simulator's VOICE_TTS_WPS=1000 makes the hold ~0 there; VOICE_GREETING_HOLD=0 switches it off.
    voice_greeting_hold: bool = True
    # Relay socket closed without an `end` from us: wait this long for /voice/relay-end (-> continue with
    # <Gather>) or the call status callback (-> finalize) before closing the call ourselves.
    voice_relay_grace_s: float = 20.0
    twilio_account_sid: str = ""
    jobs_token: str = field(default="", repr=False)  # accepted by /jobs/tick as RUNTIME_ADMIN_TOKEN alias
    jobs_loop_s: float = 0.0  # optional; the cron is POST /jobs/tick. > 0: also run SMS jobs in-process
    # ADD-REV kill switch (REVIEW_REQUESTS_ENABLED). Off by default: review texts need a 10DLC campaign that
    # covers them and consent collected for them; the tenant's `review_requests.enabled` must be on as well.
    review_requests_enabled: bool = False
    # ADD-DISPATCH staff alerts by SMS: global switch, OFF by default until the A2P 10DLC campaign (and its use-case
    # wording for internal staff alerts) is approved. Off = alerts go by voice call; the tenant flag
    # dispatch.sms_alerts is needed as well.
    dispatch_sms_alerts: bool = False
    # Appointment manager (2026-10-23). OFF by default: texting is not live until A2P 10DLC is approved.
    # SMS_BOOKING_REPLIES=1: confirmation/reminder texts ask "Reply C/R/X", the replies confirm / change / cancel, and a
    # booking moved by phone gets a new confirmation + reminder (still only with the caller's texting yes).
    sms_booking_replies: bool = False
    # WEEKLY_REPORT=1: the weekly "Results" e-mail to owners (Mondays 09:00 tenant time; client e-mails still need
    # CLIENT_EMAILS_ENABLED). Off until approved.
    weekly_report: bool = False

    @property
    def is_sim(self) -> bool:
        return self.mode == "sim"

    def validate(self) -> "Settings":
        if self.mode not in ("prod", "sim"):
            raise SettingsError(f"RUNTIME_MODE must be 'prod' or 'sim', got {self.mode!r}")
        if self.store_backend not in STORE_BACKENDS:
            raise SettingsError(f"STORE_BACKEND must be one of {STORE_BACKENDS}, got {self.store_backend!r}")
        if self.brain_mode not in BRAIN_MODES:
            raise SettingsError(f"BRAIN_MODE must be one of {BRAIN_MODES}, got {self.brain_mode!r}")
        if self.voice_mode not in VOICE_MODES:
            raise SettingsError(f"VOICE_MODE must be one of {VOICE_MODES}, got {self.voice_mode!r}")
        if self.voice_thinking not in ("disabled", "adaptive"):
            raise SettingsError(f"CLAUDE_VOICE_THINKING must be 'disabled' or 'adaptive', got {self.voice_thinking!r}")
        if self.store_backend == "supabase" and not (self.supabase_url and self.supabase_service_key):
            raise SettingsError("STORE_BACKEND=supabase needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
        return self

    def public(self) -> dict:
        """Safe view for /health: no secret values, only whether they are present."""
        return {
            "mode": self.mode,
            "store": self.store_backend,
            "brain_mode": self.brain_mode,
            "model": self.model,
            "voice_model": self.voice_model,
            "twilio_auth_configured": bool(self.twilio_auth_token),
            "cred_key_configured": bool(self.cred_key),
            "public_base_url": self.public_base_url or None,
            "oauth_base_url": self.oauth_base_url or None,
            "voice_mode": self.voice_mode,
            "twilio_rest_configured": bool(self.twilio_account_sid),
            "jobs_token_configured": bool(self.jobs_token),
            "review_requests_enabled": self.review_requests_enabled,
        }


def load(env: dict[str, str] | None = None) -> Settings:
    env = dict(os.environ if env is None else env)
    mode = env.get("RUNTIME_MODE", "prod").strip().lower()
    sim = mode == "sim"
    brain_mode = (env.get("BRAIN_MODE") or env.get("CLAUDE_MODE") or ("mock" if sim else "live")).strip().lower()
    data_dir = Path(env["DATA_DIR"]) if env.get("DATA_DIR") else RUNTIME_DIR / "data"
    kwargs = dict(
        mode=mode,
        store_backend=env.get("STORE_BACKEND", "json").strip().lower(),
        data_dir=data_dir,
        supabase_url=env.get("SUPABASE_URL", "").rstrip("/"),
        supabase_service_key=env.get("SUPABASE_SERVICE_ROLE_KEY", ""),
        twilio_auth_token=env.get("TWILIO_AUTH_TOKEN") or (SIM_TWILIO_AUTH_TOKEN if sim else ""),
        public_base_url=env.get("PUBLIC_BASE_URL", "").rstrip("/"),
        oauth_base_url=env.get("OAUTH_BASE_URL", "").rstrip("/"),
        cred_key=env.get("CRED_KEY") or (SIM_CRED_KEY if sim else ""),
        brain_mode=brain_mode,
        model=env.get("CLAUDE_MODEL") or _brand_model(),
        voice_model=(env.get("CLAUDE_VOICE_MODEL") or _brand_claude().get("voice_model")
                     or env.get("CLAUDE_MODEL") or _brand_model()),
        voice_max_tokens=int(env.get("CLAUDE_VOICE_MAX_TOKENS") or (_brand_claude().get("voice") or {}).get("max_tokens") or 400),
        voice_thinking=(env.get("CLAUDE_VOICE_THINKING") or (_brand_claude().get("voice") or {}).get("thinking")
                        or "disabled").strip().lower(),
        prompt_cache=(env.get("CLAUDE_PROMPT_CACHE") or str((_brand_claude().get("voice") or {}).get("prompt_cache", True))
                      ).strip().lower() not in ("0", "false", "no", "off"),
        voice_fillers=(env.get("CLAUDE_VOICE_FILLERS") or str((_brand_claude().get("voice") or {}).get("tool_fillers", True))
                       ).strip().lower() not in ("0", "false", "no", "off"),
        brand_name=str(brand().get("name") or "Receptionist"),
        global_daily_budget_usd=float(env.get("GLOBAL_DAILY_BUDGET_USD", "25")),
        voice_mode=env.get("VOICE_MODE", "stream").strip().lower(),
        voice_silence_s=float(env.get("VOICE_SILENCE_SECONDS", "7")),
        voice_tts_wps=float(env.get("VOICE_TTS_WPS", "2.5")),
        voice_greeting_hold=(env.get("VOICE_GREETING_HOLD") or "1").strip().lower()
        not in ("0", "false", "no", "off"),
        voice_relay_grace_s=float(env.get("VOICE_RELAY_GRACE_SECONDS", "20")),
        twilio_account_sid=env.get("TWILIO_ACCOUNT_SID", ""),
        jobs_token=env.get("JOBS_TOKEN", ""),
        jobs_loop_s=float(env.get("JOBS_LOOP_SECONDS", "0")),
        review_requests_enabled=(env.get("REVIEW_REQUESTS_ENABLED") or "0").strip().lower()
        in ("1", "true", "yes", "on"),
        dispatch_sms_alerts=(env.get("DISPATCH_SMS_ALERTS") or "0").strip().lower() in ("1", "true", "yes", "on"),
        sms_booking_replies=(env.get("SMS_BOOKING_REPLIES") or "0").strip().lower() in ("1", "true", "yes", "on"),
        weekly_report=(env.get("WEEKLY_REPORT") or "0").strip().lower() in ("1", "true", "yes", "on"),
    )
    if env.get("REPLAY_DIR"):
        kwargs["replay_dir"] = Path(env["REPLAY_DIR"])
    return Settings(**kwargs).validate()
