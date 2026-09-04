import { defineConfig, UnderscoreNamingStrategy } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { ALL_ENTITIES } from "./entities";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://wager:wager@localhost:5432/wager";

export default defineConfig({
  clientUrl: databaseUrl,
  entities: [...ALL_ENTITIES],
  namingStrategy: UnderscoreNamingStrategy,
  forceUtcTimezone: true,
  // O domínio nunca vê campos `undefined` como `null`; mantê-los explícitos.
  forceUndefined: true,
  debug: process.env.MIKRO_ORM_DEBUG === "true",
  pool: {
    min: Number(process.env.DB_POOL_MIN ?? 2),
    max: Number(process.env.DB_POOL_MAX ?? 10),
  },
  extensions: [Migrator],
  migrations: {
    tableName: "mikro_orm_migrations",
    path: "dist/infrastructure/persistence/mikro-orm/migrations",
    pathTs: "src/infrastructure/persistence/mikro-orm/migrations",
    glob: "!(*.d).{js,ts}",
    transactional: true,
    disableForeignKeys: false,
    allOrNothing: true,
    snapshot: false,
  },
});
