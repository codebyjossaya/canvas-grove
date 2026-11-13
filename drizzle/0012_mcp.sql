-- Grove MCP server: OAuth 2.1 clients/grants/codes and personal access tokens.
-- Only SHA-256 hashes of secrets are stored. mcp_clients is public registration metadata
-- (RFC 7591, public clients only) and has no owner; everything else is tenant-scoped.
CREATE TABLE "mcp_clients" (
	"client_id" text PRIMARY KEY,
	"client_name" text NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_clients_client_id_check" CHECK (char_length("client_id") <= 64),
	CONSTRAINT "mcp_clients_name_check" CHECK (char_length("client_name") <= 100),
	CONSTRAINT "mcp_clients_redirects_check" CHECK (cardinality("redirect_uris") BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "mcp_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"last_used_at" timestamptz,
	"revoked_at" timestamptz,
	CONSTRAINT "mcp_grants_owner_id_id_unique" UNIQUE ("owner_id", "id")
);
--> statement-breakpoint
CREATE TABLE "mcp_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"grant_id" uuid,
	"name" text,
	"secret_hash" text,
	"prefix" text,
	"scopes" text[] NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"expires_at" timestamptz,
	"last_used_at" timestamptz,
	"consumed_at" timestamptz,
	"revoked_at" timestamptz,
	CONSTRAINT "mcp_tokens_kind_check" CHECK ("kind" in ('pat', 'access', 'refresh')),
	CONSTRAINT "mcp_tokens_grant_check" CHECK (("kind" = 'pat') = ("grant_id" IS NULL)),
	CONSTRAINT "mcp_tokens_hash_check" CHECK ("secret_hash" IS NULL OR "secret_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "mcp_auth_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"resource" text,
	"scopes" text[] NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"expires_at" timestamptz NOT NULL,
	"used_at" timestamptz,
	CONSTRAINT "mcp_auth_codes_hash_check" CHECK ("code_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "mcp_grants" ADD CONSTRAINT "mcp_grants_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_grants" ADD CONSTRAINT "mcp_grants_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."mcp_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_tenant_grant_fk" FOREIGN KEY ("owner_id", "grant_id") REFERENCES "public"."mcp_grants"("owner_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_auth_codes" ADD CONSTRAINT "mcp_auth_codes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_auth_codes" ADD CONSTRAINT "mcp_auth_codes_tenant_grant_fk" FOREIGN KEY ("owner_id", "grant_id") REFERENCES "public"."mcp_grants"("owner_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_grants_active_client_idx" ON "mcp_grants" USING btree ("owner_id", "client_id") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "mcp_tokens_owner_kind_idx" ON "mcp_tokens" USING btree ("owner_id", "kind") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "mcp_tokens_grant_idx" ON "mcp_tokens" USING btree ("owner_id", "grant_id");--> statement-breakpoint
CREATE INDEX "mcp_tokens_expiry_idx" ON "mcp_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "mcp_auth_codes_owner_expiry_idx" ON "mcp_auth_codes" USING btree ("owner_id", "expires_at");--> statement-breakpoint
CREATE INDEX "mcp_auth_codes_grant_idx" ON "mcp_auth_codes" USING btree ("owner_id", "grant_id");--> statement-breakpoint
ALTER TABLE "mcp_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mcp_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "mcp_grants" USING (owner_id = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK (owner_id = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "mcp_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mcp_tokens" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "mcp_tokens" USING (owner_id = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK (owner_id = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "mcp_auth_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mcp_auth_codes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "mcp_auth_codes" USING (owner_id = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK (owner_id = nullif(current_setting('app.user_id', true), '')::uuid);
