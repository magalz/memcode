import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  truncate,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type {
  TeamCredential,
  TeamEvent,
  TeamMember,
  TeamSessionReply,
  TeamSnapshot,
  TeamSyncReply,
} from "../../src/team";
import {
  applyTeamEvent,
  emptyTeamSnapshot,
  executeTeamCommand,
  TeamProtocolError,
  teamCommandSchema,
  teamEvent,
  teamId,
  teamSnapshotSchema,
} from "./protocol";

type Actor = { memberId: string; deviceId: string };
type RecordEntry =
  | {
      kind: "create";
      snapshot: TeamSnapshot;
      credentialHash: string;
      actor: Actor;
    }
  | { kind: "invite"; hash: string; expiresAt: string }
  | {
      kind: "join";
      invitationHash: string;
      credentialHash: string;
      actor: Actor;
      event: TeamEvent;
    }
  | { kind: "command"; dedup: string; commandHash: string; event: TeamEvent };
interface Room {
  snapshot: TeamSnapshot;
  events: TeamEvent[];
  credentials: Map<string, Actor>;
  invitations: Map<string, { expiresAt: string; used: boolean }>;
  operations: Map<string, { commandHash: string; event: TeamEvent }>;
  pending: Promise<unknown>;
  waiters: Set<() => void>;
}
export interface TeamRelayOptions {
  dataDir: string;
  host?: string;
  port?: number;
  /** Explicit endpoint teammates can reach; requires a trusted network or TLS gateway. */
  advertisedUrl?: string;
  adminCapability?: string;
  /** Acceptance-test hook after durable commit and before HTTP acknowledgement. */
  afterCommit?: (event: TeamEvent) => void | Promise<void>;
}
export interface TeamRelay {
  url: string;
  adminCapability: string;
  adminFile: string;
  readyFile: string;
  close(): Promise<void>;
}
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const label = z.string().trim().min(1).max(160);
const participant = { memberName: label, deviceId: teamId, deviceName: label };
const createSchema = z.object({ name: label, ...participant }).strict();
const joinSchema = z
  .object({
    workspaceId: teamId,
    invitation: z.string().min(32).max(200),
    ...participant,
  })
  .strict();
const inviteSchema = z
  .object({ workspaceId: teamId, role: z.literal("editor").default("editor") })
  .strict();
const commandSchema = z
  .object({ workspaceId: teamId, opId: teamId, command: teamCommandSchema })
  .strict();
const MAX_BLOB = 5 * 1024 * 1024;
const error = (
  code: string,
  message: string,
  status = 400,
  details?: unknown,
): never => {
  throw new TeamProtocolError(code, message, details, status);
};

