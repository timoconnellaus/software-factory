-- Spike stubs for the hierarchy user → org → factory → project. Real columns come later.
create table "factory" (
  "id" text not null primary key,
  "organizationId" text not null references "organization" ("id") on delete cascade,
  "name" text not null,
  "createdBy" text not null references "user" ("id"),
  "createdAt" integer not null
);
create index "factory_organizationId_idx" on "factory" ("organizationId");

create table "project" (
  "id" text not null primary key,
  "factoryId" text not null references "factory" ("id") on delete cascade,
  "name" text not null,
  "repo" text,
  "createdBy" text not null references "user" ("id"),
  "createdAt" integer not null
);
create index "project_factoryId_idx" on "project" ("factoryId");
