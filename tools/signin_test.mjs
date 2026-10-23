// Unit tests for site/start/assets/signin.js (sign-in helpers: providers, redirect allow-list, provider errors,
// one-person-one-account rules for Apple relay addresses). No browser, no network:  node tools/signin_test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// classic script: run it with a stand-in window (the repo is "type": "module", so require() would not see its exports)
const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../site/start/assets/signin.js'), 'utf8');
const S = new Function('window', 'module', src + '\nreturn window.StartSignin;')({}, undefined);

let pass = 0, fail = 0;
const eq = (a, b, name) => { const ok = JSON.stringify(a) === JSON.stringify(b); if (ok) pass++; else { fail++; console.log('  FAIL ' + name + '\n    got      ' + JSON.stringify(a) + '\n    expected ' + JSON.stringify(b)); } };
const throws = (fn, name) => { try { fn(); fail++; console.log('  FAIL ' + name + ' (no throw)'); } catch (e) { pass++; } };

// ---------------------------------------------------------------- providers: order + flags
eq(S.enabledProviders({}), [], 'no flags -> no provider buttons');
eq(S.enabledProviders({ GOOGLE_ENABLED: true }), ['google'], 'google only');
eq(S.enabledProviders({ APPLE_ENABLED: true }), ['apple'], 'apple only');
eq(S.enabledProviders({ APPLE_ENABLED: true, GOOGLE_ENABLED: true }), ['google', 'apple'], 'always Google first, then Apple');
eq(S.enabledProviders({ GOOGLE_ENABLED: 'true', APPLE_ENABLED: 'false' }), ['google'], 'string flags');
eq(S.enabledProviders({ GOOGLE_ENABLED: 1 }), [], 'truthy non-boolean is not enabled');
eq(S.providerLabel('google'), 'Continue with Google', 'Google wording per Google guidelines');
eq(S.providerLabel('apple'), 'Sign in with Apple', 'Apple wording per Apple guidelines');
eq(S.providerName('x'), 'that provider', 'unknown provider name');

// ---------------------------------------------------------------- redirect allow-list
const SITE = 'https://ailabpro.co';
eq(S.redirectTarget('https://ailabpro.co', SITE), 'https://ailabpro.co/start/', 'production origin -> production portal');
eq(S.redirectTarget('https://AILABPRO.co/', SITE + '/'), 'https://ailabpro.co/start/', 'case + trailing slashes normalised');
eq(S.redirectTarget('http://localhost:8787', SITE), 'http://localhost:8787/start/', 'local dev allowed');
eq(S.redirectTarget('http://127.0.0.1:8931', SITE), 'http://127.0.0.1:8931/start/', 'loopback allowed');
eq(S.redirectTarget('http://localhost:8787', SITE, '/start/admin/'), 'http://localhost:8787/start/admin/', 'custom path');
eq(S.redirectTarget('https://ailabpro.co.evil.com', SITE), 'https://ailabpro.co/start/', 'look-alike host -> production');
eq(S.redirectTarget('http://ailabpro.co', SITE), 'https://ailabpro.co/start/', 'http copy of the site -> https production');
eq(S.redirectTarget('https://localhost', SITE), 'https://ailabpro.co/start/', 'https localhost is not the dev allow-list');
eq(S.redirectTarget('null', SITE), 'https://ailabpro.co/start/', 'opaque origin (file://) -> production');
eq(S.redirectTarget('', SITE), 'https://ailabpro.co/start/', 'no origin -> production');
throws(() => S.redirectTarget('https://evil.com', ''), 'no site url and not local -> throws');

// ---------------------------------------------------------------- tokens must not stay in the URL
eq(S.urlHasTokens('https://ailabpro.co/start/?code=abc'), true, 'PKCE code');
eq(S.urlHasTokens('https://ailabpro.co/start/#access_token=x&refresh_token=y'), true, 'implicit tokens in hash');
eq(S.urlHasTokens('https://ailabpro.co/start/#error=access_denied'), true, 'provider error in hash');
eq(S.urlHasTokens('https://ailabpro.co/start/?offer=RCP&niche=home_services'), false, 'landing intent is fine');
eq(S.urlHasTokens('https://ailabpro.co/start/#quotes'), false, 'tab hash is fine');

// ---------------------------------------------------------------- provider errors -> clear text
eq(S.readOauthError('', ''), null, 'no error');
eq(S.readOauthError('?offer=RCP', '#quotes'), null, 'no error with other params');
eq(S.readOauthError('', '#error=access_denied&error_code=user_cancelled&error_description=User+cancelled'),
  { error: 'access_denied', code: 'user_cancelled', description: 'User cancelled' }, 'hash form (Supabase)');