async function durableFile(path: string, content: string | Buffer) {
  const temporary = path + ".next";
  const file = await open(temporary, "w", 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}
async function body(request: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit)
      error(
        "PAYLOAD_TOO_LARGE",
        "This upload exceeds the preview size limit.",
        413,
      );
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
async function json(request: IncomingMessage) {
  try {
    return JSON.parse((await body(request, 256 * 1024)).toString("utf8"));
  } catch (failure) {
    if (failure instanceof TeamProtocolError) throw failure;
    return error("JSON", "Send a valid JSON request.");
  }
}
function reply(response: ServerResponse, status: number, value: unknown) {
  if (response.destroyed) return;
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}
function applyRecord(room: Room, record: RecordEntry) {
  if (record.kind === "invite")
    room.invitations.set(record.hash, {
      expiresAt: record.expiresAt,
      used: false,
    });
  if (record.kind === "join") {
    const invitation = room.invitations.get(record.invitationHash);
    if (!invitation)
      throw Error("Team journal contains an unknown invitation.");
    invitation.used = true;
    room.credentials.set(record.credentialHash, record.actor);
    room.snapshot = applyTeamEvent(room.snapshot, record.event);
    room.events.push(record.event);
  }
  if (record.kind === "command") {
    room.operations.set(record.dedup, {
      commandHash: record.commandHash,
      event: record.event,
    });
    room.snapshot = applyTeamEvent(room.snapshot, record.event);
    room.events.push(record.event);
  }
}
function roomFrom(record: Extract<RecordEntry, { kind: "create" }>): Room {
  return {
    snapshot: teamSnapshotSchema.parse(record.snapshot),
    events: [],
    credentials: new Map([[record.credentialHash, record.actor]]),
    invitations: new Map(),
    operations: new Map(),
    pending: Promise.resolve(),
    waiters: new Set(),
  };
}

/** A private, invite-capability preview relay. It never opens a project or starts an agent. */
export async function startTeamRelay(
  options: TeamRelayOptions,
): Promise<TeamRelay> {
  const host = options.host ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "0.0.0.0"].includes(host))
    throw Error(
      "Bind the Team relay to loopback or explicitly to 0.0.0.0 for a private-network pilot.",
    );
  const advertised = options.advertisedUrl
    ? new URL(options.advertisedUrl)
    : undefined;
  if (
    advertised &&
    (!["http:", "https:"].includes(advertised.protocol) ||
      advertised.username ||
      advertised.password ||
      advertised.pathname !== "/" ||
      advertised.search ||
      advertised.hash)
  )
    throw Error("Use a plain HTTP(S) origin as the advertised Team endpoint.");
  if (host === "0.0.0.0" && !advertised)
    throw Error(
      "An explicit advertisedUrl is required when sharing the relay on a private network.",
    );
  const allowedHosts = new Set([
    "127.0.0.1",
    "[::1]",
    "localhost",
    ...(advertised ? [advertised.hostname] : []),
  ]);
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
  const roomsDir = join(options.dataDir, "workspaces");
  await mkdir(roomsDir, { recursive: true, mode: 0o700 });
  const adminFile = join(options.dataDir, "admin.private.json"),
    readyFile = join(options.dataDir, "ready.private.json"),
    lockFile = join(options.dataDir, "relay.lock");
  const lockNonce = randomUUID();
  for (let attempt = 0; ; attempt++) {
    try {
      const lock = await open(lockFile, "wx", 0o600);
      await lock.writeFile(
        JSON.stringify({ pid: process.pid, nonce: lockNonce }),
      );
      await lock.close();
      break;
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== "EEXIST" || attempt)
        throw Error("This private Team relay profile is already open.", {
          cause: failure,
        });
      const prior = JSON.parse(await readFile(lockFile, "utf8")) as {
        pid: number;
      };
      try {
        process.kill(prior.pid, 0);
        throw Error("This private Team relay profile is already open.");
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
        await unlink(lockFile);
      }
    }
  }
  let adminCapability = options.adminCapability;
  const rooms = new Map<string, Room>();
  let closing = false;
  const releaseLock = async () => {
    try {
      const current = JSON.parse(await readFile(lockFile, "utf8"));
      if (current.nonce === lockNonce) await unlink(lockFile);
    } catch {}
  };
  try {
    if (!adminCapability) {
      try {
        adminCapability = JSON.parse(
          await readFile(adminFile, "utf8"),
        ).capability;
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
      }
    }
    adminCapability ??= secret();
    if (!/^[A-Za-z0-9_-]{32,200}$/.test(adminCapability))
      throw Error("Invalid private relay setup capability.");
    await durableFile(
      adminFile,
      JSON.stringify({ capability: adminCapability }),
    );
    for (const item of await readdir(roomsDir, { withFileTypes: true })) {
      if (!item.isFile() || !/^[a-f0-9-]{36}\.jsonl$/.test(item.name)) continue;
      const path = join(roomsDir, item.name),
        content = await readFile(path, "utf8");
      const boundary = content.lastIndexOf("\n");
      if (boundary !== content.length - 1)
        await truncate(path, Buffer.byteLength(content.slice(0, boundary + 1)));
      const records = content
        .slice(0, boundary + 1)
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RecordEntry);
      if (!records.length || records[0].kind !== "create")
        throw Error("Team workspace journal is incomplete.");
      const first = records[0],
        room = roomFrom(first);
      if (first.snapshot.workspaceId + ".jsonl" !== item.name)
        throw Error("Team workspace journal identity mismatch.");
      for (const record of records.slice(1)) {
        if (record.kind === "create")
          throw Error("Duplicate Team workspace creation.");
        applyRecord(room, record);
      }
      rooms.set(room.snapshot.workspaceId, room);
    }
    const append = async (workspaceId: string, record: RecordEntry) => {
      const file = await open(
        join(roomsDir, workspaceId + ".jsonl"),
        "a",
        0o600,
      );
      try {
        await file.writeFile(JSON.stringify(record) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
    };
    const checkpoint = async (room: Room) => {
      try {
        await durableFile(
          join(roomsDir, room.snapshot.workspaceId + ".snapshot.json"),
          JSON.stringify(room.snapshot),
        );
      } catch {
        /* The fsynced journal remains authoritative. */
      }
    };
    const serialized = <T>(
      room: Room,
      action: () => Promise<T>,
    ): Promise<T> => {
      const task = room.pending.catch(() => {}).then(action);
      room.pending = task;
      return task;
    };
    const commit = async (
      room: Room,
      record: Exclude<RecordEntry, { kind: "create" }>,
    ) => {
      await append(room.snapshot.workspaceId, record);
      applyRecord(room, record);
      await checkpoint(room);
      for (const wake of [...room.waiters]) wake();
    };
    const roomFor = (workspaceId: string) =>
      rooms.get(workspaceId) ?? error("NOT_FOUND", "Workspace not found.", 404);
    const bearer = (request: IncomingMessage) => {
      const value = request.headers.authorization;
      if (!value?.startsWith("Bearer "))
        return error("AUTH", "A private Team capability is required.", 401);
      return value.slice(7);
    };
    const authenticate = (request: IncomingMessage, workspaceId: string) => {
      const token = bearer(request),
        room = roomFor(workspaceId),
        actor = room.credentials.get(digest(token));
      if (!actor)
        return error(
          "AUTH",
          "This capability cannot access this workspace.",
          403,
        );
      return { room, actor };
    };
    const memberFor = (room: Room, actor: Actor) =>
      room.snapshot.members.find((item) => item.id === actor.memberId) ??
      error("AUTH", "Workspace membership is unavailable.", 403);
    const blobsDir = (workspaceId: string) =>
      join(roomsDir, workspaceId + ".blobs");
    const blobMeta = async (workspaceId: string, hash: string) => {
      if (!/^[a-f0-9]{64}$/.test(hash))
        return error("HASH", "Invalid result content hash.");
      try {
        return JSON.parse(
          await readFile(join(blobsDir(workspaceId), hash + ".json"), "utf8"),
        ) as {
          hash: string;
          size: number;
          mime: string;
          memberId: string;
          uploaders?: string[];
        };
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code === "ENOENT")
          return error(
            "NOT_FOUND",
            "Upload this result's content before publishing it.",
            404,
          );
        throw failure;
      }
    };
    const server = createServer(async (request, response) => {
      try {
        if (closing) return error("CLOSED", "The Team relay is closing.", 503);
        if (request.headers.origin)
          return error(
            "ORIGIN",
            "Use the private MemCode runtime client for Team Sync.",
            403,
          );
        const url = new URL(
          request.url ?? "/",
          `http://${request.headers.host ?? "127.0.0.1"}`,
        );
        if (!allowedHosts.has(url.hostname))
          return error("HOST", "Unrecognized relay host.", 403);
        if (request.method === "POST" && url.pathname === "/v1/workspaces") {
          if (digest(bearer(request)) !== digest(adminCapability!))
            return error(
              "AUTH",
              "The private relay setup capability is required.",
              403,
            );
          const input = createSchema.parse(await json(request));
          if (rooms.size >= 100)
            return error(
              "LIMIT",
              "This relay has reached its preview workspace limit.",
              409,
            );
          const workspaceId = randomUUID(),
            memberId = randomUUID(),
            capability = secret(),
            at = new Date().toISOString();
          const member: TeamMember = {
            id: memberId,
            name: input.memberName,
            role: "owner",
            devices: [{ id: input.deviceId, name: input.deviceName }],
            joinedAt: at,
          };
          const actor = { memberId, deviceId: input.deviceId },
            snapshot = emptyTeamSnapshot(workspaceId, input.name, member),
            record: RecordEntry = {
              kind: "create",
              snapshot,
              credentialHash: digest(capability),
              actor,
            };
          await append(workspaceId, record);
          const room = roomFrom(record);
          rooms.set(workspaceId, room);
          await checkpoint(room);
          return reply(response, 201, {
            credential: {
              workspaceId,
              memberId,
              deviceId: input.deviceId,
              capability,
            },
            snapshot: room.snapshot,
            identity: "invite-preview",
          } satisfies TeamSessionReply);
        }
        if (request.method === "POST" && url.pathname === "/v1/invites") {
          const input = inviteSchema.parse(await json(request)),
            { room, actor } = authenticate(request, input.workspaceId);
          if (memberFor(room, actor).role !== "owner")
            return error(
              "FORBIDDEN",
              "Only a workspace owner can create invitations.",
              403,
            );
          return await serialized(room, async () => {
            if (
              [...room.invitations.values()].filter(
                (item) => !item.used && Date.parse(item.expiresAt) > Date.now(),
              ).length >= 100
            )
              return error(
                "LIMIT",
                "Use or expire an existing invitation first.",
                409,
              );
            const invitation = secret(),
              expiresAt = new Date(
                Date.now() + 24 * 60 * 60 * 1000,
              ).toISOString();
            await commit(room, {
              kind: "invite",
              hash: digest(invitation),
              expiresAt,
            });
            return reply(response, 201, {
              workspaceId: input.workspaceId,
              invitation,
              expiresAt,
            });
          });
        }
        if (request.method === "POST" && url.pathname === "/v1/join") {
          const input = joinSchema.parse(await json(request)),
            room = roomFor(input.workspaceId);
          return await serialized(room, async () => {
            const hash = digest(input.invitation),
              invitation = room.invitations.get(hash);
            if (
              !invitation ||
              invitation.used ||
              Date.parse(invitation.expiresAt) <= Date.now()
            )
              return error(
                "INVITE",
                "This invitation is expired or has already been used.",
                403,
              );
            if (room.snapshot.members.length >= 100)
              return error(
                "LIMIT",
                "This workspace has reached its preview member limit.",
                409,
              );
            const capability = secret(),
              memberId = randomUUID(),
              at = new Date().toISOString(),
              actor = { memberId, deviceId: input.deviceId };
            const member: TeamMember = {
              id: memberId,
              name: input.memberName,
              role: "editor",
              devices: [{ id: input.deviceId, name: input.deviceName }],
              joinedAt: at,
            };
            const event = teamEvent(
              room.snapshot,
              actor,
              randomUUID(),
              at,
              [{ collection: "members", id: memberId, value: member }],
              `${member.name} joined the workspace`,
              "member.joined",
              memberId,
            );
            await commit(room, {
              kind: "join",
              invitationHash: hash,
              credentialHash: digest(capability),
              actor,
              event,
            });
            return reply(response, 200, {
              credential: {
                workspaceId: input.workspaceId,
                memberId,
                deviceId: input.deviceId,
                capability,
              },
              snapshot: room.snapshot,
              identity: "invite-preview",
            } satisfies TeamSessionReply);
          });
        }
        if (request.method === "GET" && url.pathname === "/v1/sync") {
          const workspaceId = teamId.parse(url.searchParams.get("workspaceId")),
            { room } = authenticate(request, workspaceId);
          const after = Number(url.searchParams.get("after") ?? 0),
            waitMs = Math.min(
              25000,
              Math.max(0, Number(url.searchParams.get("waitMs") ?? 0)),
            );
          if (
            !Number.isSafeInteger(after) ||
            after < 0 ||
            !Number.isFinite(waitMs)
          )
            return error("CURSOR", "Invalid synchronization cursor.");
          if (after > room.snapshot.head)
            return error(
              "CURSOR",
              "This cursor is ahead of the workspace. Reconnect from a snapshot.",
              409,
            );
          if (after === room.snapshot.head && waitMs)
            await new Promise<void>((resolve) => {
              if (room.waiters.size >= 100)
                return error("LIMIT", "Too many waiting connections.", 429);
              let timer: ReturnType<typeof setTimeout>;
              const wake = () => {
                clearTimeout(timer);
                room.waiters.delete(wake);
                response.off("close", wake);
                resolve();
              };
              room.waiters.add(wake);
              response.once("close", wake);
              timer = setTimeout(wake, waitMs);
              timer.unref();
            });
          if (response.destroyed) return;
          if (closing)
            return error("CLOSED", "The Team relay is closing.", 503);
          const events =
            after === 0
              ? []
              : room.events
                  .filter((item) => item.sequence > after)
                  .slice(0, 100);
          const cursor =
            after === 0
              ? room.snapshot.head
              : (events.at(-1)?.sequence ?? after);
          return reply(response, 200, {
            version: 1,
            ...(after === 0 ? { snapshot: room.snapshot } : {}),
            events,
            head: room.snapshot.head,
            cursor,
            hasMore: cursor < room.snapshot.head,
          } satisfies TeamSyncReply);
        }
        if (request.method === "POST" && url.pathname === "/v1/commands") {
          const input = commandSchema.parse(await json(request)),
            { room, actor } = authenticate(request, input.workspaceId);
          return await serialized(room, async () => {
            const key = `${actor.memberId}/${actor.deviceId}/${input.opId}`,
              hash = digest(JSON.stringify(input.command)),
              prior = room.operations.get(key);
            if (prior) {
              if (prior.commandHash !== hash)
                return error(
                  "OP_ID_REUSE",
                  "This operation ID was already used for a different command.",
                  409,
                );
              return reply(response, 200, {
                event: prior.event,
                replayed: true,
              });
            }
            if (input.command.type === "result.publish") {
              const metadata = await blobMeta(
                input.workspaceId,
                input.command.result.hash,
              );
              if (
                metadata.size !== input.command.result.size ||
                metadata.mime !== input.command.result.mime
              )
                return error(
                  "BLOB",
                  "The uploaded result does not match its published metadata.",
                  409,
                );
              if (
                ![metadata.memberId, ...(metadata.uploaders ?? [])].includes(
                  actor.memberId,
                ) &&
                !room.snapshot.results.some(
                  (item) => item.hash === metadata.hash,
                )
              )
                return error(
                  "FORBIDDEN",
                  "Upload this result's content before publishing it.",
                  403,
                );
            }
            const event = executeTeamCommand(
              room.snapshot,
              actor,
              input.command,
              input.opId,
              new Date().toISOString(),
            );
            await commit(room, {
              kind: "command",
              dedup: key,
              commandHash: hash,
              event,
            });
            await options.afterCommit?.(event);
            return reply(response, 200, { event, replayed: false });
          });
        }
        if (request.method === "POST" && url.pathname === "/v1/blobs") {
          const workspaceId = teamId.parse(url.searchParams.get("workspaceId")),
            { room, actor } = authenticate(request, workspaceId);
          const bytes = await body(request, MAX_BLOB),
            hash = digest(bytes),
            requestedHash = request.headers["x-content-sha256"],
            mime = String(
              request.headers["content-type"] ?? "application/octet-stream",
            ).split(";")[0];
          if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime) || mime.length > 100)
            return error("MIME", "Invalid result media type.");
          if (requestedHash && requestedHash !== hash)
            return error(
              "HASH",
              "The upload does not match its content hash.",
              409,
            );
          await serialized(room, async () => {
            const directory = blobsDir(workspaceId);
            await mkdir(directory, { recursive: true, mode: 0o700 });
            let existing: Awaited<ReturnType<typeof blobMeta>> | undefined;
            try {
              existing = await blobMeta(workspaceId, hash);
            } catch (failure) {
              if (
                !(failure instanceof TeamProtocolError) ||
                failure.code !== "NOT_FOUND"
              )
                throw failure;
            }
            if (existing) {
              if (existing.mime !== mime || existing.size !== bytes.length)
                return error(
                  "BLOB",
                  "This content hash already has a different media type.",
                  409,
                );
              await durableFile(
                join(directory, hash + ".json"),
                JSON.stringify({
                  ...existing,
                  uploaders: [
                    ...new Set([...(existing.uploaders ?? []), actor.memberId]),
                  ],
                }),
              );
              return;
            }
            const metadataFiles = (await readdir(directory)).filter((name) =>
              /^[a-f0-9]{64}\.json$/.test(name),
            );
            const metadata = await Promise.all(
              metadataFiles.map(
                async (name) =>
                  JSON.parse(await readFile(join(directory, name), "utf8")) as {
                    size: number;
                  },
              ),
            );
            if (
              metadata.length >= 1000 ||
              metadata.reduce((sum, item) => sum + item.size, 0) +
                bytes.length >
                50 * 1024 * 1024
            )
              return error(
                "LIMIT",
                "This workspace has reached its 50 MiB shared-output preview limit.",
                409,
              );
            await durableFile(join(directory, hash + ".bin"), bytes);
            await durableFile(
              join(directory, hash + ".json"),
              JSON.stringify({
                hash,
                size: bytes.length,
                mime,
                memberId: actor.memberId,
              }),
            );
          });
          return reply(response, 201, { hash, size: bytes.length, mime });
        }
        const blob = /^\/v1\/blobs\/([a-f0-9]{64})$/.exec(url.pathname);
        if (request.method === "GET" && blob) {
          const workspaceId = teamId.parse(url.searchParams.get("workspaceId")),
            { room, actor } = authenticate(request, workspaceId),
            metadata = await blobMeta(workspaceId, blob[1]);
          if (
            ![metadata.memberId, ...(metadata.uploaders ?? [])].includes(
              actor.memberId,
            ) &&
            !room.snapshot.results.some((item) => item.hash === blob[1])
          )
            return error(
              "FORBIDDEN",
              "This result has not been published.",
              403,
            );
          const bytes = await readFile(
            join(blobsDir(workspaceId), blob[1] + ".bin"),
          );
          if (digest(bytes) !== metadata.hash || bytes.length !== metadata.size)
            return error(
              "BLOB",
              "The saved result failed its content-integrity check.",
              500,
            );
          response.writeHead(200, {
            "content-type": metadata.mime,
            "content-length": bytes.length,
            "content-disposition": "attachment",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          response.end(bytes);
          return;
        }
        return error("NOT_FOUND", "Team endpoint not found.", 404);
      } catch (failure) {
        if (failure instanceof TeamProtocolError)
          reply(response, failure.status, {
            error: {
              code: failure.code,
              message: failure.message,
              ...(failure.details ? { details: failure.details } : {}),
            },
          });
        else if (failure instanceof z.ZodError)
          reply(response, 400, {
            error: {
              code: "VALIDATION",
              message:
                "The Team request contains invalid or unsupported fields.",
            },
          });
        else
          reply(response, 500, {
            error: {
              code: "STORAGE",
              message:
                "The relay could not confirm this change. Keep it pending and retry with the same operation ID.",
            },
          });
      }
    });
    server.requestTimeout = 30000;
    server.headersTimeout = 10000;
    let port = options.port;
    if (port === undefined) {
      try {
        const prior = JSON.parse(await readFile(readyFile, "utf8"));
        const previous = new URL(prior.url);
        if (["127.0.0.1", "[::1]"].includes(previous.hostname))
          port = Number(previous.port);
      } catch {}
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port ?? 0, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("Could not bind the Team relay.");
    if (advertised?.port === "0") advertised.port = String(address.port);
    const url = advertised
      ? advertised.origin
      : `http://${host === "::1" ? "[::1]" : host}:${address.port}`;
    await durableFile(
      readyFile,
      JSON.stringify({
        url,
        adminFile,
        pid: process.pid,
        identity: "invite-preview",
      }),
    );
    let closePromise: Promise<void> | undefined;
    return {
      url,
      adminCapability,
      adminFile,
      readyFile,
      close: () =>
        (closePromise ??= (async () => {
          closing = true;
          for (const room of rooms.values())
            for (const wake of [...room.waiters]) wake();
          await Promise.allSettled(
            [...rooms.values()].map((room) => room.pending),
          );
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeIdleConnections();
          });
          await releaseLock();
        })()),
    };
  } catch (failure) {
    await releaseLock();
    throw failure;
  }
}
