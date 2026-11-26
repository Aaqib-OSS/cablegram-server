import type { FastifyInstance } from "fastify";
import type { PGlite } from "@electric-sql/pglite";
import { createHash, randomBytes } from "node:crypto";
import { authOf } from "./authorize.ts";

/**
 * Live sync: tells connected TVs that something they show may have changed. An event is a hint; the TV
 * refetches over REST and never reads data from it.
 */
export type ChangeScope = "catalog" | "profiles" | "profileSwitch";
export type RouteChanges = readonly ChangeScope[];

export interface ChangeOptions {
  /** catalog: only TVs on this profile care (my list); omitted means the whole household. */
  profileId?: string;
  /** profileSwitch: only the TV that asked. */
  deviceId?: string;
}

export interface LiveOptions {
  /** Trailing debounce per household, scope and target. */
  debounceMs?: number;
  /** A steady stream of writes still produces an event at least this often. */
  maxWaitMs?: number;
  ticketTtlMs?: number;
  /** Outstanding tickets per device; the oldest is dropped past this. */
  maxTicketsPerDevice?: number;
  now?: () => number;
}

type Send = (text: string) => void;
type Pending = { timer: NodeJS.Timeout; firstAt: number; scope: ChangeScope; household: string; options: ChangeOptions };
type Ticket = { deviceId: string; householdId: string; expiresAt: number };

export interface LiveHub {
  /** Registers a TV's open socket. The returned function removes it (a newer socket for the same device is kept). */
  attach(householdId: string, deviceId: string, send: Send): () => void;
  notifyChanged(householdId: string, scope: ChangeScope, options?: ChangeOptions): void;
  /** Same, after a delay (a pending profile-switch request that expires unanswered). */
  notifyChangedIn(delayMs: number, householdId: string, scope: ChangeScope, options?: ChangeOptions): void;
  issueTicket(deviceId: string, householdId: string): { ticket: string; expiresInMs: number };
  /** Consumes a ticket: valid once, before it expires. */
  redeemTicket(ticket: string): { deviceId: string; householdId: string } | null;
  /** Mutating routes registered without a `changes` declaration. A test requires this to be empty. */
  readonly undeclared: string[];
  close(): void;
}

