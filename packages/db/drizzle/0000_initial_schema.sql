CREATE TABLE "category_summary" (
	"snapshot_id" bigint NOT NULL,
	"category" text NOT NULL,
	"is_planned" boolean NOT NULL,
	"as_of_raw" text,
	"interruptions" integer,
	"developments" integer,
	"buildings" integer,
	"units" integer,
	"residents" integer,
	CONSTRAINT "category_summary_snapshot_id_category_is_planned_pk" PRIMARY KEY("snapshot_id","category","is_planned"),
	CONSTRAINT "category_summary_category_check" CHECK ("category" in ('heat_hot_water', 'elevator', 'electric', 'gas'))
);
--> statement-breakpoint
ALTER TABLE "category_summary" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "observation_child" (
	"observation_id" bigint NOT NULL,
	"ordinal" smallint NOT NULL,
	"building_raw" text,
	"address_raw" text,
	"buildings" integer,
	"units" integer,
	"residents" integer,
	CONSTRAINT "observation_child_observation_id_ordinal_pk" PRIMARY KEY("observation_id","ordinal")
);
--> statement-breakpoint
ALTER TABLE "observation_child" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "observation_service" (
	"observation_id" bigint NOT NULL,
	"service" text NOT NULL,
	"is_planned" boolean,
	"is_partial_service" boolean,
	CONSTRAINT "observation_service_observation_id_service_pk" PRIMARY KEY("observation_id","service"),
	CONSTRAINT "observation_service_service_check" CHECK ("service" in ('heat', 'hot_water', 'water', 'elevator', 'electric', 'gas'))
);
--> statement-breakpoint
ALTER TABLE "observation_service" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "outage_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"identity_hash" char(64) NOT NULL,
	"category" text NOT NULL,
	"sub_table" text NOT NULL,
	"development_raw" text NOT NULL,
	"building_raw" text,
	"address_raw" text,
	"borough_raw" text,
	"scheduled_date_raw" text,
	"report_date_raw" text,
	"scope_level" text NOT NULL,
	"is_sectional" boolean NOT NULL,
	"services_key" text NOT NULL,
	"first_seen_snapshot_id" bigint NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_snapshot_id" bigint NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "outage_event_category_check" CHECK ("category" in ('heat_hot_water', 'elevator', 'electric', 'gas')),
	CONSTRAINT "outage_event_sub_table_check" CHECK ("sub_table" in ('current', 'restored_24h', 'upcoming_planned', 'rehab', 'gas_current')),
	CONSTRAINT "outage_event_scope_level_check" CHECK ("scope_level" in ('entire_development', 'building', 'sectional', 'unspecified'))
);
--> statement-breakpoint
ALTER TABLE "outage_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "outage_observation" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" bigint NOT NULL,
	"content_hash" char(64) NOT NULL,
	"is_present" boolean DEFAULT true NOT NULL,
	"first_seen_snapshot_id" bigint NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_snapshot_id" bigint NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"address_displayed" boolean NOT NULL,
	"status" text,
	"restoration_hours" integer,
	"location_raw" text,
	"impact_buildings" integer,
	"impact_units" integer,
	"impact_residents" integer,
	"impact_source" text NOT NULL,
	"row_index" integer NOT NULL,
	"parser_version" text NOT NULL,
	CONSTRAINT "outage_observation_impact_source_check" CHECK ("impact_source" in ('row', 'children_rollup', 'missing')),
	CONSTRAINT "outage_observation_restoration_hours_check" CHECK ("restoration_hours" >= 0)
);
--> statement-breakpoint
ALTER TABLE "outage_observation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "review_queue" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"snapshot_id" bigint NOT NULL,
	"reason" text NOT NULL,
	"detail" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_queue" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "snapshot" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"url" text NOT NULL,
	"http_status" smallint NOT NULL,
	"attempts" smallint NOT NULL,
	"sha256" char(64) NOT NULL,
	"storage_key" text,
	"stored_bytes" integer,
	"retain_until" timestamp with time zone,
	"raw_discarded_at" timestamp with time zone,
	"counts_matched" boolean NOT NULL,
	"parser_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "snapshot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "snapshot_count" (
	"snapshot_id" bigint NOT NULL,
	"category" text NOT NULL,
	"sub_table" text NOT NULL,
	"declared" integer,
	"parsed" integer NOT NULL,
	CONSTRAINT "snapshot_count_snapshot_id_category_sub_table_pk" PRIMARY KEY("snapshot_id","category","sub_table"),
	CONSTRAINT "snapshot_count_category_check" CHECK ("category" in ('heat_hot_water', 'elevator', 'electric', 'gas')),
	CONSTRAINT "snapshot_count_sub_table_check" CHECK ("sub_table" in ('current', 'restored_24h', 'upcoming_planned', 'rehab', 'gas_current'))
);
--> statement-breakpoint
ALTER TABLE "snapshot_count" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "category_summary" ADD CONSTRAINT "category_summary_snapshot_id_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_child" ADD CONSTRAINT "observation_child_observation_id_outage_observation_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."outage_observation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_service" ADD CONSTRAINT "observation_service_observation_id_outage_observation_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."outage_observation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outage_event" ADD CONSTRAINT "outage_event_first_seen_snapshot_id_snapshot_id_fk" FOREIGN KEY ("first_seen_snapshot_id") REFERENCES "public"."snapshot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outage_event" ADD CONSTRAINT "outage_event_last_seen_snapshot_id_snapshot_id_fk" FOREIGN KEY ("last_seen_snapshot_id") REFERENCES "public"."snapshot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outage_observation" ADD CONSTRAINT "outage_observation_event_id_outage_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."outage_event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outage_observation" ADD CONSTRAINT "outage_observation_first_seen_snapshot_id_snapshot_id_fk" FOREIGN KEY ("first_seen_snapshot_id") REFERENCES "public"."snapshot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outage_observation" ADD CONSTRAINT "outage_observation_last_seen_snapshot_id_snapshot_id_fk" FOREIGN KEY ("last_seen_snapshot_id") REFERENCES "public"."snapshot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_queue" ADD CONSTRAINT "review_queue_snapshot_id_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_count" ADD CONSTRAINT "snapshot_count_snapshot_id_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "observation_service_service_idx" ON "observation_service" USING btree ("service");--> statement-breakpoint
CREATE UNIQUE INDEX "outage_event_identity_hash_key" ON "outage_event" USING btree ("identity_hash");--> statement-breakpoint
CREATE INDEX "outage_event_place_idx" ON "outage_event" USING btree ("category","development_raw","building_raw");--> statement-breakpoint
CREATE INDEX "outage_event_last_seen_idx" ON "outage_event" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "outage_observation_event_idx" ON "outage_observation" USING btree ("event_id","first_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outage_observation_event_content_idx" ON "outage_observation" USING btree ("event_id","content_hash","first_seen_at");--> statement-breakpoint
CREATE INDEX "outage_observation_present_idx" ON "outage_observation" USING btree ("event_id") WHERE "outage_observation"."is_present";--> statement-breakpoint
CREATE INDEX "review_queue_unresolved_idx" ON "review_queue" USING btree ("snapshot_id") WHERE "review_queue"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "snapshot_fetched_at_idx" ON "snapshot" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX "snapshot_sha256_idx" ON "snapshot" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "snapshot_sweep_idx" ON "snapshot" USING btree ("retain_until") WHERE "snapshot"."raw_discarded_at" is null and "snapshot"."retain_until" is not null;