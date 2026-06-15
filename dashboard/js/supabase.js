// ── Supabase client ──────────────────────────────────
// Replace these two values with your own from:
// Supabase Dashboard → Settings → API
const SUPABASE_URL  = 'https://droqokuoocckdnqashpi.supabase.co'
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRyb3Fva3Vvb2Nja2RucWFzaHBpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4MDExNzgsImV4cCI6MjA5NTM3NzE3OH0.0ykwAsNrPGSBr0t1151S8U2o3lHhNDXWBdprlpIRcVo'

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON)
