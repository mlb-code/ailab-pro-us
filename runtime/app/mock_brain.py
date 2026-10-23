"""Deterministic stand-in for Claude (BRAIN_MODE=mock).

It plays a well-behaved receptionist with simple rules so the whole pipeline (guard, tool
executor, calendar, outcomes) can be exercised offline. It reads only what Claude would read:
the system prompt, the messages and the tool results. A `script` of canned responses can be
queued to simulate misbehaviour (e.g. a reply that offers a discount) and prove the code
around Claude catches it.
"""
from __future__ import annotations

import json
import re
from typing import Any

HUMAN = re.compile(r"\b(human|real person|a person|someone real|representative|manager|owner|talk to (someone|somebody)|speak (to|with) (someone|somebody))\b", re.I)
BYE = re.compile(r"^\s*(no,? )?(that'?s (all|it)|thanks?( you)?|thank you|bye|goodbye|nope|no thanks)[.! ]*$", re.I)
PRICE = re.compile(r"\b(how much|price|cost|charge|fee|rate)\b", re.I)
DISCOUNT = re.compile(r"\b(discount|% off|percent off|coupon|deal)\b", re.I)
INTENT = re.compile(r"\b(broken|broke|not working|isn'?t working|stopped|repair|fix|leak\w*|warm air|no (cool|cold|heat)|"
                    r"book|appointment|schedule|come out|send someone|tune.?up|maintenance|install|estimate|noise|"
                    r"blowing|furnace|heater|ac\b|a/c|air condition\w*|"
                    r"no funciona|descompu\w+|calefacci[oó]n|aire acondicionado|roto|fuga|t[eé]cnico|cita|calentador)", re.I)
FIRST = re.compile(r"\b(first|earlier|morning|1st|the 1|option 1|sooner|yes|yeah|sure|works|ok(ay)?|perfect|great|"
                   r"primer[ao]|s[ií]|claro|la ma[ñn]ana)\b", re.I)
SECOND = re.compile(r"\b(second|later|afternoon|2nd|option 2|other one)\b", re.I)
NAME = re.compile(r"\b(?i:my name is|name is|this is|i'?m|i am|it'?s|under|mi nombre es|me llamo|soy)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)")
ADDRESS = re.compile(r"\b\d{1,6}\s+[A-Za-z0-9 .]+?\s(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|way|ct|court|pl|place|pkwy)\b[^\n]*", re.I)
ZIP = re.compile(r"\b(\d{5})\b")
JOB_HINTS = [("install", "New install estimate"), ("estimate", "New install estimate"), ("tune", "Maintenance"),
             ("maintenance", "Maintenance"), ("furnace", "Furnace repair"), ("heat", "Furnace repair"),
             ("heater", "Furnace repair")]


