"""Hard rules for the receptionist (SPEC 6.5), enforced in code, not only in the prompt.

Everything here is pure: inputs in, decisions out. Nothing is sent, stored or logged here.
The conversation engine (`app.conversation`) calls these before and after Claude.

Rules covered (SPEC 6.5 numbering):
 1  no advice beyond "call 911" / "a technician will check it"   -> prompt + check_reply
 2  prices only when pricing.mode == "listed", only listed amounts -> check_reply
 3  business hours / after_hours.mode                            -> is_open, after_hours_policy
 4  customer text is data, never instructions                    -> as_data
 5  per-number rate limits + mute after second episode           -> rate_reason, register_over_limit
 6  budgets: $/day per tenant, $/day global                       -> budget_reason
 7  SMS > 600 chars / MMS / empty -> fixed reply, no Claude       -> inbound_fixed_reply
 8  spam: blocklist, landline, robocall silence                  -> is_blocked, silence_policy
 9  English only unless ADD-ES                                    -> language_fixed_reply
 10 never claims to be human                                     -> is_robot_question, check_reply
Plus emergency detection, SMS compliance keywords (STOP/START/HELP) and the consent rules of SA §8
(docs/reports/legal-residual/02-tcpa-recording.md): the call disclosure, revocation "by any reasonable
means" (47 C.F.R. §64.1200(a)(10)), the texting-consent question at booking, objections to recording,
and the texting window checked in the business's AND the caller's time zone.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from .area_codes import timezone_for
from .tenants import DAYS, TenantConfig, sms_business_name

# ---- fixed texts (client-facing, US English) -----------------------------------------
LONG_SMS_TEXT = "Thanks for the details! Could you send a shorter message about what you need help with?"
MEDIA_TEXT = "Sorry, I can only read text messages. Could you describe what you need in words?"
LIMIT_TEXT = "Thanks! Someone from our team will get back to you shortly."
BUDGET_TEXT = "Thanks for reaching out. I've passed your message to our team and someone will call you back soon."
PRICE_TEXT = "Our team will give you an exact price on site."
NO_DISCOUNT_TEXT = "I'm not able to offer discounts, but our team will give you an exact price on site."
LIFE_SAFETY_TEXT = "If anyone is in danger, please hang up and call 911 now."
LIFE_SAFETY_ES = " Si hay peligro, cuelgue y llame al 911 ahora."
SAFETY_QUESTION = " I've alerted our team that this is urgent. Is anyone in danger right now?"
CONFIRMED_DANGER_TEXT = "Please hang up and call 911 now. Our team has been alerted. Goodbye."
UNBOOKED_TEXT = "I haven't booked a visit yet. Would you like me to check the available times?"
UNBACKED_ACTION_TEXT = "I can't make that change myself, but I've noted it for our team and they'll follow up."
SPANISH_TEXT = ("Sorry, I can only help in English right now. "
                "I've asked our team to call you back.")
SMS_MAX_CHARS = 600
SMS_REPLY_MAX = 320
VOICE_MAX_SENTENCES = 2

# Call disclosure (SA §8 item 2): played first on every AI-answered call, never removable. The version id goes
# into the consent log with every text that relies on it.
DISCLOSURE = "This call may be recorded and transcribed by us and our service providers, and we may text you about it."
DISCLOSURE_VERSION = "2026-10-12"
# Texting consent at booking (SA §8 item 3b). Voice asks about the confirmation + one reminder; by text the reply
# itself is the confirmation, so only the reminder is asked about.
CONSENT_PROMPT_VERSION = "2026-10-12"
SMS_CONSENT_Q_VOICE = "Can I text your confirmation and a reminder to the number you're calling from?"
SMS_CONSENT_Q_SMS = "Can I text you a reminder before the visit? Reply YES or NO."
CONSENT_YES_VOICE = "Great, I'll text your confirmation to this number. Anything else I can help with?"


CONSENT_BYE = "Thanks for calling. Goodbye."


def consent_yes_voice(bye: bool = False) -> str:
    return "Great, I'll text your confirmation to this number. " + (CONSENT_BYE if bye else "Anything else I can help with?")


def consent_no_voice(label: str | None, bye: bool = False) -> str:
    """"No" to texts: the booking stands, so the details are said out loud instead."""
    head = f"No problem, I won't text you. Your visit is {label}." if label else "No problem, I won't text you."
    return f"{head} {CONSENT_BYE if bye else 'Anything else I can help with?'}"
CONSENT_YES_SMS = "Great, we'll text you a reminder before the visit. Reply STOP to opt out."
CONSENT_NO_SMS = "No problem, no reminder texts. Reply here if you need anything."
VOICE_NO_TEXT_TEXT = "Got it, we won't text you. What else can I help you with?"
RECORDING_OBJECTION_TEXT = ("No problem. I'll stop here and won't keep a transcript of this call. "
                            "The team will call you back at the number you're calling from. Goodbye.")

STOP_WORDS = {"STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPTOUT"}
START_WORDS = {"START", "UNSTOP", "YES"}
HELP_WORDS = {"HELP", "INFO"}


def robot_answer(business: str) -> str:
    return f"I'm the virtual assistant for {business}. I can get you booked or take a message for the team."


def stop_confirmation(business: str, phone: str = "") -> str:
    """The one confirmation allowed after an opt-out (47 C.F.R. §64.1200(a)(12)): no marketing. "CANCEL" may mean
    "cancel my appointment", so the business phone is named for appointment changes."""
    call = f" To change or cancel an appointment, call {phone}." if phone else ""
    return f"{business}: you're unsubscribed and won't get more texts from us.{call} Reply START to resubscribe."


def start_confirmation(business: str) -> str:
    return f"{business}: you're resubscribed. Reply STOP to opt out."


def help_text(business: str, phone: str) -> str:
    return f"{business} virtual assistant. For help call {phone}. Reply STOP to opt out."


# ---- 8: blocklist -----------------------------------------------------------------

def is_blocked(number: str, cfg: TenantConfig) -> bool:
    return number in cfg.guard.blocklist


# ---- SMS compliance keywords (handled before anything else) -------------------------

# Revocation "by any reasonable means": a sentence that clearly asks not to be texted, anywhere in a message or
# on a call. Ambiguous cases count as an opt-out (stricter is safer).
NO_TEXTS = re.compile(
    r"\b(stop|quit|don'?t|do not|never|no more)\s+(texting|txting|messaging|smsing)\b|"
    r"\b(stop|quit|don'?t|do not|never)\s+(text|txt|message|sms)\s+(me|us|this number|my (number|phone|cell))\b|"
    r"\b(stop|quit|don'?t|do not|never)\s+send(ing)?\s+(me\s+)?(any\s+)?(more\s+)?(texts|text messages|messages|sms)\b|"
    r"\b(stop|quit)\s+(contacting|bothering)\s+me\b|"
    r"\bdon'?t\s+(want|need)\s+(any\s+)?(more\s+)?(texts|text messages|messages)\b|"
    r"\b(remove|take)\s+me\s+(off|from)\b|\bunsubscribe\b|\bopt(\s|-)?out\b|\brevoke\b|"
    r"\bleave me alone\b|\bwrong number\b|\bno more (texts|messages)\b", re.I)
_STOP_LEAD = re.compile(r"^\W*(stop|stopall|unsubscribe|cancel|end|quit|revoke)\b", re.I)


def wants_no_texts(text: str) -> bool:
    """A sentence (SMS or speech) that asks us not to text this number (English or Spanish)."""
    return bool(NO_TEXTS.search(text or "")) or bool(NO_TEXTS_ES.search(text or ""))


def sms_keyword(text: str) -> str | None:
    """'stop' | 'start' | 'help' | None. START/HELP only as the whole message; an opt-out also counts when it is a
    short message that starts with a stop word ("Stop please") or a sentence that asks not to be texted.
    Spanish keywords (PARAR / INICIAR / AYUDA, ...) count the same way (ADD-ES, and carriers honour them too)."""
    word = re.sub(r"[^A-Za-zÁÉÍÓÚÑáéíóúñ]", "", (text or "").strip()).upper()
    if word in STOP_WORDS or word in STOP_WORDS_ES:
        return "stop"
    if word in START_WORDS or word in START_WORDS_ES:
        return "start"
    if word in HELP_WORDS or word in HELP_WORDS_ES:
        return "help"
    if wants_no_texts(text) or (_STOP_LEAD.match(text or "") and len((text or "").split()) <= 4):
        return "stop"
    return None


# ---- recording objection (SA §8 "AI and recording notice") ---------------------------------

RECORDING_OBJECTION = re.compile(
    r"\b(don'?t|do not|stop|quit|no)\s+(record|recording|transcrib|transcript)\w*|"
    r"\b(i\s+)?(don'?t|do not|won'?t)\s+(consent|agree)\b|\bi\s+(object|refuse)\b|"
    r"\b(don'?t|do not)\s+want\s+(this|it|to be|my call|the call)?\s*(being\s+|to be\s+)?(recorded|transcribed)\b|"
    r"\bnot\s+(ok(ay)?|fine|comfortable)\s+with\s+(being\s+|this being\s+|the call being\s+)?(recorded|transcribed|recording)\b",
    re.I)


def objects_to_recording(text: str) -> bool:
    return bool(RECORDING_OBJECTION.search(text or ""))


# ---- texting consent answer -----------------------------------------------------------------

_YES = re.compile(r"^\W*(yes|yeah|yep|yup|sure|ok(ay)?|please|please do|go ahead|of course|absolutely|definitely|"
                  r"that'?s fine|that works|sounds good|fine|correct|si|sí)\b|\b(you can|text me|send it|that'?s fine)\b", re.I)
_NO = re.compile(r"^\W*(no|nope|nah|not really|i'?d rather not|rather not|don'?t|do not)\b|"
                 r"\bplease\s+(don'?t|do not)\b|\b(don'?t|do not)\s+(text|bother)\b|\bno (texts|text|need)\b", re.I)


def consent_answer(text: str) -> str | None:
    """'yes' | 'no' | None for the answer to the texting question. "No" wins over "yes" ("yes, but don't text")."""
    t = text or ""
    if wants_no_texts(t) or _NO.search(t):
        return "no"
    if _YES.search(t):
        return "yes"
    return None


# ---- 7: inbound content that never reaches Claude --------------------------------------

def inbound_fixed_reply(text: str, num_media: int = 0) -> tuple[str, str]:
    """(fixed reply, reason) for SMS that must not reach Claude, or ("", "")."""
    body = (text or "").strip()
    if num_media > 0:
        return MEDIA_TEXT, "mms"
    if not body:
        return MEDIA_TEXT, "empty"
    if len(body) > SMS_MAX_CHARS:
        return LONG_SMS_TEXT, "too_long"
    return "", ""


# ---- 8: voice silence / robocalls ------------------------------------------------------

def silence_policy(silent_in_a_row: int, ever_spoke: bool) -> str:
    """'continue' | 'reprompt' | 'end_spam' | 'end_quiet' for an empty speech turn."""
    if silent_in_a_row < 1:
        return "continue"
    if silent_in_a_row < 2:
        return "reprompt"
    return "end_quiet" if ever_spoke else "end_spam"


# ---- emergencies ----------------------------------------------------------------------

LIFE_SAFETY = re.compile(
    r"\b(gas (smell|leak)|smell(s|ing)? (of |like )?gas|carbon monoxide|co (alarm|detector) (is )?(going off|sounding)|"
    r"(house|home|kitchen|unit|furnace|heater|wall|outlet|attic|garage|panel|basement|roof|it|something)('s| is)? "
    r"(on fire|catching fire|caught fire|burning)|there'?s (a )?fire|fire in the|flames|"
    r"smoke (is )?(coming|pouring|everywhere|from)|(smells?|smelling) (like )?(smoke|burning)|burning smell|"
    r"sparks? (are )?(coming|flying|from)|sparking|electrocut\w*|"
    r"huele a gas|olor a gas|fuga de gas|fuego|incendio|humo|chispas)\b", re.I)
# A retraction only counts when it is not negated ("not kidding", "no joke") and nothing says
# "seriously": when in doubt, it stays an emergency.
NOT_REAL = re.compile(r"\b(just kidding|jk|joking|kidding|joke|prank(ing)?)\b", re.I)
NEGATED_JOKE = re.compile(r"\b(not|no|isn'?t|ain'?t|never|nobody'?s|no one'?s)\s+(just\s+)?(a\s+)?(kidding|joking|joke|jk|prank(ing)?)\b", re.I)
SERIOUS = re.compile(r"\b(seriously|for real|i mean it|this is real|it'?s real|real emergency)\b", re.I)
# Smoke is an emergency by default; only these explicit cases are not.
SMOKE = re.compile(r"\b(smoke|smoky|smokey|smoking (from|out of|unit|outlet|furnace|heater|wires?|panel))\b", re.I)
SMOKE_NOT_EMERGENCY = re.compile(
    r"\b(detector|alarm)s?\b.{0,40}\b(chirp\w*|beep\w*|batter(y|ies))\b|"
    r"\b(chirp\w*|beep\w*|batter(y|ies))\b.{0,40}\b(detector|alarm)s?\b|"
    r"\bsmoke (test(s|ing)?|shop|shops|break)\b", re.I)
SPANISH_EMERGENCY = re.compile(r"\b(huele a gas|olor a gas|fuga de gas|fuego|incendio|humo|chispas)\b", re.I)
URGENT = re.compile(r"\b(flood(ing|ed)?|burst pipe|water everywhere|inundaci[oó]n)\b", re.I)
NO_HEAT = re.compile(r"\b(no heat|heat (is )?(out|not working)|heater (is )?(out|broken|not working)|furnace (is )?(out|dead|broken))\b", re.I)
VULNERABLE = re.compile(r"\b(elderly|baby|infant|newborn|grandm\w+|grandp\w+|oxygen|disabled|sick)\b", re.I)
DANGER_YES = re.compile(r"^\s*(yes|yeah|yep|si|sí)\b|\b(not safe|in danger|real emergency|it'?s real|hurry|getting worse|someone'?s hurt)\b", re.I)


def detect_emergency(text: str, cfg: TenantConfig) -> str | None:
    """'life_safety' | 'urgent' | None. Jokes and detector chirps/batteries do not count."""
    t = text or ""
    if NOT_REAL.search(NEGATED_JOKE.sub(" ", t)) and not SERIOUS.search(t):
        return None
    if LIFE_SAFETY.search(t):
        return "life_safety"
    if SMOKE.search(t) and not SMOKE_NOT_EMERGENCY.search(t):
        return "life_safety"
    if URGENT.search(t) or (NO_HEAT.search(t) and VULNERABLE.search(t)):
        return "urgent"
    low = t.lower()
    if any(k.lower() in low for k in cfg.emergency.keywords if k.strip()):
        return "urgent"
    return None


def life_safety_reply(text: str) -> str:
    """911 first, always; Spanish line added when the caller used Spanish; then ask about danger."""
    return LIFE_SAFETY_TEXT + (LIFE_SAFETY_ES if SPANISH_EMERGENCY.search(text or "") else "") + SAFETY_QUESTION


def confirms_danger(text: str) -> bool:
    """Answer to "Is anyone in danger right now?"."""
    return bool(DANGER_YES.search(text or ""))


# ---- 10: honesty about being an AI ------------------------------------------------------

ROBOT_Q = re.compile(
    r"\b(are|r) (you|u) (a |an )?(real |actual )?(robot|bot|machine|computer|ai|human|person|real person|recording)\b"
    r"|\bis this (a |an )?(robot|bot|recording|machine|ai|real person)\b"
    r"|\bam i (talking|speaking) (to|with) (a |an )?(robot|bot|machine|computer|ai|human|real person|person)\b", re.I)
CLAIMS_HUMAN = re.compile(r"\b(i am|i'm|im) (a )?(real )?(human|person|real person|not (a |an )?(robot|bot|ai|machine))\b", re.I)


def is_robot_question(text: str) -> bool:
    return bool(ROBOT_Q.search(text or ""))


# ---- 9: language -------------------------------------------------------------------------

SPANISH = re.compile(r"\b(hola|necesito|ayuda|gracias|por favor|aire acondicionado|no funciona|"
                     r"buenos d[ií]as|buenas tardes|buenas noches|buenas|quiero|quisiera|cita|calefacci[oó]n|se descompuso|"
                     r"espa[ñn]ol|habla|hablo|puedo|puede|tengo|tiene|casa|ma[ñn]ana|hoy|problema|llamar|llame|favor|"
                     r"vender|comprar|alquilar|rentar|agente|precio|cu[aá]nto|cuando|d[oó]nde|s[ií]|no s[eé]|est[aá]|"
                     r"caliente|fr[ií]o|agua|fuga|t[eé]cnico|servicio|direcci[oó]n|nombre|tel[eé]fono|mensaje)\b", re.I)
ENGLISH = re.compile(r"\b(the|my|is|and|you|your|can|need|please|what|when|where|how|yes|thanks|hi|hello|broken|"
                     r"working|appointment|schedule|house|home|sell|buy|rent)\b", re.I)
SPANISH_LANG = "es-US"
ENGLISH_LANG = "en-US"


def detect_language(text: str) -> str | None:
    """'es' when the customer clearly uses Spanish, 'en' when clearly English, None when unsure (keep the current one).
    Mixed messages count as whichever language has more markers; ties keep the current language."""
    t = text or ""
    es, en = len(SPANISH.findall(t)), len(ENGLISH.findall(t))
    if es and es > en:
        return "es"
    if en and en > es:
        return "en"
    return None


def language_fixed_reply(text: str, cfg: TenantConfig) -> str:
    """Fixed reply when the customer writes Spanish and ADD-ES is not active, else ""."""
    if "es" in cfg.voice.languages:
        return ""
    return SPANISH_TEXT if len(SPANISH.findall(text or "")) >= 1 and not re.search(r"\b(the|my|is|and|you)\b", text or "", re.I) else ""


# ---- ADD-ES: Spanish line (voice + SMS). English stays the default; these apply once a caller uses Spanish -----
DISCLOSURE_ES = ("Esta llamada puede ser grabada y transcrita por nosotros y nuestros proveedores de servicio, y podemos "
                 "enviarle mensajes de texto.")
SPANISH_INVITE = "Para español, hable en español."
STOP_WORDS_ES = {"PARAR", "ALTO", "CANCELAR", "DETENER", "BAJA", "NOMAS", "NOMÁS"}
START_WORDS_ES = {"INICIAR", "EMPEZAR", "COMENZAR", "SI", "SÍ", "ACTIVAR"}
HELP_WORDS_ES = {"AYUDA", "INFORMACION", "INFORMACIÓN"}
NO_TEXTS_ES = re.compile(r"\b(no (me )?(env[ií]e|mande|manden|env[ií]en|escriba|escriban) (m[aá]s )?(mensajes|textos)|"
                         r"no quiero (m[aá]s )?(mensajes|textos)|dejen? de (enviar|mandar|escribir)|d[eé]jenme en paz|n[uú]mero equivocado)\b", re.I)
SMS_CONSENT_Q_VOICE_ES = "¿Puedo enviarle la confirmación y un recordatorio por mensaje de texto a este número?"
SMS_CONSENT_Q_SMS_ES = "¿Le envío un recordatorio por texto antes de la visita? Responda SÍ o NO."
CONSENT_YES_SMS_ES = "Perfecto, le enviaremos un recordatorio antes de la visita. Responda PARAR para no recibir más mensajes."
CONSENT_NO_SMS_ES = "Sin problema, no enviaremos recordatorios. Escríbanos aquí si necesita algo."
CONSENT_BYE_ES = "Gracias por llamar. Hasta luego."
VOICE_NO_TEXT_TEXT_ES = "Entendido, no le enviaremos mensajes. ¿En qué más puedo ayudarle?"
REPROMPT_TEXT_ES = "Perdón, no le escuché. ¿Puede repetirlo?"
_YES_ES = re.compile(r"^\W*(s[ií]|claro|est[aá] bien|de acuerdo|por supuesto|perfecto|ok)\b", re.I)
_NO_ES = re.compile(r"^\W*(no|mejor no|prefiero que no)\b|\bno me (env[ií]e|mande|escriba)\b", re.I)


def keyword_lang(text: str) -> str:
    """'es' when the whole message is a Spanish compliance keyword, else 'en'."""
    word = re.sub(r"[^A-Za-zÁÉÍÓÚÑáéíóúñ]", "", (text or "").strip()).upper()
    return "es" if word in STOP_WORDS_ES | START_WORDS_ES | HELP_WORDS_ES or NO_TEXTS_ES.search(text or "") else "en"


def consent_yes_voice_es(bye: bool = False) -> str:
    return "Perfecto, le enviaré la confirmación a este número. " + (CONSENT_BYE_ES if bye else "¿Algo más en que pueda ayudarle?")


def consent_no_voice_es(label: str | None, bye: bool = False) -> str:
    head = f"Sin problema, no le enviaré mensajes. Su visita es {label}." if label else "Sin problema, no le enviaré mensajes."
    return f"{head} {CONSENT_BYE_ES if bye else '¿Algo más en que pueda ayudarle?'}"


def robot_answer_es(business: str) -> str:
    return f"Soy el asistente virtual de {business}. Puedo agendar su visita o tomar un mensaje para el equipo."


def stop_confirmation_es(business: str, phone: str = "") -> str:
    call = f" Para cambiar o cancelar una cita, llame al {phone}." if phone else ""
    return f"{business}: se ha dado de baja y no recibirá más mensajes nuestros.{call} Responda INICIAR para volver a suscribirse."


def start_confirmation_es(business: str) -> str:
    return f"{business}: se ha vuelto a suscribir. Responda PARAR para darse de baja."


def help_text_es(business: str, phone: str) -> str:
    return f"Asistente virtual de {business}. Para ayuda llame al {phone}. Responda PARAR para darse de baja."


def consent_answer_es(text: str) -> str | None:
    t = text or ""
    if NO_TEXTS_ES.search(t) or _NO_ES.search(t):
        return "no"
    if _YES_ES.search(t):
        return "yes"
    return None


# ---- 3: hours ------------------------------------------------------------------------------

def is_open(cfg: TenantConfig, now: datetime) -> bool:
    local = now.astimezone(ZoneInfo(cfg.business.timezone))
    span = getattr(cfg.hours, DAYS[local.weekday()])
    if span is None:
        return False
    hhmm = local.strftime("%H:%M")
    return span[0] <= hhmm < span[1]


def after_hours_policy(cfg: TenantConfig, now: datetime) -> str:
    """'open' | 'book_next_day' | 'message_only' | 'emergency_dial'."""
    return "open" if is_open(cfg, now) else cfg.after_hours.mode


def on_call(cfg: TenantConfig, now: datetime) -> bool:
    """Whether a live handoff (dial) may happen now."""
    return cfg.handoff.hours == "always" or is_open(cfg, now)


# Texting windows (SA §8 item 5). "textback": the one missed-call text, sent right after the caller's own call, not
# 21:00-08:00. "scheduled": everything else that is not a direct reply (booking confirmation, reminder):
# 09:00-20:00 Mon-Sat, 12:00-20:00 Sun. Both are checked in the business's and the caller's (area code) zone.
WINDOWS = {"textback": {d: (8, 21) for d in range(7)},
           "scheduled": {**{d: (9, 20) for d in range(6)}, 6: (12, 20)}}


def caller_timezone(number: str) -> str | None:
    return timezone_for(number)


def window_zones(business_tz: str, contact: str = "") -> list[str]:
    zones = [business_tz]
    caller = caller_timezone(contact) if contact else None
    if caller and caller != business_tz:
        zones.append(caller)
    return zones


def in_window(zones: list[str], now: datetime, kind: str = "textback") -> bool:
    for tz in zones:
        local = now.astimezone(ZoneInfo(tz))
        start, end = WINDOWS[kind][local.weekday()]
        if not start <= local.hour < end:
            return False
    return True


def next_window(zones: list[str], t: datetime, kind: str = "textback") -> datetime:
    """`t` if inside the window in every zone, else the first half hour (UTC :00/:30) when it is. Windows are at
    least 8 hours a day in every zone, so a time is always found within two days."""
    if in_window(zones, t, kind):
        return t
    cand = t.replace(minute=0 if t.minute < 30 else 30, second=0, microsecond=0)
    for _ in range(4 * 48):
        cand += timedelta(minutes=30)
        if in_window(zones, cand, kind):
            return cand
    return cand  # pragma: no cover - unreachable for real zones (see the docstring)


def send_window_ok(cfg: TenantConfig, now: datetime, contact: str = "", kind: str = "textback") -> bool:
    return in_window(window_zones(cfg.business.timezone, contact), now, kind)


def quiet_hours(cfg: TenantConfig, now: datetime, contact: str = "", kind: str = "textback") -> bool:
    """Outside the texting window (default: the 21:00-08:00 text-back block, business time zone only)."""
    return not send_window_ok(cfg, now, contact, kind)


# ---- 5: per-number rate limits --------------------------------------------------------------

EPISODE_GAP = timedelta(minutes=10)
MUTE_FOR = timedelta(hours=24)


@dataclass(frozen=True)
class LimitState:
    """Per (tenant, number) limit bookkeeping, owned by the caller."""
    reply_times: tuple[datetime, ...] = ()
    day: str = ""
    episodes: int = 0
    last_over_at: datetime | None = None
    muted_until: datetime | None = None


def rate_reason(state: LimitState, now: datetime, max_10min: int, max_day: int, day: str) -> str:
    if state.muted_until and now < state.muted_until:
        return "muted"
    recent = [t for t in state.reply_times if now - t < timedelta(minutes=10)]
    if len(recent) >= max_10min:
        return "10min"
    today = state.reply_times if state.day == day else ()
    if len([t for t in today if now - t < timedelta(hours=24)]) >= max_day:
        return "day"
    return ""


def record_reply(state: LimitState, now: datetime, day: str) -> LimitState:
    keep = tuple(t for t in state.reply_times if now - t < timedelta(hours=24)) if state.day == day else ()
    return replace(state, reply_times=keep + (now,), day=day)


def register_over_limit(state: LimitState, now: datetime, day: str) -> tuple[str, LimitState]:
    """Decide what to do with a message that arrived while over the limit.

    'first'  - first episode today: one fixed reply + one owner alert.
    'mute'   - second episode today: mute 24 h, one alert, no reply.
    'silent' - more messages inside the same episode (or while muted): no reply, no alert.
    """
    if state.muted_until and now < state.muted_until:
        return "silent", state
    episodes = state.episodes if state.day == day else 0
    new_episode = state.last_over_at is None or now - state.last_over_at > EPISODE_GAP
    if not new_episode:
        return "silent", replace(state, last_over_at=now)
    episodes += 1
    if episodes >= 2:
        return "mute", replace(state, day=day, episodes=episodes, last_over_at=now, muted_until=now + MUTE_FOR)
    return "first", replace(state, day=day, episodes=episodes, last_over_at=now)


# ---- 6: budgets ---------------------------------------------------------------------------

def budget_reason(tenant_spent: float, tenant_cap: float, global_spent: float, global_cap: float) -> str:
    if global_spent >= global_cap:
        return "global"
    if tenant_spent >= tenant_cap:
        return "tenant"
    return ""


# ---- 4: customer text is data ----------------------------------------------------------------

_URL = re.compile(r"(?:https?://|www\.)[^\s,;]+|\b[\w\-]+\.(?:com|net|org|io|co|us|app|info|biz|me)(?:/\S*)?", re.I)
_PHONE = re.compile(r"(?<![\w.])\(?\+?\d[\d\-\s().]{6,}\d(?![\w.])")
_ANGLE = str.maketrans({"<": "‹", ">": "›", "{": "(", "}": ")"})


def as_data(text: str) -> str:
    """Customer text as Claude sees it: links and phone numbers are labelled as data the
    customer sent, and characters that look like markup are replaced. Nothing is removed."""
    out = (text or "").translate(_ANGLE)
    out = _URL.sub(lambda m: f"[link the customer sent: {m.group(0)}]", out)

    def phone(m: re.Match[str]) -> str:
        raw = m.group(0).strip()
        if sum(ch.isdigit() for ch in raw) < 10:
            return raw  # dates, amounts, ZIP+4 - not phone numbers
        return f"[phone number the customer sent: {raw}]"

    return _PHONE.sub(phone, out)


# ---- 1 + 2 + 10: checking Claude's reply before anyone hears it -------------------------------

_MONEY = re.compile(r"\$\s?(\d[\d,]*(?:\.\d{1,2})?)|\b(\d[\d,]*(?:\.\d{1,2})?)\s?(?:dollars|bucks)\b", re.I)
_DISCOUNT = re.compile(r"\b(discount\w*|\d{1,3}\s?%\s?off|percent off|half[- ]?(price|off)|coupon|promo(tion)? code|"
                       r"free of charge|for free|at no (cost|charge)|no charge|complimentary|on the house|"
                       r"waive[ds]?|price match|special (deal|offer|price))\b", re.I)
# The only accepted mention of a discount is a plain refusal, with nothing else deal-like in the reply.
_REFUSING_DISCOUNT = re.compile(r"\b(not able to|can'?t|cannot|unable to|don'?t|do not) (offer|give|provide)( any| a)? "
                                r"(discounts?|coupons?|deals?)\b", re.I)
_BOOKING_CLAIM = re.compile(
    r"\b(you'?re all set|you are all set|you'?re booked|you are booked|(i'?ve|i have|we'?ve|we have) booked|"
    r"booked (you|it|that|for)|(appointment|visit|booking) (is |has been )?(confirmed|scheduled|set|booked)|"
    r"confirmed for|will be (at|there|over|by) |can be (there|over|at your)|be there (within|by|in|at|around)|"
    r"(on (the|our|my|his|her|their) way)|within the hour|be out (in|by|today|tomorrow|there)|"
    r"(today|tonight|tomorrow) by|in \d+ ?(minutes?|mins?|hours?|hrs?)|have (a|the|our) (tech|technician|plumber|electrician|crew|team)\w* "
    r"(there|out|over)|(arrive|get there|come by) (within|by|in|at|around)|(technician|tech|someone|we)('ll| will| is going to) "
    r"(arrive|come|be (there|at|over))|see you (tomorrow|today|on|at|then))\b", re.I)
_ACTION_CLAIM = re.compile(
    r"\b((i|we)('ve| have)? (cancel+ed|changed|updated|rescheduled|moved|deleted|removed|refunded|modified|credited)|"
    r"(has|have) been (cancel+ed|changed|updated|rescheduled|moved|deleted|removed|refunded))\b", re.I)
_ADVICE = re.compile(r"\b(you should (take|turn off the breaker and|try (resetting|fixing))|"
                     r"(medical|legal|financial) advice is|i recommend (taking|medication)|safe to (stay|keep using))\b", re.I)


@dataclass
class ReplyCheck:
    text: str
    violations: list[str] = field(default_factory=list)


def _allowed_amounts(cfg: TenantConfig) -> set[float]:
    if cfg.pricing.mode != "listed":
        return set()
    return {round(i.price_usd, 2) for i in cfg.pricing.items}


def _shorten(text: str, channel: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    if channel == "voice":
        parts = re.split(r"(?<=[.!?])\s+", text)
        return " ".join(parts[:VOICE_MAX_SENTENCES])
    if len(text) <= SMS_REPLY_MAX:
        return text
    cut = text[:SMS_REPLY_MAX - 1]
    end = max(cut.rfind(". "), cut.rfind("? "), cut.rfind("! "))
    return cut[:end + 1] if end > 80 else cut.rstrip() + "…"


def check_reply(text: str, cfg: TenantConfig, channel: str, booked: bool = False) -> ReplyCheck:
    """Validate Claude's text. Violations are replaced by safe fixed sentences.

    `booked` = a booking was really created in this conversation (only then may the reply
    confirm a visit or an arrival time)."""
    out = ReplyCheck(text=text or "")
    allowed = _allowed_amounts(cfg)
    for m in _MONEY.finditer(out.text):
        amount = float((m.group(1) or m.group(2)).replace(",", ""))
        if round(amount, 2) not in allowed:
            out.violations.append("unlisted_price")
            break
    deal_words = _DISCOUNT.findall(_REFUSING_DISCOUNT.sub("", out.text))
    if deal_words:
        out.violations.append("discount")
    if not booked and _BOOKING_CLAIM.search(out.text):
        out.violations.append("unbooked_commitment")
    if _ACTION_CLAIM.search(out.text):
        out.violations.append("unbacked_action")
    if CLAIMS_HUMAN.search(out.text):
        out.violations.append("claims_human")
    if _ADVICE.search(out.text):
        out.violations.append("advice")
    if cfg.business.niche == "real_estate" and fair_housing_issue(out.text):
        out.violations.append("fair_housing")

    if "fair_housing" in out.violations:
        out.text = FAIR_HOUSING_TEXT
    elif "discount" in out.violations:
        out.text = NO_DISCOUNT_TEXT
    elif "unlisted_price" in out.violations:
        out.text = PRICE_TEXT
    elif "unbooked_commitment" in out.violations:
        out.text = UNBOOKED_TEXT
    elif "unbacked_action" in out.violations:
        out.text = UNBACKED_ACTION_TEXT
    elif "claims_human" in out.violations:
        out.text = robot_answer(sms_business_name(cfg) if channel == "sms" else cfg.business.name)
    elif "advice" in out.violations:
        out.text = "A technician will check it when they arrive. If anyone is in danger, please call 911."
    out.text = _shorten(out.text, channel)
    if not out.text:
        out.violations.append("empty")
        out.text = "Sorry, could you say that again?"
    return out


# ---- usage metering --------------------------------------------------------------------------

def sms_segments(text: str) -> int:
    """Billable SMS segments: GSM-7 160/153 chars, UCS-2 (any non-ASCII) 70/67."""
    body = text or ""
    if not body:
        return 0
    single, multi = (160, 153) if all(ord(ch) < 128 for ch in body) else (70, 67)
    return 1 if len(body) <= single else -(-len(body) // multi)


# ---- fair housing (real-estate niche) -----------------------------------------------------------
# The assistant may never ask about, mention or steer by a protected class (Fair Housing Act: race, color, religion,
# national origin, sex, familial status, disability). The prompt forbids it; this is the code-level backstop on the
# reply, applied for real-estate tenants only (home-services replies legitimately say "family-owned", "kids' room").
FAIR_HOUSING = re.compile(
    r"\b(race|racial|ethnic\w*|hispanic|latino|latina|black|white|asian|jewish|muslim|christian|catholic|church\w*|"
    r"synagogue|mosque|national origin|immigrants?|citizenship|disab\w+|wheelchair|handicap\w*|"
    r"(families|family|people|folks|couples|singles|professionals) (with|without) (kids|children)|"
    r"(no|not for|not suited for|perfect for|great for|ideal for) (kids|children|families|singles|seniors|retirees|students)|"
    r"(good|bad|safe|rough|nice|quiet|changing|up[- ]and[- ]coming|transitional) (neighborhood|area|part of town)|"
    r"(kind|type|sort) of (people|residents|neighbors)|who lives (there|in the area)|demographics?|school (rating|ranking)s?|"
    r"good schools)\b", re.I)
FAIR_HOUSING_TEXT = ("I can share facts about listings and the area, and the agent can walk you through any area you like. "
                     "What else can I help with?")


def fair_housing_issue(text: str) -> bool:
    return bool(FAIR_HOUSING.search(text or ""))


# ---- contact details in free text (chat box: no caller id) -------------------------------------------

_PHONE_DIGITS = re.compile(r"\+?1?\s*\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}\b")
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


def find_phone(text: str) -> str | None:
    """A US phone number in free text, normalized to E.164 (+1XXXXXXXXXX), else None."""
    m = _PHONE_DIGITS.search(text or "")
    if not m:
        return None
    digits = re.sub(r"\D", "", m.group(0))
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if len(digits) != 10 or digits[0] in "01":
        return None
    return "+1" + digits


def find_email(text: str) -> str | None:
    m = _EMAIL.search(text or "")
    return m.group(0).lower() if m else None


# ---- ZIP / service area -----------------------------------------------------------------------

ZIP_RE = re.compile(r"\b(\d{5})(?:-\d{4})?\b")


def find_zip(text: str) -> str | None:
    m = ZIP_RE.search(text or "")
    return m.group(1) if m else None


def zip_in_area(zip_code: str | None, cfg: TenantConfig) -> bool:
    if not cfg.business.service_area_zips:
        return True
    return bool(zip_code) and zip_code in cfg.business.service_area_zips
