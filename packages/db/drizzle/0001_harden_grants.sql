-- Hardening pass over privileges Supabase grants by default. Found by
-- `supabase db advisors --linked` plus a direct catalogue audit; none of this is
-- reachable from the drizzle schema definition, so it has to live in a custom
-- migration. Everything here is idempotent and safe to re-run.
--
-- Design intent, restated: nothing reaches these tables except the owning
-- `postgres` role, which is what ingest connects as through the pooler. There is
-- no anon/authenticated/service_role access path by design — RLS with zero
-- policies was the first layer, this is the second, and the two cover different
-- things.

-- 1. TRUNCATE is the one that matters.
--
-- New Supabase projects set ALTER DEFAULT PRIVILEGES so that tables created by
-- `postgres` grant `Dxtm` — TRUNCATE, REFERENCES, TRIGGER, MAINTAIN — to anon,
-- authenticated and service_role. SELECT/INSERT/UPDATE/DELETE are correctly
-- withheld, and RLS would gate them anyway.
--
-- TRUNCATE is different: it is a table-level privilege that **RLS does not
-- restrict**. A policy-less table is not protected from it. There is no route to
-- it through PostgREST today, which is why the advisor rates this INFO/none
-- rather than a vulnerability — but the archive is the entire point of this
-- project and NYCHA publishes no history, so a wipe is unrecoverable by
-- definition. Deny it outright instead of relying on no route existing.
--
-- MAINTAIN (PG17) allows VACUUM/ANALYZE/REINDEX/CLUSTER/REFRESH. Harmless in
-- itself, revoked for tidiness. REFERENCES and TRIGGER let a grantee attach
-- foreign keys and triggers to our tables; also unnecessary.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated, service_role;
--> statement-breakpoint

-- Sequences and functions are already clean under the `postgres` grantor
-- defaults, but revoke unconditionally so a future object cannot inherit
-- something wider.
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated, service_role;
--> statement-breakpoint

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;
--> statement-breakpoint

-- 2. Stop future tables inheriting the same grants.
--
-- Scoped `FOR ROLE postgres` because default privileges are per-creating-role
-- and every table here is created by `postgres` via drizzle-kit. The parallel
-- `supabase_admin` defaults (which grant the full `arwdDxtm`) cannot be altered
-- from this role and are deliberately left alone: they only apply to objects
-- created by the platform itself, and RLS still covers those.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
--> statement-breakpoint

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
--> statement-breakpoint

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;
--> statement-breakpoint

-- 3. The anon-executable SECURITY DEFINER function.
--
-- `public.rls_auto_enable()` is not ours — it is the platform's `ensure_rls`
-- event trigger, which enables RLS on any new table in `public`. It is owned by
-- `postgres`, is SECURITY DEFINER, and was created with a NULL ACL, which in
-- Postgres means EXECUTE to PUBLIC. Supabase's advisor flags it at WARN twice:
-- callable by `anon` and by `authenticated` via /rest/v1/rpc/.
--
-- Practically it is inert — its body calls pg_event_trigger_ddl_commands(),
-- which errors outside an event-trigger context, and its return type cannot be
-- serialised by PostgREST. Revoked anyway: a SECURITY DEFINER function owned by
-- `postgres` and executable by the anonymous role is not a thing to leave in
-- place on the basis that today's call path happens to fail.
--
-- Revoking EXECUTE does not stop the event trigger. Event triggers fire as their
-- owner and are not subject to an EXECUTE privilege check, so `ensure_rls` keeps
-- working — verified after applying this migration.
--
-- Guarded by a catalogue lookup so the migration still applies against a project
-- where the platform has renamed or dropped it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'rls_auto_enable'
  ) THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated, service_role';
  END IF;
END $$;
