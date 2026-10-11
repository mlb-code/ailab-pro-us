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
                    r"blowing|furnace|heater|ac\b|a/c|air condition\w*)", re.I)
FIRST = re.compile(r"\b(first|earlier|morning|1st|the 1|option 1|sooner|yes|yeah|sure|works|ok(ay)?|perfect|great)\b", re.I)
SECOND = re.compile(r"\b(second|later|afternoon|2nd|option 2|other one)\b", re.I)
NAME = re.compile(r"\b(?i:my name is|name is|this is|i'?m|i am|it'?s|under)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)")
ADDRESS = re.compile(r"\b\d{1,6}\s+[A-Za-z0-9 .]+?\s(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|way|ct|court|pl|place|pkwy)\b[^\n]*", re.I)
ZIP = re.compile(r"\b(\d{5})\b")
JOB_HINTS = [("install", "New install estimate"), ("estimate", "New install estimate"), ("tune", "Maintenance"),
             ("maintenance", "Maintenance"), ("furnace", "Furnace repair"), ("heat", "Furnace repair"),
             ("heater", "Furnace repair")]


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

    def respond(self, request: dict[str, Any]) -> dict[str, Any]:
        resp = self.script.pop(0) if self.script else self._decide(request)
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
        job_types = [j.strip() for j in (re.search(r"Job types you can book: (.+)", system).group(1).split(","))]

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
                return self._reply(f"You're all set for {r['label']}. You'll get a text confirming it.")
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
