// Development entry point. Production uses bundled dist-runtime/context-gateway.cjs.
import { register } from "tsx/esm/api";
register();
const { runContextGateway } = await import("../runtime/context/gateway.ts");
if (!process.argv[2])
  throw new Error("Provide a host-bound context-session.json");
await runContextGateway(process.argv[2]);
