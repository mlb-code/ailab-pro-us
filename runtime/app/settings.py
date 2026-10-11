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


@dataclass(frozen=True)
class Settings:
    mode: str = "prod"
    store_backend: str = "json"
    data_dir: Path = field(default_factory=lambda: RUNTIME_DIR / "data")
    supabase_url: str = ""
    supabase_service_key: str = field(default="", repr=False)
    twilio_auth_token: str = field(default="", repr=False)
    public_base_url: str = ""
    cred_key: str = field(default="", repr=False)
    brain_mode: str = "live"
    model: str = ""
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
    # Relay socket closed without an `end` from us: wait this long for /voice/relay-end (-> continue with
    # <Gather>) or the call status callback (-> finalize) before closing the call ourselves.
    voice_relay_grace_s: float = 20.0
    twilio_account_sid: str = ""
    jobs_token: str = field(default="", repr=False)  # accepted by /jobs/tick as RUNTIME_ADMIN_TOKEN alias
    jobs_loop_s: float = 0.0  # optional; the cron is POST /jobs/tick. > 0: also run SMS jobs in-process

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
            "twilio_auth_configured": bool(self.twilio_auth_token),
            "cred_key_configured": bool(self.cred_key),
            "public_base_url": self.public_base_url or None,
            "voice_mode": self.voice_mode,
            "twilio_rest_configured": bool(self.twilio_account_sid),
            "jobs_token_configured": bool(self.jobs_token),
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
        cred_key=env.get("CRED_KEY") or (SIM_CRED_KEY if sim else ""),
        brain_mode=brain_mode,
        model=env.get("CLAUDE_MODEL") or _brand_model(),
        brand_name=str(brand().get("name") or "Receptionist"),
        global_daily_budget_usd=float(env.get("GLOBAL_DAILY_BUDGET_USD", "25")),
        voice_mode=env.get("VOICE_MODE", "stream").strip().lower(),
        voice_silence_s=float(env.get("VOICE_SILENCE_SECONDS", "7")),
        voice_tts_wps=float(env.get("VOICE_TTS_WPS", "2.5")),
        voice_relay_grace_s=float(env.get("VOICE_RELAY_GRACE_SECONDS", "20")),
        twilio_account_sid=env.get("TWILIO_ACCOUNT_SID", ""),
        jobs_token=env.get("JOBS_TOKEN", ""),
        jobs_loop_s=float(env.get("JOBS_LOOP_SECONDS", "0")),
    )
    if env.get("REPLAY_DIR"):
        kwargs["replay_dir"] = Path(env["REPLAY_DIR"])
    return Settings(**kwargs).validate()
