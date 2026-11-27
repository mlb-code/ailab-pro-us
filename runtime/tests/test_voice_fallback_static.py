"""Static voice fallback (site/voice-fallback.xml + VOICE_FALLBACK_URL): a caller hears a sentence even when this
server is down, because Twilio fetches the file from the site, not from the call server."""
from pathlib import Path
from xml.etree import ElementTree

from app.provisioning import webhooks

BASE = "https://rt.example.com"
STATIC = "https://ailabpro.co/voice-fallback.xml"


def test_default_fallback_is_this_server():
    w = webhooks(BASE, env={})
    assert (w["VoiceFallbackUrl"], w["VoiceFallbackMethod"]) == (f"{BASE}/voice/fallback", "POST")


def test_static_fallback_is_fetched_with_get():
    w = webhooks(BASE, env={"VOICE_FALLBACK_URL": f" {STATIC} "})
    assert (w["VoiceFallbackUrl"], w["VoiceFallbackMethod"]) == (STATIC, "GET")
    assert w["VoiceUrl"] == f"{BASE}/voice/incoming" and w["StatusCallback"] == f"{BASE}/voice/status"


def test_a_non_https_value_is_ignored():
    w = webhooks(BASE, env={"VOICE_FALLBACK_URL": "http://ailabpro.co/voice-fallback.xml"})
    assert w["VoiceFallbackUrl"] == f"{BASE}/voice/fallback"


def test_the_static_file_is_valid_twiml_without_promises():
    path = Path(__file__).resolve().parents[2] / "site" / "voice-fallback.xml"
    root = ElementTree.parse(path).getroot()
    assert root.tag == "Response" and [c.tag for c in root] == ["Say", "Hangup"]
    text = root[0].text.lower()
    assert "9 1 1" in text and "call back in a few minutes" in text
    assert "we will call" not in text and "we'll call" not in text  # nothing is logged on our side during an outage