class RE_LEAD:
    """Regex reader for the real-estate screening answers (what a well-behaved model would extract)."""
    QUESTIONS = {
        "intent": "Are you looking to buy, sell or rent?",
        "area": "Which area or neighborhood are you interested in?",
        "timeline": "What's your timeline, roughly when would you like to move?",
        "price_range": "Do you have a price range in mind?",
        "pre_approval": "Are you pre-approved for a mortgage, paying cash, or not there yet?",
        "property_address": "What's the address of the property?",
        "motivation": "What's prompting the move?",
        "has_agent": "Are you already working with an agent?",
    }
    STEP_KEY = (("buying, selling", "intent"), ("area, neighborhood", "area"), ("timeline", "timeline"),
                ("price range", "price_range"), ("pre-approved", "pre_approval"), ("property address", "property_address"),
                ("why they are selling", "motivation"), ("working with an agent", "has_agent"))
    INTENT = [(re.compile(r"\b(rent|renting|lease|apartment for rent)\b", re.I), "renter"),
              (re.compile(r"\b(sell|selling|list my|worth|home value|what.s my (house|home))\b", re.I), "seller"),
              (re.compile(r"\b(buy|buying|purchase|look(ing)? for a (house|home|place)|see|showing|tour|still available|house hunt\w*|relocat\w+)\b", re.I), "buyer")]
    AREA = re.compile(r"\b(?:in|around|near|to) ((?:[A-Z][a-z]+ ?){1,3})(?=[,.!?]|$| and| area| for| by)")
    TIMELINE = re.compile(r"\b(asap|as soon as possible|right away|this (month|year|spring|summer|fall|winter)|next (month|year|spring|summer|fall|winter)|"
                          r"(in |within |next |the next )?(\d+|two|three|six|few) (weeks?|months?)|just (looking|curious|exploring)|no rush|later this year)\b", re.I)
    PRICE = re.compile(r"((?:under|up to|between|from|max|budget of) \$?\d[\d,.]*\s?[kKmM]?(?: (?:and|to|-) \$?\d[\d,.]*\s?[kKmM]?)?|"
                       r"(?:around|about )?\$\d[\d,.]*\s?[kKmM]?|\b\d{3}\s?[kK]\b)", re.I)
    PRE = [(re.compile(r"\bpre[- ]?approved\b", re.I), "pre_approved"), (re.compile(r"\b(paying )?cash\b", re.I), "cash"),
           (re.compile(r"\b(not (yet|pre[- ]?approved)|no pre[- ]?approval|haven'?t talked to a (bank|lender)|need a lender)\b", re.I), "not_yet")]
    AGENT = [(re.compile(r"\b(not|no|without|don'?t have)( an| a)?( other)? (agent|realtor)|\bno,? (not yet|i'?m not)\b|\bnot working with\b", re.I), "no"),
             (re.compile(r"\b(already )?(working|signed) with (an|my|another|a) (agent|realtor)|\bhave an agent\b|\bmy agent\b", re.I), "yes")]
    MOTIVE = re.compile(r"\b(relocat\w+|downsiz\w+|upsiz\w+|divorce|inherit\w+|job (change|transfer|offer)|new job|retir\w+|growing family|need more space|moving (closer|out of state|for work))\b", re.I)

    @classmethod
    def step_key(cls, step: str, intent: str | None) -> str | None:
        key = next((k for needle, k in cls.STEP_KEY if needle in step), None)
        if key in ("pre_approval",) and intent != "buyer":
            return None
        if key in ("property_address", "motivation") and intent != "seller":
            return None
        if key == "price_range" and intent == "seller":
            return None
        return key

    @classmethod
    def read(cls, text: str) -> dict[str, str]:
        out: dict[str, str] = {}
        for rx, intent in cls.INTENT:
            if rx.search(text):
                out["intent"] = intent
                break
        if m := NAME.search(text):
            out["name"] = m.group(1)
        if m := ADDRESS.search(text):
            out["property_address"] = m.group(0).strip()
        if m := ZIP.search(text):
            out["area"] = m.group(1)
        if m := cls.AREA.search(text):
            if m.group(1).strip() not in (out.get("name") or "",):
                out["area"] = m.group(1).strip()
        if m := cls.TIMELINE.search(text):
            out["timeline"] = m.group(0)
        if m := cls.PRICE.search(text):
            out["price_range"] = m.group(1)
        for rx, v in cls.PRE:
            if rx.search(text):
                out["pre_approval"] = v
                break
        for rx, v in cls.AGENT:
            if rx.search(text):
                out["has_agent"] = v
                break
        if m := cls.MOTIVE.search(text):
            out["motivation"] = m.group(0)
        if m := re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", text):
            out["email"] = m.group(0)
        return out


def _texts(content: Any) -> list[str]:
    if isinstance(content, str):
        return [content]
    return [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]


def _customer_text(content: Any) -> str:
    texts = [t for t in _texts(content) if not t.startswith("[context]")]
    return (texts[-1] if texts else "").removeprefix("Customer: ").strip()


