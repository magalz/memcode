import { randomUUID } from "node:crypto";
import type { ContextPack } from "./contracts";

export interface PendingPage {
  pack: ContextPack;
  offset: number;
  fingerprint: string;
  graph: string | null;
  expires: number;
}
/** Pack constraints first. A missing constraint always blocks acting and names a continuation. */
export function fitPack(
  full: ContextPack,
  budget: number,
  pending: Map<string, PendingPage>,
  offset = 0,
): ContextPack {
  const pack = structuredClone(full);
  const constraints = pack.constraints.slice(offset),
    evidence = pack.evidence;
  pack.constraints = [];
  pack.evidence = [];
  pack.candidates = pack.candidates.slice(0, 6);
  pack.coverage.constraintsRemaining = constraints.length;
  pack.coverage.continuation = undefined;
  const fits = () => JSON.stringify(pack).length < budget - 300;
  for (const c of constraints) {
    pack.constraints.push(c);
    pack.coverage.constraintsRemaining--;
    if (!fits()) {
      pack.constraints.pop();
      pack.coverage.constraintsRemaining++;
      break;
    }
  }
  if (pack.coverage.constraintsRemaining) {
    // A single giant rule is split literally across pages, with a clear part marker.
    if (!pack.constraints.length && constraints[0]) {
      const available = Math.max(
        200,
        budget - JSON.stringify(pack).length - 700,
      );
      const first = constraints[0];
      if (first.text.length > available) {
        pack.constraints.push({
          ...first,
          id: first.id + ":part",
          text: first.text.slice(0, available),
        });
        const rest = structuredClone(full);
        rest.constraints = [
          { ...first, text: first.text.slice(available) },
          ...constraints.slice(1),
        ];
        const token = randomUUID();
        pending.set(token, {
          pack: rest,
          offset: 0,
          fingerprint: full.revision.fingerprint,
          graph: full.revision.graph,
          expires: Date.now() + 300000,
        });
        pack.coverage.continuation = token;
      }
    }
    if (!pack.coverage.continuation) {
      const token = randomUUID();
      pending.set(token, {
        pack: full,
        offset: offset + pack.constraints.length,
        fingerprint: full.revision.fingerprint,
        graph: full.revision.graph,
        expires: Date.now() + 300000,
      });
      pack.coverage.continuation = token;
    }
    pack.coverage.status = "constraints-pending";
    pack.coverage.canAct = false;
    pack.coverage.truncated.push(
      "Essential constraints continue on the next page; read every page before acting.",
    );
  } else {
    for (const item of evidence) {
      pack.evidence.push(item);
      if (!fits()) {
        pack.evidence.pop();
        break;
      }
    }
    const omitted = evidence.length - pack.evidence.length;
    if (omitted) {
      pack.coverage.truncated.push(
        `${omitted} evidence items omitted by budget; narrow the target or increase budgetChars.`,
      );
      pack.coverage.status = "partial";
    }
  }
  // Metadata is bounded too; preserve explicit counts when the backend emits many errors.
  pack.coverage.unknown = pack.coverage.unknown
    .slice(0, 12)
    .map((s) => s.slice(0, 350));
  pack.coverage.truncated = pack.coverage.truncated
    .slice(0, 10)
    .map((s) => s.slice(0, 350));
  while (JSON.stringify(pack).length > budget - 100 && pack.evidence.length)
    pack.evidence.pop();
  if (JSON.stringify(pack).length > budget - 100) {
    pack.candidates = [];
    pack.coverage.unknown = pack.coverage.unknown.slice(0, 3);
    pack.coverage.truncated.push("Candidate metadata omitted by budget.");
  }
  pack.telemetry.responseChars = JSON.stringify(pack).length;
  pack.telemetry.estimatedTokens = Math.ceil(pack.telemetry.responseChars / 4);
  pack.telemetry.responseChars = JSON.stringify(pack).length;
  return pack;
}
