"""SMS flow (SPEC 6.3): /sms/incoming and /sms/status.

Every inbound text goes through the conversation engine, which handles STOP / STOPALL / CANCEL /
END / QUIT / UNSUBSCRIBE, START / UNSTOP / YES (only for a number that opted out) and HELP / INFO
before Claude, then guard -> Claude -> reply check. The reply is sent as TwiML (a direct reply,
so quiet hours do not apply), at most 320 characters. Messages are logged in `sms_messages`
(Twilio retries of the same MessageSid are ignored), segments count toward monthly usage, and a
booking queues one reminder 24 h before the visit. Proactive messages (text-back, reminder,
booking confirmation after a call) go through `app.sms_outbound.Outbound`.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, BackgroundTasks, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from twilio.twiml.messaging_response import MessagingResponse

from . import _stubs_b56 as hooks
from . import guard
from .runtime_ctx import Runtime
from .sms_outbound import after_turn, thread_id

log = logging.getLogger("rt.sms")

TWIML = "application/xml"
CARRIER_OPT_OUT_ERRORS = {"21610"}  # "Attempt to send to unsubscribed recipient"

router = APIRouter()


def _empty() -> Response:
    return Response(str(MessagingResponse()), media_type=TWIML)


def handle_inbound(rt: Runtime, form: dict[str, str]) -> str:
    """Process one inbound SMS; returns the reply text ("" = no reply)."""
    tenant, problem = rt.resolve_tenant(form.get("To", ""))
    if problem or not tenant:
        return ""
    ts = rt.store.for_tenant(tenant.id)
    contact, sid, body = form.get("From", ""), form.get("MessageSid", ""), form.get("Body", "") or ""
    if sid and ts.select("sms_messages", twilio_sid=sid):
        return ""  # Twilio retry of a message we already handled
    hooks.record_sms(rt.store, rt.state, tenant, twilio_sid=sid or None, contact_e164=contact, direction="inbound",
                     body=body[:2000], segments=guard.sms_segments(body))
    ts.log_event("sms.incoming", {"message_sid": sid})
    now = rt.now()
    if form.get("OptOutType", "").upper() == "STOP":
        ts.opt_out(contact)  # Twilio Advanced Opt-Out already confirmed it: stay silent
        return ""
    try:
        num_media = int(form.get("NumMedia") or 0)
    except ValueError:
        num_media = 0
    convo_id = thread_id(rt.state, tenant, contact, now)
    res = rt.engine.handle(tenant, "sms", contact, body, convo_id, now, num_media=num_media)
    rt.deliver(tenant, res.actions, convo_id)
    c = rt.engine.find_convo(tenant, "sms", convo_id)
    if c is not None:
        after_turn(rt, tenant, c, now)
    reply = res.reply
    if len(reply) > guard.SMS_REPLY_MAX:
        reply = reply[:guard.SMS_REPLY_MAX - 1].rstrip() + "…"
    if reply:  # TwiML reply: Twilio assigns the SID later, so the row has none
        hooks.record_sms(rt.store, rt.state, tenant, twilio_sid=None, contact_e164=contact, direction="outbound",
                         body=reply, segments=guard.sms_segments(reply),
                         claude_cost_usd=res.cost_usd, guard_rules=res.guard)
    return reply


@router.post("/sms/incoming")
async def sms_incoming(request: Request, background: BackgroundTasks) -> Response:
    rt: Runtime = request.app.state.rt
    form = {k: str(v) for k, v in (await request.form()).items()}
    reply = await run_in_threadpool(handle_inbound, rt, form)
    if not reply:
        return _empty()
    resp = MessagingResponse()
    resp.message(reply)
    return Response(str(resp), media_type=TWIML)


@router.post("/sms/status")
async def sms_status(request: Request) -> Response:
    """Delivery status for messages we sent. A carrier-level unsubscribe becomes an opt-out."""
    rt: Runtime = request.app.state.rt
    form = await request.form()
    tenant, problem = rt.resolve_tenant(str(form.get("From", "")))  # our number sent it
    if tenant and not problem:
        ts = rt.store.for_tenant(tenant.id)
        err = str(form.get("ErrorCode", "") or "")
        ts.log_event("sms.status", {"sid": str(form.get("MessageSid", "")), "status": str(form.get("MessageStatus", "")),
                                    **({"error": err} if err else {})})
        if err in CARRIER_OPT_OUT_ERRORS:
            ts.opt_out(str(form.get("To", "")))
    return Response(status_code=204)