export function createLiveHub(options: LiveOptions = {}): LiveHub {
  const debounceMs = options.debounceMs ?? 250;
  const maxWaitMs = options.maxWaitMs ?? 1_000;
  const ticketTtlMs = options.ticketTtlMs ?? 30_000;
  const maxTickets = options.maxTicketsPerDevice ?? 4;
  const now = options.now ?? Date.now;

  const attached = new Map<string, Map<string, Send>>();
  const pending = new Map<string, Pending>();
  const delayed = new Set<NodeJS.Timeout>();
  const versions = new Map<string, number>();
  const tickets = new Map<string, Ticket>();
  const undeclared: string[] = [];

  const hash = (ticket: string) => createHash("sha256").update(ticket).digest("hex");
  const sweep = setInterval(() => {
    for (const [key, t] of tickets) if (t.expiresAt <= now()) tickets.delete(key);
  }, 60_000);
  sweep.unref();

  function deliver(household: string, scope: ChangeScope, opts: ChangeOptions) {
    const devices = attached.get(household);
    if (!devices?.size) return;
    const version = (versions.get(household) ?? 0) + 1;
    versions.set(household, version);
    const text = JSON.stringify({
      type: "changed", scope, ...(opts.profileId ? { profileId: opts.profileId } : {}), version: String(version),
    });
    for (const [deviceId, send] of devices) {
      if (opts.deviceId && opts.deviceId !== deviceId) continue;
      try { send(text); } catch { /* a dying socket is removed by its own close handler */ }
    }
  }

  function notifyChanged(household: string, scope: ChangeScope, opts: ChangeOptions = {}) {
    const key = [household, scope, opts.profileId ?? "", opts.deviceId ?? ""].join("|");
    const existing = pending.get(key);
    const firstAt = existing?.firstAt ?? now();
    if (existing) clearTimeout(existing.timer);
    const wait = Math.max(0, Math.min(debounceMs, firstAt + maxWaitMs - now()));
    const timer = setTimeout(() => {
      pending.delete(key);
      deliver(household, scope, opts);
    }, wait);
    timer.unref();
    pending.set(key, { timer, firstAt, scope, household, options: opts });
  }

  return {
    attach(householdId, deviceId, send) {
      let devices = attached.get(householdId);
      if (!devices) attached.set(householdId, (devices = new Map()));
      devices.set(deviceId, send);
      return () => {
        const current = attached.get(householdId);
        if (current?.get(deviceId) !== send) return;
        current.delete(deviceId);
        if (!current.size) attached.delete(householdId);
      };
    },
    notifyChanged,
    notifyChangedIn(delayMs, householdId, scope, opts) {
      const timer = setTimeout(() => { delayed.delete(timer); notifyChanged(householdId, scope, opts); }, delayMs);
      timer.unref();
      delayed.add(timer);
    },
    issueTicket(deviceId, householdId) {
      const mine = [...tickets.entries()].filter(([, t]) => t.deviceId === deviceId);
      while (mine.length >= maxTickets) tickets.delete(mine.shift()![0]);
      const ticket = randomBytes(32).toString("base64url");
      tickets.set(hash(ticket), { deviceId, householdId, expiresAt: now() + ticketTtlMs });
      return { ticket, expiresInMs: ticketTtlMs };
    },
    redeemTicket(ticket) {
      const key = hash(ticket);
      const found = tickets.get(key);
      if (!found) return null;
      tickets.delete(key);
      return found.expiresAt > now() ? { deviceId: found.deviceId, householdId: found.householdId } : null;
    },
    undeclared,
    close() {
      clearInterval(sweep);
      for (const p of pending.values()) clearTimeout(p.timer);
      for (const t of delayed) clearTimeout(t);
      pending.clear(); delayed.clear(); tickets.clear(); attached.clear();
    },
  };
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Every mutating route must be listed in `declared` ("METHOD /url" to the scopes it changes, `[]` for none).
 * A route that is not listed is recorded in `hub.undeclared`, and a test fails on it, so a new write route
 * cannot silently skip live sync (nor silently spam TVs).
 */
export function installLiveHooks(app: FastifyInstance, db: PGlite, hub: LiveHub, declared: Record<string, RouteChanges>) {
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) {
      if (READ_METHODS.has(method)) continue;
      const changes = declared[`${method} ${route.url}`];
      if (!changes) { hub.undeclared.push(`${method} ${route.url}`); continue; }
      route.config = { ...(route.config as object | undefined), changes };
    }
  });

  app.addHook("onResponse", async (req, reply) => {
    if (READ_METHODS.has(req.method) || reply.statusCode < 200 || reply.statusCode > 299) return;
    const changes = (reply.routeOptions.config as { changes?: RouteChanges } | undefined)?.changes;
    if (!changes?.length) return;
    const auth = authOf(req);
    if (!auth) return;
    const params = (req.params ?? {}) as { profileId?: string; requestId?: string };
    for (const scope of changes) {
      if (scope === "profileSwitch") {
        // Tell the TV that asked, not every TV in the house.
        const row = params.requestId
          ? await db.query<{ tv_device_id: string | null }>(
            "SELECT tv_device_id FROM profile_switch_requests WHERE id = $1 AND household_id = $2", [params.requestId, auth.household_id])
          : undefined;
        const deviceId = row?.rows[0]?.tv_device_id;
        if (deviceId) hub.notifyChanged(auth.household_id, scope, { deviceId });
      } else {
        hub.notifyChanged(auth.household_id, scope, scope === "catalog" && params.profileId ? { profileId: params.profileId } : {});
      }
    }
  });
}

/** Origins that may open the ticket socket: none given (native), a configured web origin, or a packaged app (`null`/`file:`). */
export function socketOriginAllowed(origin: string | undefined, webOrigins: readonly string[]): boolean {
  if (origin === undefined || origin === "null" || origin.startsWith("file://")) return true;
  return webOrigins.includes(origin.replace(/\/+$/, ""));
}
