import { runContextGateway } from "./gateway";
const config = process.argv[2];
if (!config) throw new Error("Usage: context-gateway.cjs <host-session.json>");
runContextGateway(config).catch((error) => {
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
});
