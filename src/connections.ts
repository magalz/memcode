import type { Harness } from "./shared";

export interface WorkerConnection {
  harness: Harness;
  approvedAt: string;
  runtimePath: string;
  auth: "authenticated" | "local";
  accountLabel?: string;
  scopeVersion: 1;
}
export interface WorkerConnectionStatus {
  harness: Harness;
  installed: boolean;
  connected: boolean;
  runtimePath: string | null;
  auth: "authenticated" | "not-authenticated" | "unknown" | "local";
  accountLabel?: string;
  approvedAt?: string;
  note: string;
  loginCommand: string;
}
export interface MemtracePrincipal {
  id: string;
  name: string;
  source: "memtrace";
}
export interface MemtraceAccount {
  status: "connected" | "needs-sign-in" | "unavailable" | "unknown";
  label: string;
  detail: string;
  checkedAt?: string;
  principal?: MemtracePrincipal;
  organizationId?: string;
  loginPending: boolean;
  claimUrl?: string;
}
