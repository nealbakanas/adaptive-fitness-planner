// Where the cloud backup lives (Supabase). Both values are public by design: the publishable key only identifies the
// project, and row-level security (supabase/schema.sql) means a signed-in user can read and write only their own row.
// Test pages set globalThis.AFP_SUPABASE_URL to a fake address first, so no test can reach the real project.
export const SUPABASE_URL = globalThis.AFP_SUPABASE_URL ?? 'https://jbrhkhzgbkosqulfxohi.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_WAi266JaAgqsyr6Y3CXQdw_fB7ZwNvX';
