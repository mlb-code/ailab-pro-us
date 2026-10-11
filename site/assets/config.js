/* Site-wide runtime config. PUBLIC values only (URL + anon key are public by design; never a service key).
   Written by tools/us_setup.py (task A2); this checked-in version runs the client portal on the mock backend.
   BACKEND: 'mock'     -> everything runs in the browser (localStorage), no network
            'supabase' -> real project; needs SUPABASE_URL + SUPABASE_ANON_KEY
   ALLOW_MOCK_SWITCH: when true, ?mock=1 forces the mock backend on any host (always allowed on localhost). */
window.SITE_CONFIG = {
  BACKEND: 'mock',
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
  SUPABASE_JS: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js',
  GOOGLE_ENABLED: false,
  ALLOW_MOCK_SWITCH: false,
  BUCKET: 'client-files',
  MAX_FILES: 5,
  MAX_FILE_MB: 10
};
