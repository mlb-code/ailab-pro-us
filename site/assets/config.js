/* Site-wide runtime config. PUBLIC values only (URL + publishable/anon key are public by design; never a service key).
   generated-by: tools/us_setup.py (task A2). Re-run `python3 tools/us_setup.py --only config` to refresh; do not edit by hand.
   BACKEND: 'mock'     -> everything runs in the browser (localStorage), no network
            'supabase' -> real project; needs SUPABASE_URL + SUPABASE_ANON_KEY
   ALLOW_MOCK_SWITCH: when true, ?mock=1 forces the mock backend on any host (always allowed on localhost).
   FEATURES: copied from config/brand.json. */
window.SITE_CONFIG = {
  BACKEND: 'supabase',
  SUPABASE_URL: "https://ysvatwofbpqlaqhbzeav.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_AtzeR4Qp6tRp2-IbAmgcoQ_F2G3YPwJ",
  SUPABASE_JS: "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js",
  GOOGLE_ENABLED: true,
  APPLE_ENABLED: false,
  ALLOW_MOCK_SWITCH: false,
  BUCKET: 'client-files',
  MAX_FILES: 5,
  MAX_FILE_MB: 10,
  FEATURES: {"show_founder_price": true, "legal_final": true}
};
