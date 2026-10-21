"""Silence reprompt repeats the last open question instead of restarting the conversation (live test call 21.10)."""
from app.conversation import REPROMPT_TEXT, reprompt_for


def t(*turns):
    return [{"who": w, "text": x} for w, x in turns]


def test_repeats_last_question():
    tr = t(("assistant", "Thanks for calling. How can I help?"), ("customer", "My AC stopped cooling."),
           ("assistant", "Sorry to hear that. What ZIP code is the home in?"))
    assert reprompt_for(tr) == "Sorry, I didn't catch that. What ZIP code is the home in?"


def test_takes_the_last_question_of_a_long_turn():
    tr = t(("assistant", "One moment. You're booked for Thursday. Can I text your confirmation to this number?"))
    assert reprompt_for(tr).endswith("Can I text your confirmation to this number?")


def test_no_question_falls_back_to_generic():
    tr = t(("assistant", "I have Wednesday from 8 AM to 12 PM, and Wednesday from 12 PM to 4 PM."))
    assert reprompt_for(tr) == REPROMPT_TEXT


def test_greeting_question_and_empty():
    assert reprompt_for(t(("assistant", "Thanks for calling Copperleaf. How can I help?"))) == \
        "Sorry, I didn't catch that. How can I help?"
    assert reprompt_for([]) == REPROMPT_TEXT


def test_repeated_reprompt_keeps_the_question():
    tr = t(("assistant", "What ZIP code is the home in?"), ("assistant", "Sorry, I didn't catch that. What ZIP code is the home in?"))
    assert reprompt_for(tr) == "Sorry, I didn't catch that. What ZIP code is the home in?"
