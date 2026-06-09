// ============================================================
//  Leo Tracker — Supabase connection settings
// ============================================================
// These two values tell the app WHICH Supabase project to talk to.
//
// They are PUBLIC and safe to ship on the open web. The "anon key" only
// works together with (a) a valid family login and (b) the Row Level
// Security rules in schema.sql. Without a login, it can't read or write
// anything. The *secret* "service_role" key is a different thing — it
// NEVER goes in here or anywhere in the app.
//
// HOW TO FILL THESE IN:
//   Supabase dashboard → Project Settings → API
//     • "Project URL"      → SUPABASE_URL below
//     • "anon public" key  → SUPABASE_ANON_KEY below
// ============================================================

window.LEO_CONFIG = {
  SUPABASE_URL: "https://tgyhsbefshvnxqxgkcqx.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable__lsNB1D20vqIslS_fkDJxQ_PzepHdI0",

  // Web Push public key (base64url) — PUBLIC, safe to ship. Generate a VAPID
  // keypair (see README "Background push"); paste the PUBLIC key here and set
  // the PRIVATE key as a Supabase secret for the wake-watch function.
  VAPID_PUBLIC_KEY: "PASTE_VAPID_PUBLIC_KEY",
};