class MockBrain:
    def __init__(self, script: list[dict[str, Any]] | None = None):
        self.script = list(script or [])

    # --- helpers -------------------------------------------------------------------------
    @staticmethod
    def _reply(text: str) -> dict[str, Any]:
        return {"content": [{"type": "text", "text": text}], "stop_reason": "end_turn"}

    @staticmethod
    def _tool(n: int, name: str, args: dict[str, Any]) -> dict[str, Any]:
        return {"content": [{"type": "tool_use", "id": f"toolu_mock_{n:03d}", "name": name, "input": args}],
                "stop_reason": "tool_use"}

    # ADD-ES: a Spanish-speaking customer (the per-turn context says "reply in Spanish") gets the same decisions with the
    # fixed sentences translated, so Spanish flows are exercised end to end (TTS language, templates, consent) offline.
    ES = {
        "Sorry to hear that. I can get a technician out. What's the ZIP code for the service address?":
            "Lamento escuchar eso. Puedo enviar a un técnico. ¿Cuál es el código postal de la dirección?",
        "Great. What name should I put the booking under?": "Perfecto. ¿A nombre de quién hago la cita?",
        "Got it. I've passed your message to the team and someone will get back to you soon.":
            "Entendido. Pasé su mensaje al equipo y alguien se comunicará con usted pronto.",
        "You're all set. Anything else I can help with?": "Listo, su cita está agendada. ¿Algo más en que pueda ayudarle?",
    }
    ES_PATTERNS = [(re.compile(r"^I can get a technician out (.+?)\. Which works better\?$"), "Puedo enviar a un técnico {0}. ¿Cuál le conviene más?"),
                   (re.compile(r"^Thanks, (\w+)\. What's the street address for the visit\?$"), "Gracias, {0}. ¿Cuál es la dirección de la visita?"),
                   (re.compile(r"^You're all set for (.+)\.$"), "Listo, su cita quedó para {0}."),
                   (re.compile(r"^Thanks for reaching out to (.+)\. What can we help you with today\?$"), "Gracias por comunicarse con {0}. ¿En qué podemos ayudarle hoy?")]

    def _translate(self, resp: dict[str, Any]) -> dict[str, Any]:
        for block in resp.get("content") or []:
            if block.get("type") != "text":
                continue
            text = block.get("text", "")
            if text in self.ES:
                block["text"] = self.ES[text]
                continue
            for rx, out in self.ES_PATTERNS:
                if m := rx.match(text):
                    block["text"] = out.format(*m.groups())
                    break
        return resp

    def respond(self, request: dict[str, Any]) -> dict[str, Any]:
        resp = self.script.pop(0) if self.script else self._decide(request)
        ctx = next((b.get("text") or "" for m in reversed(request.get("messages") or []) if m.get("role") == "user"
                    for b in (m.get("content") if isinstance(m.get("content"), list) else [])
                    if b.get("type") == "text" and (b.get("text") or "").startswith("[context]")), "")
        if "reply in Spanish" in ctx:
            resp = self._translate(json.loads(json.dumps(resp)))
        resp = json.loads(json.dumps(resp))
        size_in = len(request.get("system", "")) + len(json.dumps(request.get("messages", [])))
        resp["usage"] = resp.get("usage") or {"input_tokens": size_in // 4,
                                              "output_tokens": max(1, len(json.dumps(resp["content"])) // 4)}
        return resp

    # --- the rules -----------------------------------------------------------------------
    def _decide(self, req: dict[str, Any]) -> dict[str, Any]:
        system: str = req.get("system", "")
        messages: list[dict[str, Any]] = req.get("messages", [])
        n = len(messages)
        biz = (re.search(r"texts for (.+?), a ", system) or re.search(r"(.+)", "the business")).group(1)
        jobs_line = re.search(r"(?:Job|Meeting) types you can book: (.+)", system).group(1).split(" (")[0]
        job_types = [j.strip() for j in jobs_line.split(",")]

        tool_names: dict[str, str] = {}
        results: list[tuple[str, dict]] = []
        customer: list[str] = []
        for m in messages:
            content = m.get("content")
            if m["role"] == "assistant":
                for b in content or []:
                    if b.get("type") == "tool_use":
                        tool_names[b["id"]] = b["name"]
            elif isinstance(content, list) and any(b.get("type") == "tool_result" for b in content):
                for b in content:
                    if b.get("type") == "tool_result":
                        results.append((tool_names.get(b["tool_use_id"], ""), json.loads(b["content"])))
            else:
                customer.append(_customer_text(content))

        last = messages[-1]["content"] if messages else []
        if "LEAD SCREENING" in system:
            return self._real_estate(n, system, messages, results, customer, tool_names, job_types)
        if isinstance(last, list) and any(b.get("type") == "tool_result" for b in last):
            return self._after_tool(n, biz, results[-1], customer)

        text = customer[-1] if customer else ""
        everything = " ".join(customer)
        booked = any(name == "book_slot" and r.get("ok") for name, r in results)
        messaged = any(name in ("take_message", "handoff") for name, _ in results)

        if HUMAN.search(text):
            return self._tool(n, "handoff", {"reason": "Customer asked for a person"})
        if BYE.match(text):
            outcome = "booked" if booked else "message" if messaged else "no_action"
            return self._tool(n, "end_conversation", {"outcome": outcome})
        if DISCOUNT.search(text):
            return self._reply("I'm not able to offer discounts, but our team will give you an exact price on site.")
        if PRICE.search(text):
            listed = re.search(r"PRICE LIST.*?\n- (.+?): \$(\d+(?:\.\d+)?)", system, re.S)
            if listed:
                return self._reply(f"Our {listed.group(1).lower()} is ${listed.group(2)}. Want me to get you on the schedule?")
            return self._reply("Our team will give you an exact price on site. Want me to get a technician out?")
        for q, a in re.findall(r"Q: (.+)\nA: (.+)", system):
            words = {w for w in re.findall(r"[a-z]{4,}", q.lower())}
            if len(words & set(re.findall(r"[a-z]{4,}", text.lower()))) >= 2:
                return self._reply(a)

        avail = [r for name, r in results if name == "get_availability" and r.get("ok") and r.get("slots")]
        if avail and not booked:
            slots = avail[-1]["slots"]
            after = self._customer_after_last_availability(messages, tool_names)
            choice = None
            for t in after:
                part = "PM to" if re.search(r"afternoon", t, re.I) else "AM to" if re.search(r"morning", t, re.I) else ""
                by_part = [s for s in slots if part and part in s["label"]]
                if by_part:
                    choice = by_part[0]
                elif SECOND.search(t) and len(slots) > 1:
                    choice = slots[1]
                elif FIRST.search(t):
                    choice = choice or slots[0]
            if choice:
                name = next((m.group(1) for t in customer for m in [NAME.search(t)] if m), None)
                address = next((m.group(0).strip() for t in customer for m in [ADDRESS.search(t)] if m), None)
                if not name:
                    return self._reply("Great. What name should I put the booking under?")
                if not address:
                    return self._reply(f"Thanks, {name.split()[0]}. What's the street address for the visit?")
                job = self._job(everything, job_types)
                return self._tool(n, "book_slot", {"slot_id": choice["slot_id"], "name": name, "phone": None,
                                                   "address": address, "job_type": job, "urgency": "normal",
                                                   "notes": customer[0][:200] if customer else None})
            return self._reply(f"Which works better: {slots[0]['label']}" +
                               (f" or {slots[1]['label']}?" if len(slots) > 1 else "?"))

        if INTENT.search(everything) and not booked:
            zip_code = next((m.group(1) for t in customer for m in [ZIP.search(t)] if m), None)
            if not zip_code:
                return self._reply("Sorry to hear that. I can get a technician out. What's the ZIP code for the service address?")
            return self._tool(n, "get_availability", {"job_type": self._job(everything, job_types),
                                                      "zip": zip_code, "date_from": None})
        if booked:
            return self._reply("You're all set. Anything else I can help with?")
        return self._reply(f"Thanks for reaching out to {biz}. What can we help you with today?")

    # --- real-estate lead assistant (system prompt carries "LEAD SCREENING") -----------------------------------
    def _real_estate(self, n: int, system: str, messages: list[dict[str, Any]], results: list[tuple[str, dict]],
                     customer: list[str], tool_names: dict[str, str], job_types: list[str]) -> dict[str, Any]:
        """Screens like the prompt asks (one question at a time, in the configured order), then qualify_lead ->
        get_availability -> book_slot, or take_message for renters (when off), callers with an agent, out of area."""
        everything = ". ".join(customer)  # sentence boundaries between turns (the area reader stops at them)
        text = customer[-1] if customer else ""
        agent = (re.search(r"texts for (.+?), a real estate", system) or re.search(r"(.+)", "the agent")).group(1).split(" at ")[0]
        order = re.findall(r"^\d+\. (.+)$", system.split("LEAD SCREENING", 1)[1].split("\n\n", 1)[0], re.M)
        qualified = [r for name, r in results if name == "qualify_lead"]
        booked = any(name == "book_slot" and r.get("ok") for name, r in results)
        messaged = any(name in ("take_message", "handoff") for name, _ in results)
        last = messages[-1]["content"] if messages else []
        after_tool = isinstance(last, list) and any(b.get("type") == "tool_result" for b in last)

        lead = RE_LEAD.read(everything)
        asked = next((t for m in reversed(messages) if m["role"] == "assistant" for t in _texts(m.get("content")) if t), "")
        yes, no = re.match(r"^\W*(yes|yeah|yep|we are|i am)\b", text, re.I), re.match(r"^\W*(no|nope|not yet|nah)\b", text, re.I)
        if asked == RE_LEAD.QUESTIONS["has_agent"] and (yes or no) and "has_agent" not in lead:
            lead["has_agent"] = "yes" if yes else "no"
        if asked == RE_LEAD.QUESTIONS["pre_approval"] and (yes or no) and "pre_approval" not in lead:
            lead["pre_approval"] = "pre_approved" if yes else "not_yet"
        agent = agent.split()[0]
        if after_tool:
            name, r = results[-1]
            if name == "qualify_lead":
                if r.get("note"):
                    why = "renter" if "renter" in r["note"] else "has_agent"
                    summary = ("Renter inquiry" if why == "renter" else "Already working with another agent") + \
                        f": {lead.get('intent') or 'lead'}" + (f", {lead['area']}" if lead.get("area") else "")
                    return self._tool(n, "take_message", {"summary": summary, "urgency": "normal", "name": lead.get("name"),
                                                          "address": lead.get("property_address") or lead.get("area"),
                                                          "job_type": None})
                zip_code = ZIP.search(everything)
                if not zip_code:
                    return self._reply("Got it. What's the ZIP code of the area or property?")
                return self._tool(n, "get_availability", {"job_type": r.get("meeting_type") or job_types[0],
                                                          "zip": zip_code.group(1), "date_from": None})
            if name == "get_availability":
                if r.get("ok") and r.get("slots"):
                    s = r["slots"]
                    return self._reply(f"{agent} can meet {s[0]['label']}" + (f" or {s[1]['label']}" if len(s) > 1 else "")
                                       + ". Which works better?")
                summary = ("Lead outside the service area" if r.get("reason") == "out_of_area" else "Lead could not be booked") + \
                    f": {lead.get('intent') or 'inquiry'}" + (f", {lead['area']}" if lead.get("area") else "")
                return self._tool(n, "take_message", {"summary": summary, "urgency": "normal", "name": lead.get("name"),
                                                      "address": lead.get("property_address") or lead.get("area"), "job_type": None})
            if name == "book_slot":
                if r.get("ok"):
                    return self._reply(f"You're all set for {r['label']}. {agent} will see you then.")
                return self._reply("Sorry, that time was just taken. Would another time work?")
            if name == "take_message":
                return self._reply(f"Thanks, I've passed your details to {agent} and the team will follow up.")
            if name == "handoff":
                return self._reply("I've let the team know you'd like to talk to someone, and they'll call you back soon.")
            return self._reply("Thanks! Anything else I can help with?")

        if HUMAN.search(text):
            return self._tool(n, "handoff", {"reason": "Caller asked for a person"})
        if BYE.match(text):
            return self._tool(n, "end_conversation", {"outcome": "booked" if booked else "message" if messaged else "no_action"})
        if PRICE.search(text) and re.search(r"\b(worth|value|list(ed)? (at|for)|asking|offer)\b", text, re.I):
            return self._reply(f"{agent} will go over pricing with you directly. Can I ask a few quick questions first?")
        for q, a in re.findall(r"Q: (.+)\nA: (.+)", system):
            words = {w for w in re.findall(r"[a-z]{4,}", q.lower())}
            if len(words & set(re.findall(r"[a-z]{4,}", text.lower()))) >= 2:
                return self._reply(a)

        avail = [r for name, r in results if name == "get_availability" and r.get("ok") and r.get("slots")]
        if avail and not booked:
            slots = avail[-1]["slots"]
            choice = None
            for t in self._customer_after_last_availability(messages, tool_names):
                part = "PM to" if re.search(r"afternoon", t, re.I) else "AM to" if re.search(r"morning", t, re.I) else ""
                by_part = [s for s in slots if part and part in s["label"]]
                if by_part:
                    choice = by_part[0]
                elif SECOND.search(t) and len(slots) > 1:
                    choice = slots[1]
                elif FIRST.search(t):
                    choice = choice or slots[0]
            if choice:
                if not lead.get("name"):
                    return self._reply("Great. What name should I put the meeting under?")
                job = qualified[-1].get("meeting_type") if qualified else job_types[0]
                return self._tool(n, "book_slot", {"slot_id": choice["slot_id"], "name": lead["name"], "phone": None,
                                                   "address": lead.get("property_address") or lead.get("area") or "n/a",
                                                   "job_type": job if job in job_types else job_types[0],
                                                   "urgency": "normal", "notes": customer[0][:200] if customer else None})
            return self._reply(f"Which works better: {slots[0]['label']}" + (f" or {slots[1]['label']}?" if len(slots) > 1 else "?"))

        if qualified:
            return self._reply("Thanks! Anything else I can help with?")
        if not lead.get("intent"):
            return self._reply(f"Thanks for reaching out to {agent}'s office. Are you looking to buy, sell or rent?")
        for step in order:
            key = RE_LEAD.step_key(step, lead.get("intent"))
            if key and key not in lead:
                return self._reply(RE_LEAD.QUESTIONS[key])
        return self._tool(n, "qualify_lead", {k: lead.get(k) for k in ("intent", "area", "timeline", "price_range", "pre_approval",
                                                                       "property_address", "motivation", "has_agent", "name", "email")})

    @staticmethod
    def _customer_after_last_availability(messages: list[dict[str, Any]], tool_names: dict[str, str]) -> list[str]:
        out: list[str] = []
        for m in messages:
            c = m.get("content")
            if m["role"] != "user":
                continue
            if isinstance(c, list) and any(b.get("type") == "tool_result" for b in c):
                if any(tool_names.get(b.get("tool_use_id")) == "get_availability" for b in c):
                    out = []
            else:
                out.append(_customer_text(c))
        return out

    @staticmethod
    def _job(text: str, job_types: list[str]) -> str:
        low = text.lower()
        for hint, job in JOB_HINTS:
            if hint in low and job in job_types:
                return job
        return job_types[0]

    def _after_tool(self, n: int, biz: str, last: tuple[str, dict], customer: list[str]) -> dict[str, Any]:
        name, r = last
        if name == "get_availability":
            if r.get("ok") and r.get("slots"):
                s = r["slots"]
                return self._reply(f"I can get a technician out {s[0]['label']}" +
                                   (f" or {s[1]['label']}" if len(s) > 1 else "") + ". Which works better?")
            summary = "Customer outside the service area" if r.get("reason") == "out_of_area" else \
                f"Customer needs service: {(customer[0] if customer else '')[:150]}"
            return self._tool(n, "take_message", {"summary": summary, "urgency": "normal", "name": None})
        if name == "book_slot":
            if r.get("ok"):
                return self._reply(f"You're all set for {r['label']}.")
            if r.get("reason") == "duplicate":
                return self._tool(n, "take_message", {"summary": "Customer already booked that day and called again",
                                                      "urgency": "normal", "name": None})
            return self._reply("Sorry, that time was just taken. Would another time work?")
        if name == "take_message":
            if r.get("reason") == "out_of_area":
                return self._reply("Sorry, that address is outside our service area. I've passed your details to the team.")
            return self._reply("Got it. I've passed your message to the team and someone will get back to you soon.")
        if name == "handoff":
            if r.get("action") == "dial":
                return self._reply("Let me connect you with someone from the team now.")
            return self._reply("I've let the team know you'd like to talk to someone, and they'll call you back soon.")
        return self._reply(f"Thanks for contacting {biz}. Have a great day!")