eq(S.readOauthError('?error=server_error&error_description=Unable+to+exchange+external+code', ''),
  { error: 'server_error', code: '', description: 'Unable to exchange external code' }, 'query form');
eq(S.oauthErrorText(null, 'google'), null, 'null in -> null out');
const cancel = S.oauthErrorText(S.readOauthError('', '#error=access_denied&error_description=The+user+denied'), 'google');
eq(cancel.kind, 'cancelled', 'cancelled kind'); eq(/You cancelled the Google sign-in/.test(cancel.text), true, 'cancelled names Google');
const cancelA = S.oauthErrorText({ error: 'access_denied', code: 'user_cancelled_authorize', description: '' }, 'apple');
eq(/Apple sign-in/.test(cancelA.text), true, 'Apple cancel names Apple');
const down = S.oauthErrorText({ error: 'server_error', code: '', description: 'Unable to exchange external code' }, 'apple');
eq(down.kind, 'provider_down', 'provider down kind'); eq(/use your email/.test(down.text), true, 'provider down points to email');
const conflict = S.oauthErrorText({ error: 'server_error', code: 'identity_already_exists', description: 'Identity is already linked to another user' }, 'google');
eq(conflict.kind, 'conflict', 'conflict kind'); eq(/email link/.test(conflict.text), true, 'conflict points to the email link');
const conflict2 = S.oauthErrorText({ error: 'server_error', code: '', description: 'Multiple accounts with the same email address in the same linking domain detected' }, 'apple');
eq(conflict2.kind, 'conflict', 'multiple accounts = conflict');
const other = S.oauthErrorText({ error: 'invalid_request', code: 'bad_oauth_state', description: 'OAuth state parameter missing' }, null);
eq(other.kind, 'failed', 'unknown -> failed'); eq(/The that sign-in/.test(other.text), true, 'unknown provider wording');
for (const t of [cancel, cancelA, down, conflict, other]) eq(/[֐-׿]/.test(t.text), false, 'English only: ' + t.kind);

// ---------------------------------------------------------------- one person, one account
eq(S.isRelayEmail('abc123@privaterelay.appleid.com'), true, 'Apple relay');
eq(S.isRelayEmail('ABC@PRIVATERELAY.APPLEID.COM'), true, 'relay any case');
eq(S.isRelayEmail('dani@coolbreeze.test'), false, 'normal address');
eq(S.isRelayEmail(''), false, 'empty');
eq(S.validEmail(' Dani@CoolBreeze.test '), true, 'valid with spaces');
eq(S.validEmail('nope'), false, 'invalid');
eq(S.needsContactEmail(null), false, 'no profile');
eq(S.needsContactEmail({ email: 'dani@coolbreeze.test' }), false, 'email-link account needs nothing');
eq(S.needsContactEmail({ email: 'dani@gmail.com', contact_email: null }), false, 'Google account with real email needs nothing');
eq(S.needsContactEmail({ email: 'x1@privaterelay.appleid.com' }), true, 'relay without contact -> ask');
eq(S.needsContactEmail({ email: 'x1@privaterelay.appleid.com', contact_email: 'dani@coolbreeze.test' }), false, 'relay with contact -> fine');
eq(S.needsContactEmail({ email: 'x1@privaterelay.appleid.com', contact_email: 'bad' }), true, 'relay with invalid contact -> ask again');
eq(S.contactEmail({ email: 'x1@privaterelay.appleid.com', contact_email: ' Dani@CoolBreeze.test ' }), 'dani@coolbreeze.test', 'contact wins, normalised');
eq(S.contactEmail({ email: 'dani@coolbreeze.test', contact_email: '' }), 'dani@coolbreeze.test', 'sign-in email when no contact');
eq(S.contactEmail(null), '', 'no profile -> empty');
eq(S.displayEmail({ email: 'x1@privaterelay.appleid.com', contact_email: 'dani@coolbreeze.test' }, { user: { email: 'x1@privaterelay.appleid.com' } }), 'dani@coolbreeze.test', 'header shows contact');
eq(S.displayEmail({ email: 'x1@privaterelay.appleid.com' }, { user: { email: 'x1@privaterelay.appleid.com' } }), 'x1@privaterelay.appleid.com', 'header falls back to relay');
eq(S.displayEmail(null, { user: { email: 'dani@coolbreeze.test' } }), 'dani@coolbreeze.test', 'no profile yet -> session email');

console.log(`signin_test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
