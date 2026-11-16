import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
const require = createRequire(import.meta.url);
const { startTeamRelay } = require("../dist-runtime/team-relay.cjs");
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const relay = await startTeamRelay({
  dataDir: resolve(option("--data-dir") ?? join(homedir(), ".memcode", "team-relay")),
  ...(option("--port") ? { port: Number(option("--port")) } : {}),
  ...(option("--host") ? { host: option("--host") } : {}),
  ...(option("--advertise-url")
    ? { advertisedUrl: option("--advertise-url") }
    : {}),
  ...(args.includes("--self-service-teams") ? { selfServiceTeams: true } : {}),
  ...(option("--max-teams-per-account") ? { maxTeamsPerAccount: Number(option("--max-teams-per-account")) } : {}),
});
console.log(`Private Team Sync preview listening at ${relay.url}`);
console.log(
  `Service administration is stored locally in ${relay.adminFile}. Named team members sign in with Memtrace; legacy preview invitations use separate access.`,
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void relay.close().then(() => process.exit(0));
  });
