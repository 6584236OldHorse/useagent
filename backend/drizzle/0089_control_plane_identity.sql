-- fast-deploy: expansion-safe
ALTER TABLE "user" ADD COLUMN "clerk_user_id" text;
CREATE UNIQUE INDEX "user_clerk_user_id_unique" ON "user" ("clerk_user_id");
ALTER TABLE "organization" ADD COLUMN "clerk_org_id" text;
CREATE UNIQUE INDEX "organization_clerk_org_id_unique" ON "organization" ("clerk_org_id");
CREATE UNIQUE INDEX "member_organization_user_unique" ON "member" ("organization_id", "user_id");
