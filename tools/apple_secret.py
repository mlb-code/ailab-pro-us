#!/usr/bin/env python3
"""
Sign in with Apple client secret for Supabase (a JWT signed ES256 with the .p8 key; Apple allows at most 6 months).
Same script as the Israeli intake portal (ailab-business-site/tools/apple_secret.py), copied 22.10.2026 for ailabpro.co.

Normally not run by hand: tools/us_setup.py --only apple reads APPLE_* from .secrets.env, builds the secret with
make_secret() and sends it to Supabase (never printed). By hand (prints the secret to stdout, for pasting in the dashboard):
  python3 tools/apple_secret.py --team TEAMID1234 --key-id KEYID12345 --services-id co.ailabpro.signin --p8 ~/Downloads/AuthKey_KEYID12345.p8

Apple's maximum is 180 days; this makes 175. Renew every ~5 months (calendar reminder, see the runbook).
Uses PyJWT when installed, else the openssl that ships with macOS.
"""
import argparse, base64, json, os, subprocess, sys, tempfile, time

MAX_DAYS = 175


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def der_to_raw(der: bytes, size: int = 32) -> bytes:
    """ECDSA DER signature (SEQUENCE{INTEGER r, INTEGER s}) -> raw r||s as JWS requires."""
    if der[0] != 0x30:
        raise ValueError("bad DER signature")
    i = 2 if der[1] < 0x80 else 2 + (der[1] & 0x7F)
    out = b""
    for _ in range(2):
        if der[i] != 0x02:
            raise ValueError("bad DER integer")
        ln = der[i + 1]
        val = der[i + 2:i + 2 + ln].lstrip(b"\x00")
        out += val.rjust(size, b"\x00")
        i += 2 + ln
    return out


def make_secret(team_id: str, key_id: str, services_id: str, p8_path: str, days: int = MAX_DAYS) -> str:
    days = max(1, min(days, MAX_DAYS))
    now = int(time.time())
    claims = {"iss": team_id, "iat": now, "exp": now + days * 86400,
              "aud": "https://appleid.apple.com", "sub": services_id}
    header = {"alg": "ES256", "kid": key_id, "typ": "JWT"}
    with open(os.path.expanduser(p8_path), "rb") as f:
        key_pem = f.read()
    try:
        import jwt  # PyJWT
        return jwt.encode(claims, key_pem, algorithm="ES256", headers={"kid": key_id})
    except ImportError:
        pass
    signing_input = (b64url(json.dumps(header, separators=(",", ":")).encode()) + "." +
                     b64url(json.dumps(claims, separators=(",", ":")).encode()))
    with tempfile.NamedTemporaryFile(delete=False) as tf:
        tf.write(signing_input.encode())
        data_path = tf.name
    try:
        der = subprocess.run(["openssl", "dgst", "-sha256", "-sign", os.path.expanduser(p8_path), data_path],
                             check=True, capture_output=True).stdout
    finally:
        os.unlink(data_path)
    return signing_input + "." + b64url(der_to_raw(der))


def main():
    ap = argparse.ArgumentParser(description="Apple client secret (JWT) for Supabase")
    ap.add_argument("--team", required=True, help="Team ID (10 chars, top right of developer.apple.com/account)")
    ap.add_argument("--key-id", required=True, help="Key ID of the Sign in with Apple key (10 chars)")
    ap.add_argument("--services-id", required=True, help="the Services ID identifier, e.g. co.ailabpro.signin")
    ap.add_argument("--p8", required=True, help="path to the downloaded AuthKey_XXXX.p8")
    ap.add_argument("--days", type=int, default=MAX_DAYS, help="validity in days (max 175)")
    a = ap.parse_args()
    if not os.path.exists(os.path.expanduser(a.p8)):
        sys.exit("לא מצאתי את קובץ ה-.p8 בנתיב שנתת: " + a.p8)
    secret = make_secret(a.team.strip(), a.key_id.strip(), a.services_id.strip(), a.p8, a.days)
    exp = time.strftime("%d.%m.%Y", time.localtime(time.time() + min(a.days, MAX_DAYS) * 86400))
    print(secret)
    print("\n✅ זה ה-Secret. תקף עד " + exp + ". לחדש לפני התאריך הזה (אותה פקודה בדיוק).", file=sys.stderr)


if __name__ == "__main__":
    main()
