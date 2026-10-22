/* Sign-in helpers for /start/: pure functions, no DOM, no network. Loaded as a classic script by the portal (window.StartSignin)
   and required by the Node unit test tools/signin_test.mjs. Rules in one place:
     providers   Google + Apple buttons, in this order, only when config.js enables them (GOOGLE_ENABLED / APPLE_ENABLED)
     redirect    strict allow-list for the OAuth return URL: the production site or local dev, never a third-party origin
     errors      the provider's return (?error=…/#error=…) -> one clear English sentence (cancelled / unavailable / conflict)
     one person  identities are keyed by the auth user id; Apple "Hide My Email" relay addresses get a contact e-mail */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.StartSignin = api;
})(typeof window !== 'undefined' ? window : null, function () {
  const PROVIDERS = [
    { key: 'google', label: 'Continue with Google', flag: 'GOOGLE_ENABLED', name: 'Google' },
    { key: 'apple', label: 'Sign in with Apple', flag: 'APPLE_ENABLED', name: 'Apple' }
  ];
  const RELAY_RX = /@privaterelay\.appleid\.com$/i;
  const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const LOCAL_RX = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
  const TOKEN_IN_URL_RX = /[?&#](code|access_token|refresh_token|id_token|provider_token|token_hash|error|error_code|error_description)=/;

  /** Providers to show, in button order. cfg = window.SITE_CONFIG (or any object with the *_ENABLED flags). */
  function enabledProviders(cfg) {
    cfg = cfg || {};
    return PROVIDERS.filter(p => cfg[p.flag] === true || cfg[p.flag] === 'true').map(p => p.key);
  }
  function providerName(key) { const p = PROVIDERS.find(x => x.key === key); return p ? p.name : 'that provider'; }
  function providerLabel(key) { const p = PROVIDERS.find(x => x.key === key); return p ? p.label : ''; }

  /** Where the provider sends the browser back. Allowed: the configured site (any path under it) and local dev over
      plain http. Anything else (a look-alike host, a file://, an http copy of the site) goes to the production portal. */
  function redirectTarget(origin, siteUrl, path) {
    path = path || '/start/';
    const site = String(siteUrl || '').replace(/\/+$/, '');
    const o = String(origin || '').replace(/\/+$/, '');
    if (o && site && o.toLowerCase() === site.toLowerCase()) return site + path;
    if (LOCAL_RX.test(o)) return o + path;
    if (site) return site + path;
    throw new Error('redirect_not_allowed');
  }

  /** Does this URL still carry OAuth / magic-link material that must not stay in the address bar or history? */
  function urlHasTokens(href) { return TOKEN_IN_URL_RX.test(String(href || '')); }

  /** Read the provider's error from the return URL (search or hash). Returns null when there is none. */
  function readOauthError(search, hash) {
    const p = new URLSearchParams(String(search || '').replace(/^\?/, '') + '&' + String(hash || '').replace(/^#/, ''));
    const error = p.get('error'), code = p.get('error_code'), desc = p.get('error_description');
    if (!error && !code && !desc) return null;
    return { error: error || '', code: code || '', description: desc || '' };
  }

  /** One sentence for the sign-in screen. err = readOauthError(...), attempted = 'google' | 'apple' | 'email' | null. */
  function oauthErrorText(err, attempted) {
    if (!err) return null;
    const who = attempted === 'google' || attempted === 'apple' ? providerName(attempted) : 'that';
    const all = [err.error, err.code, err.description].join(' ').toLowerCase();
    if (/access_denied|user_cancel|cancell?ed|consent_required|user denied/.test(all)) {
      return { kind: 'cancelled', text: 'You cancelled the ' + who + ' sign-in. Nothing was saved. You can try again or use your email.' };
    }
    if (/already|exists|multiple accounts|linking|identity_already|email_exists|different provider/.test(all)) {
      return { kind: 'conflict', text: 'This email already has an account that signs in a different way. Sign in with the email link below (same email) and you will see your quotes; or email us and we will sort it out.' };
    }
    if (/server_error|temporarily_unavailable|unexpected_failure|unavailable|timeout|provider|5\d\d/.test(all)) {
      return { kind: 'provider_down', text: who + ' sign-in is not available right now. Please use your email instead; it takes one minute.' };
    }
    return { kind: 'failed', text: 'The ' + who + ' sign-in did not finish. Please try again or use your email.' };
  }

  /** Apple "Hide My Email" gives a relay address that forwards to the person, but quotes and receipts should go to an
      address they recognise. */
  function isRelayEmail(email) { return RELAY_RX.test(String(email || '')); }
  function validEmail(email) { return EMAIL_RX.test(String(email || '').trim()); }
  /** First sign-in through a relay address, no contact e-mail yet: ask for one before anything else. */
  function needsContactEmail(profile) {
    if (!profile) return false;
    return isRelayEmail(profile.email) && !validEmail(profile.contact_email);
  }
  /** The address we write to: the person's own contact e-mail when set, else the sign-in e-mail. */
  function contactEmail(profile) {
    if (!profile) return '';
    return validEmail(profile.contact_email) ? String(profile.contact_email).trim().toLowerCase() : String(profile.email || '');
  }
  /** What the header shows next to "Sign out". */
  function displayEmail(profile, session) {
    const c = contactEmail(profile);
    if (c && !isRelayEmail(c)) return c;
    return (session && session.user && session.user.email) || c || '';
  }

  return { PROVIDERS, enabledProviders, providerName, providerLabel, redirectTarget, urlHasTokens, readOauthError,
    oauthErrorText, isRelayEmail, validEmail, needsContactEmail, contactEmail, displayEmail };
});
