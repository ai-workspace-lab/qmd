/**
 * hub-login.test.ts - `qmd login` / `qmd logout` / `qmd whoami` against a fake
 * accounts.svc.plus and fake QMD Hubs (loopback http only).
 *
 * Baseline: ai-workspace-services/knowledge#400
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { runLoginCommand, runLogoutCommand, runWhoamiCommand, EXIT_MFA_REQUIRED, EXIT_USAGE, type LoginIO } from "../src/cli/login-commands.js";
import { loadCredentials, normalizeServiceUrl } from "../src/hub/credentials.js";

// Low-entropy fixtures (not secrets).
const MACHINE = "machine-sync-fixture-0000000000000000000000";
const USERS: Record<string, { password: string; mfa?: string; role: string; email: string }> = {
  alice: { password: "alice-pw", role: "admin", email: "alice@example.test" },
  bob: { password: "bob-pw", mfa: "123456", role: "admin", email: "bob@example.test" },
  carol: { password: "carol-pw", role: "user", email: "carol@example.test" },
};

type Call = { path: string; method: string; body: any };
const accountsCalls: Call[] = [];
const sessions = new Map<string, string>(); // token -> user
const revoked = new Set<string>();
let seq = 0;

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    const c: Buffer[] = [];
    req.on("data", (d) => c.push(d));
    req.on("end", () => {
      const t = Buffer.concat(c).toString("utf8");
      resolve(t ? JSON.parse(t) : {});
    });
  });
}
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function bearer(req: IncomingMessage) {
  return String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
}
function userOf(u: string) {
  const x = USERS[u]!;
  return { id: `id-${u}`, email: x.email, name: u, role: x.role };
}
function session(u: string) {
  const t = `sess-${u}-${++seq}`;
  sessions.set(t, u);
  return { token: t, access_token: t, expiresAt: "2099-01-01T00:00:00Z", mfaRequired: false, user: userOf(u) };
}
const tickets = new Map<string, string>();

async function accountsHandler(req: IncomingMessage, res: ServerResponse) {
  const body = req.method === "POST" ? await readBody(req) : {};
  accountsCalls.push({ path: req.url || "", method: req.method || "", body });
  if (req.url === "/api/auth/login" && req.method === "POST") {
    const u = Object.keys(USERS).find((k) => k === body.identifier || USERS[k]!.email === body.identifier);
    if (!u || USERS[u]!.password !== body.password) return json(res, 401, { error: "invalid_credentials", message: "invalid credentials" });
    const mfa = USERS[u]!.mfa;
    if (mfa) {
      if (!body.totpCode) {
        const t = `ticket-${++seq}`;
        tickets.set(t, u);
        return json(res, 200, { mfaRequired: true, mfa_required: true, mfaMethod: "totp", mfa_ticket: t, mfaTicket: t });
      }
      if (body.totpCode !== mfa) return json(res, 401, { error: "invalid_mfa_code", message: "invalid totp code" });
    }
    return json(res, 200, session(u));
  }
  if (req.url === "/api/auth/mfa/verify" && req.method === "POST") {
    const u = tickets.get(body.mfa_ticket);
    if (!u || body.code !== USERS[u]!.mfa) return json(res, 401, { error: "invalid_mfa_code" });
    tickets.delete(body.mfa_ticket);
    return json(res, 200, session(u));
  }
  if (req.url === "/api/auth/session") {
    const t = bearer(req);
    const u = sessions.get(t);
    if (!u || revoked.has(t)) return json(res, 401, { error: "unauthorized" });
    if (req.method === "DELETE") {
      revoked.add(t);
      return json(res, 200, { ok: true });
    }
    return json(res, 200, { user: userOf(u) });
  }
  json(res, 404, { error: "not_found" });
}

let accountsBase = "";
function hubHandler(req: IncomingMessage, res: ServerResponse) {
  if (req.url !== "/api/v1/auth/whoami") return json(res, 404, { error: "not found" });
  const t = bearer(req);
  if (!t) return json(res, 401, { error: "authentication required", accounts_url: accountsBase });
  if (t === MACHINE) return json(res, 200, { service: "qmd-hub", identity: { method: "static_token" } });
  const u = sessions.get(t);
  if (!u || revoked.has(t)) return json(res, 401, { error: "invalid or expired accounts session", accounts_url: accountsBase });
  if (USERS[u]!.role !== "admin") return json(res, 403, { error: "account role is not allowed" });
  const x = userOf(u);
  return json(res, 200, { service: "qmd-hub", identity: { method: "accounts_session", userId: x.id, email: x.email, name: u, roles: [x.role] } });
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => unknown): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => void handler(req, res));
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

function fakeIO(opts: { interactive: boolean; answers?: string[]; stdin?: string }) {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const io: LoginIO = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    interactive: opts.interactive,
    promptText: async (q) => {
      prompts.push(q);
      return answers.shift() ?? "";
    },
    promptSecret: async (q) => {
      prompts.push(`[hidden] ${q}`);
      return answers.shift() ?? "";
    },
    readStdin: async () => opts.stdin ?? "",
  };
  return { io, out, err, prompts, all: () => [...out, ...err].join("\n") };
}

const ENV_KEYS = ["QMD_CREDENTIALS_FILE", "QMD_CONFIG_DIR", "QMD_HUB_URL", "QMD_HUB_TOKEN", "QMD_HUB_TOKEN_FILE", "QMD_ACCOUNTS_URL", "QMD_PASSWORD", "QMD_MFA_CODE", "QMD_EMAIL", "QMD_IDENTIFIER", "XDG_CONFIG_HOME"];
const saved: Record<string, string | undefined> = {};

describe("qmd login / logout / whoami", () => {
  let dir: string;
  let credFile: string;
  let accounts: { server: Server; base: string };
  let hub: { server: Server; base: string };
  let hub2: { server: Server; base: string };

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    accounts = await listen(accountsHandler);
    accountsBase = accounts.base;
    hub = await listen(hubHandler);
    hub2 = await listen(hubHandler);
  });

  afterAll(async () => {
    for (const s of [accounts, hub, hub2]) await new Promise((r) => s.server.close(() => r(null)));
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  beforeEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "qmd-login-"));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.QMD_CONFIG_DIR = dir;
    credFile = join(dir, "sub", "credentials.json");
    process.env.QMD_CREDENTIALS_FILE = credFile;
    accountsCalls.length = 0;
  });

  const logins = () => accountsCalls.filter((c) => c.path === "/api/auth/login");

  test("interactive, no MFA: prompts account + hidden password, saves a 0600 profile keyed by hub", async () => {
    const f = fakeIO({ interactive: true, answers: ["alice", "alice-pw"] });
    expect(await runLoginCommand([], { hub: hub.base }, f.io)).toBe(0);
    expect(f.prompts).toEqual(["Email or username: ", "[hidden] Password (hidden): "]);
    const creds = loadCredentials(credFile);
    const p = creds.profiles[hub.base]!;
    expect(p.kind).toBe("accounts_session");
    expect(p.user?.email).toBe("alice@example.test");
    expect(p.accounts_url).toBe(accounts.base); // discovered from the hub's 401 advertisement
    expect(p.expires_at).toBe("2099-01-01T00:00:00Z");
    expect(creds.default).toBe(hub.base);
    expect(statSync(credFile).mode & 0o777).toBe(0o600);
    expect(f.all()).not.toContain(p.token);
    expect(f.all()).not.toContain("alice-pw");
  });

  test("interactive, MFA: account -> password -> TOTP prompt, completes via /api/auth/mfa/verify", async () => {
    const f = fakeIO({ interactive: true, answers: ["bob@example.test", "bob-pw", "123456"] });
    expect(await runLoginCommand([], { hub: hub.base }, f.io)).toBe(0);
    expect(f.prompts).toEqual(["Email or username: ", "[hidden] Password (hidden): ", "Authenticator code (TOTP): "]);
    expect(accountsCalls.some((c) => c.path === "/api/auth/mfa/verify" && c.body.code === "123456")).toBe(true);
    expect(loadCredentials(credFile).profiles[hub.base]!.user?.email).toBe("bob@example.test");
  });

  test("interactive with --mfa-code up front sends everything in one login call", async () => {
    const f = fakeIO({ interactive: true, answers: ["bob", "bob-pw"] });
    expect(await runLoginCommand([], { hub: hub.base, "mfa-code": "123456" }, f.io)).toBe(0);
    expect(f.prompts.length).toBe(2);
    expect(logins().length).toBe(1);
    expect(logins()[0]!.body.totpCode).toBe("123456");
  });

  test("non-interactive, MFA all at once: --email + --password-stdin + --mfa-code, single call, no prompts", async () => {
    const f = fakeIO({ interactive: false, stdin: "bob-pw\n" });
    const code = await runLoginCommand([], { hub: hub.base, email: "bob@example.test", "password-stdin": true, "mfa-code": "123456" }, f.io);
    expect(code).toBe(0);
    expect(f.prompts).toEqual([]);
    expect(logins().length).toBe(1);
    expect(accountsCalls.some((c) => c.path === "/api/auth/mfa/verify")).toBe(false);
    expect(f.all()).not.toContain("bob-pw");
  });

  test("non-interactive via env: QMD_EMAIL + QMD_PASSWORD + QMD_MFA_CODE (even on a TTY)", async () => {
    process.env.QMD_EMAIL = "bob";
    process.env.QMD_PASSWORD = "bob-pw";
    process.env.QMD_MFA_CODE = "123456";
    const f = fakeIO({ interactive: true });
    expect(await runLoginCommand([], { hub: hub.base }, f.io)).toBe(0);
    expect(f.prompts).toEqual([]);
    expect(logins().length).toBe(1);
  });

  test("non-interactive, account without MFA: password only (no TOTP needed)", async () => {
    const f = fakeIO({ interactive: false, stdin: "alice-pw" });
    expect(await runLoginCommand([], { hub: hub.base, identifier: "alice", "password-stdin": true }, f.io)).toBe(0);
    expect(f.prompts).toEqual([]);
  });

  test("non-interactive, MFA required but no code: exit 3, no prompt, nothing saved", async () => {
    const f = fakeIO({ interactive: false, stdin: "bob-pw" });
    const code = await runLoginCommand([], { hub: hub.base, email: "bob", "password-stdin": true }, f.io);
    expect(code).toBe(EXIT_MFA_REQUIRED);
    expect(f.prompts).toEqual([]);
    expect(f.err.join("\n")).toContain("--mfa-code");
    expect(existsSync(credFile)).toBe(false);
  });

  test("--non-interactive on a TTY also refuses to prompt for MFA", async () => {
    process.env.QMD_PASSWORD = "bob-pw";
    const f = fakeIO({ interactive: true });
    expect(await runLoginCommand([], { hub: hub.base, email: "bob", "non-interactive": true }, f.io)).toBe(EXIT_MFA_REQUIRED);
    expect(f.prompts).toEqual([]);
  });

  test("non-interactive with missing password: exit 2 naming the missing inputs", async () => {
    const f = fakeIO({ interactive: false });
    expect(await runLoginCommand([], { hub: hub.base, email: "alice" }, f.io)).toBe(EXIT_USAGE);
    expect(f.err.join("\n")).toContain("--password-stdin");
    expect(accountsCalls.length).toBe(0);
  });

  test("wrong password or wrong TOTP: exit 1", async () => {
    const f = fakeIO({ interactive: false, stdin: "nope" });
    expect(await runLoginCommand([], { hub: hub.base, email: "alice", "password-stdin": true }, f.io)).toBe(1);
    expect(f.err.join("\n")).toContain("invalid_credentials");
    const g = fakeIO({ interactive: false, stdin: "bob-pw" });
    expect(await runLoginCommand([], { hub: hub.base, email: "bob", "password-stdin": true, totp: "000000" }, g.io)).toBe(1);
    expect(g.err.join("\n")).toContain("invalid_mfa_code");
  });

  test("account not allowed by the hub (403): session revoked, nothing saved", async () => {
    const f = fakeIO({ interactive: true, answers: ["carol", "carol-pw"] });
    expect(await runLoginCommand([], { hub: hub.base }, f.io)).toBe(1);
    expect(f.err.join("\n")).toContain("403");
    expect(accountsCalls.some((c) => c.path === "/api/auth/session" && c.method === "DELETE")).toBe(true);
    expect(existsSync(credFile)).toBe(false);
  });

  test("machine token: --token-stdin and QMD_HUB_TOKEN store a static_token profile", async () => {
    const f = fakeIO({ interactive: false, stdin: `${MACHINE}\n` });
    expect(await runLoginCommand([], { hub: hub.base, "token-stdin": true }, f.io)).toBe(0);
    expect(loadCredentials(credFile).profiles[hub.base]!.kind).toBe("static_token");
    expect(f.all()).not.toContain(MACHINE);

    process.env.QMD_HUB_TOKEN = MACHINE;
    const g = fakeIO({ interactive: false });
    expect(await runLoginCommand([], { hub: hub2.base }, g.io)).toBe(0);
    expect(loadCredentials(credFile).profiles[hub2.base]!.kind).toBe("static_token");

    const bad = fakeIO({ interactive: false, stdin: "not-the-token" });
    delete process.env.QMD_HUB_TOKEN;
    expect(await runLoginCommand([], { hub: hub.base, "token-stdin": true }, bad.io)).toBe(1);
  });

  test("whoami / login status, per-hub profiles, logout revokes the accounts session", async () => {
    const none = fakeIO({ interactive: false });
    expect(await runWhoamiCommand([], { hub: hub.base }, none.io)).toBe(1);

    await runLoginCommand([], { hub: hub.base }, fakeIO({ interactive: true, answers: ["alice", "alice-pw"] }).io);
    await runLoginCommand([], { hub: hub2.base, "token-stdin": true }, fakeIO({ interactive: false, stdin: MACHINE }).io);
    const creds = loadCredentials(credFile);
    expect(Object.keys(creds.profiles).sort()).toEqual([hub.base, hub2.base].sort());
    expect(creds.default).toBe(hub2.base);

    const w = fakeIO({ interactive: false });
    expect(await runWhoamiCommand([], { hub: hub.base, json: true }, w.io)).toBe(0);
    const info = JSON.parse(w.out.join("\n"));
    expect(info).toMatchObject({ logged_in: true, method: "accounts_session", user: { email: "alice@example.test" } });
    expect(w.all()).not.toContain(creds.profiles[hub.base]!.token);

    const s = fakeIO({ interactive: false });
    expect(await runLoginCommand(["status"], {}, s.io)).toBe(0); // default = last login (hub2)
    expect(s.out.join("\n")).toContain("machine sync token");

    const aliceToken = creds.profiles[hub.base]!.token;
    const lo = fakeIO({ interactive: false });
    expect(await runLogoutCommand([], { hub: hub.base }, lo.io)).toBe(0);
    expect(revoked.has(aliceToken)).toBe(true);
    expect(Object.keys(loadCredentials(credFile).profiles)).toEqual([hub2.base]);

    expect(await runLogoutCommand([], { all: true }, fakeIO({ interactive: false }).io)).toBe(0);
    expect(loadCredentials(credFile).profiles).toEqual({});
    expect(JSON.parse(readFileSync(credFile, "utf8")).version).toBe(1);
  });

  test("hub URL normalisation: bare host -> https, http only for loopback, no embedded creds", () => {
    expect(normalizeServiceUrl("qmd.svc.plus")).toBe("https://qmd.svc.plus");
    expect(normalizeServiceUrl("https://QMD.example.com/some/path/")).toBe("https://qmd.example.com");
    expect(normalizeServiceUrl("http://127.0.0.1:8182")).toBe("http://127.0.0.1:8182");
    expect(() => normalizeServiceUrl("http://qmd.example.com")).toThrow(/https/);
    expect(() => normalizeServiceUrl("https://u:p@qmd.example.com")).toThrow(/credentials/);
  });

  test("default hub is the official https://qmd.svc.plus; QMD_HUB_URL overrides", async () => {
    const { resolveHubUrl } = await import("../src/hub/client.js");
    expect(resolveHubUrl()).toBe("https://qmd.svc.plus");
    process.env.QMD_HUB_URL = "hub.example.test";
    expect(resolveHubUrl()).toBe("https://hub.example.test");
    expect(resolveHubUrl("other.example.test")).toBe("https://other.example.test");
  });
});
