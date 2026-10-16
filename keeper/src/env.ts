// Imported first so process.env is populated before the shared contract config reads it.
import { existsSync } from "node:fs";

for (const f of [".env", "../web/.env.local", "../web/.env"]) {
  if (existsSync(f)) process.loadEnvFile(f);
}
