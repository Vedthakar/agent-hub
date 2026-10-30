import { SUPABASE_DB_URL, backend, supabaseReachable } from './db.js';

export default async function setup() {
  if (backend() !== 'supabase') {
    console.warn('[tests] HUB_TEST_DB=pglite: integration/e2e tests are running on embedded PGlite, not Supabase. RLS tests are skipped.');
    return;
  }
  if (!(await supabaseReachable())) {
    throw new Error(
      `Local Supabase is not reachable at ${SUPABASE_DB_URL.replace(/:[^:@/]+@/, ':***@')}.\n` +
        'Start it with `supabase start` (needs Docker/Colima), or run `npm run test:offline` to use embedded PGlite.',
    );
  }
}
