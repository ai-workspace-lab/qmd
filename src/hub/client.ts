/**
 * hub/client.ts - minimal HTTPS client for the QMD Hub and accounts.svc.plus.
 *
 * Baseline: ai-workspace-services/knowledge#400
 *
 * Auth model (same as ai-desktop-lab/xworkmate-remote-desktop / desktop.svc.plus):
 *   - humans: an accounts.svc.plus session token, obtained from the public
 *     POST /api/auth/login (+ POST /api/auth/mfa/verify for TOTP), sent to the Hub as
 *     `Authorization: Bearer <session>`; the Hub (Traefik forwardAuth -> qmd-hub-syncd)
 *     introspects it with GET {accounts}/api/auth/session and enforces its role policy;
 *   - machines: the Hub's static sync token, also sent as a Bearer token.
 *
 * Uses node:http(s) directly (no extra dependency). QMD_HUB_RESOLVE accepts curl-style
 * `host:port:address[,host:port:address]` overrides for testing a Hub before its DNS
 * record is live; TLS still verifies the certificate against the real host name.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
import { readFileSync } from "node:fs";
import { loadConfig } from "../collections.js";
import {
  DEFAULT_ACCOUNTS_URL,
  DEFAULT_HUB_URL,
  getCredentialsPath,
  loadCredentials,
  normalizeServiceUrl,
  type HubCredentialKind,
  type HubUser,
} from "./credentials.js";

export interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: any;
}

export interface HttpOptions {
  method?: string;
  token?: string;
  body?: unknown;
  timeoutMs?: number;
  accept?: string;
}

const USER_AGENT = "qmd-cli (qmd login)";

export function parseResolveOverrides(raw = process.env.QMD_HUB_RESOLVE || ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^([^:]+):(\d+):(.+)$/.exec(entry);
    if (m && isIP(m[3]!.replace(/^\[|\]$/g, ""))) out.set(`${m[1]!.toLowerCase()}:${m[2]}`, m[3]!.replace(/^\[|\]$/g, ""));
  }
  return out;
}

/**
 * One HTTP exchange. Idempotent GETs are retried twice on transport errors (TLS
 * handshake resets, timeouts); POST/DELETE are never retried.
 */
export async function httpJson(url: string, opts: HttpOptions = {}): Promise<HttpResult> {
  const attempts = (opts.method ?? "GET") === "GET" ? 3 : 1;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await httpOnce(url, opts);
    } catch (e) {
      last = e;
      if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw last;
}

async function httpOnce(url: string, opts: HttpOptions): Promise<HttpResult> {
  const u = new URL(url);
  const isHttps = u.protocol === "https:";
  const port = u.port ? Number(u.port) : isHttps ? 443 : 80;
  const override = parseResolveOverrides().get(`${u.hostname.toLowerCase()}:${port}`);
  const lookup: LookupFunction | undefined = override
    ? ((_host: string, options: any, cb: any) => {
        const family = isIP(override);
        if (options && options.all) cb(null, [{ address: override, family }]);
        else cb(null, override, family);
      }) as LookupFunction
    : undefined;
  const payload = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
  const headers: Record<string, string> = {
    accept: opts.accept ?? "application/json",
    "user-agent": USER_AGENT,
  };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (payload) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(payload.length);
  }
  const fn = isHttps ? httpsRequest : httpRequest;
  return await new Promise<HttpResult>((resolve, reject) => {
    const req = fn(
      {
        protocol: u.protocol,
        hostname: u.hostname.replace(/^\[|\]$/g, ""),
        port,
        path: `${u.pathname}${u.search}`,
        method: opts.method ?? "GET",
        headers,
        ...(lookup ? { lookup } : {}),
        ...(isHttps ? { servername: u.hostname } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size <= 1 << 20) chunks.push(c);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: any = undefined;
          try {
            json = text ? JSON.parse(text) : undefined;
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(opts.timeoutMs ?? 15000, () => req.destroy(new Error(`request to ${u.origin} timed out`)));
    req.on("error", (e) => reject(new Error(`cannot reach ${u.origin}: ${e.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Hub / accounts URL resolution
// ---------------------------------------------------------------------------

function configHub(): { url?: string; accounts_url?: string } {
  try {
    const cfg = loadConfig() as { hub?: { url?: string; accounts_url?: string } };
    return cfg.hub && typeof cfg.hub === "object" ? cfg.hub : {};
  } catch {
    return {};
  }
}

/**
 * Hub to use: --hub > QMD_HUB_URL > index.yml `hub.url` > last `qmd login` default
 * > official https://qmd.svc.plus.
 */
export function resolveHubUrl(flag?: string): string {
  const candidates = [flag, process.env.QMD_HUB_URL, configHub().url];
  for (const c of candidates) if (c && c.trim()) return normalizeServiceUrl(c);
  try {
    const def = loadCredentials(getCredentialsPath()).default;
    if (def) return normalizeServiceUrl(def);
  } catch {
    /* unreadable credentials file: fall through to the official Hub */
  }
  return DEFAULT_HUB_URL;
}

/** Hub-advertised auth hints, readable without credentials (401 body). */
export interface HubAuthHints {
  accounts_url?: string;
  login_url?: string;
}

export async function discoverHubAuth(hub: string): Promise<HubAuthHints> {
  try {
    const r = await httpJson(`${hub}/api/v1/auth/whoami`, { timeoutMs: 10000 });
    const j = r.json && typeof r.json === "object" ? r.json : {};
    const hints: HubAuthHints = {};
    if (typeof j.accounts_url === "string") {
      try {
        hints.accounts_url = normalizeServiceUrl(j.accounts_url, "accounts");
      } catch {
        /* ignore non-https advertisements */
      }
    }
    if (typeof j.login_url === "string") hints.login_url = j.login_url;
    return hints;
  } catch {
    return {};
  }
}

/**
 * accounts service to log in against: --accounts-url > QMD_ACCOUNTS_URL >
 * index.yml `hub.accounts_url` > saved profile > Hub advertisement > accounts.svc.plus.
 */
export function resolveAccountsUrl(opts: { flag?: string; saved?: string; advertised?: string }): string {
  const candidates = [opts.flag, process.env.QMD_ACCOUNTS_URL, configHub().accounts_url, opts.saved, opts.advertised];
  for (const c of candidates) if (c && c.trim()) return normalizeServiceUrl(c, "accounts");
  return DEFAULT_ACCOUNTS_URL;
}

/**
 * Bearer credential for a Hub, for commands that talk to it:
 * QMD_HUB_TOKEN > QMD_HUB_TOKEN_FILE > the `qmd login` profile for that Hub.
 */
export function resolveHubToken(hub: string): { token: string; source: string } | undefined {
  const env = process.env.QMD_HUB_TOKEN?.trim();
  if (env) return { token: env, source: "QMD_HUB_TOKEN" };
  const file = process.env.QMD_HUB_TOKEN_FILE?.trim();
  if (file) {
    const t = readFileSync(file, "utf8").trim();
    if (t) return { token: t, source: "QMD_HUB_TOKEN_FILE" };
  }
  const p = loadCredentials().profiles[normalizeServiceUrl(hub)];
  return p ? { token: p.token, source: getCredentialsPath() } : undefined;
}

// ---------------------------------------------------------------------------
// Hub identity
// ---------------------------------------------------------------------------

export interface HubIdentity {
  method: HubCredentialKind | string;
  user?: HubUser;
}

export class HubAuthError extends Error {
  constructor(message: string, public status: number, public hints: HubAuthHints = {}) {
    super(message);
  }
}

function userFromHubIdentity(id: any): HubUser | undefined {
  if (!id || typeof id !== "object") return undefined;
  const user: HubUser = {};
  if (id.userId || id.id) user.id = String(id.userId || id.id);
  if (id.email) user.email = String(id.email);
  if (id.name) user.name = String(id.name);
  if (Array.isArray(id.roles)) user.roles = id.roles.map(String);
  return Object.keys(user).length ? user : undefined;
}

/**
 * Ask the Hub who a Bearer token belongs to. Prefers GET /api/v1/auth/whoami and
 * falls back to the authenticated status page (GET /) on Hubs that predate it.
 */
export async function hubWhoami(hub: string, token: string): Promise<HubIdentity> {
  let r = await httpJson(`${hub}/api/v1/auth/whoami`, { token });
  if (r.status === 404) r = await httpJson(`${hub}/`, { token });
  if (r.status === 200 && r.json && typeof r.json === "object") {
    const id = r.json.identity ?? r.json;
    const method = typeof id.method === "string" ? id.method : "unknown";
    return { method, user: userFromHubIdentity(id) };
  }
  const j = r.json && typeof r.json === "object" ? r.json : {};
  const hints: HubAuthHints = { accounts_url: j.accounts_url, login_url: j.login_url };
  const reason = typeof j.error === "string" ? j.error : `HTTP ${r.status}`;
  if (r.status === 401) throw new HubAuthError(`Hub ${hub} rejected the credential (401: ${reason})`, 401, hints);
  if (r.status === 403) throw new HubAuthError(`Hub ${hub} denied this account (403: ${reason})`, 403, hints);
  throw new HubAuthError(`Hub ${hub} returned ${reason}`, r.status, hints);
}

// ---------------------------------------------------------------------------
// accounts.svc.plus (public API only)
// ---------------------------------------------------------------------------

export interface AccountsLoginResult {
  token?: string;
  expiresAt?: string;
  user?: HubUser;
  mfaRequired?: boolean;
  mfaTicket?: string;
  mfaMethod?: string;
}

function accountsError(r: HttpResult, action: string): Error {
  const j = r.json && typeof r.json === "object" ? r.json : {};
  const code = typeof j.error === "string" ? j.error : `HTTP ${r.status}`;
  const msg = typeof j.message === "string" ? j.message : "";
  return new Error(`accounts ${action} failed: ${code}${msg ? ` (${msg})` : ""}`);
}

function parseLogin(j: any): AccountsLoginResult {
  const o = j && typeof j === "object" ? j : {};
  let expiresAt: string | undefined = typeof o.expiresAt === "string" ? o.expiresAt : undefined;
  if (!expiresAt && typeof o.expires_in === "number" && o.expires_in > 0) {
    expiresAt = new Date(Date.now() + o.expires_in * 1000).toISOString();
  }
  const u = o.user && typeof o.user === "object" ? o.user : undefined;
  return {
    token: (typeof o.token === "string" && o.token) || (typeof o.access_token === "string" && o.access_token) || undefined,
    expiresAt,
    user: u
      ? {
          id: u.id ? String(u.id) : u.uuid ? String(u.uuid) : undefined,
          email: u.email ? String(u.email) : undefined,
          name: String(u.name || u.username || u.email || "") || undefined,
          roles: [...new Set([u.role, ...(Array.isArray(u.roles) ? u.roles : [])].filter(Boolean).map((x: unknown) => String(x).toLowerCase()))],
        }
      : undefined,
    mfaRequired: Boolean(o.mfaRequired || o.mfa_required),
    mfaTicket: o.mfa_ticket || o.mfaTicket || o.mfaToken || undefined,
    mfaMethod: o.mfa_method || o.mfaMethod || undefined,
  };
}

/**
 * POST {accounts}/api/auth/login with identifier (email or username) + password.
 * When `totpCode` is given it is sent in the same request ("all at once"): accounts
 * validates it inline for MFA accounts and returns the session directly; without it an
 * MFA account answers `mfaRequired` + `mfa_ticket` for POST /api/auth/mfa/verify.
 */
export async function accountsLogin(accounts: string, identifier: string, password: string, totpCode?: string): Promise<AccountsLoginResult> {
  const body: Record<string, string> = { identifier, password };
  if (identifier.includes("@")) body.email = identifier;
  if (totpCode) body.totpCode = totpCode;
  const r = await httpJson(`${accounts}/api/auth/login`, { method: "POST", body });
  if (r.status < 200 || r.status >= 300) throw accountsError(r, "login");
  return parseLogin(r.json);
}

/** POST {accounts}/api/auth/mfa/verify with the MFA ticket + TOTP code. */
export async function accountsVerifyMfa(accounts: string, mfaTicket: string, code: string): Promise<AccountsLoginResult> {
  const r = await httpJson(`${accounts}/api/auth/mfa/verify`, {
    method: "POST",
    body: { mfa_ticket: mfaTicket, code, method: "totp" },
  });
  if (r.status < 200 || r.status >= 300) throw accountsError(r, "MFA verification");
  return parseLogin(r.json);
}

/** DELETE {accounts}/api/auth/session — best-effort server-side logout. */
export async function accountsRevoke(accounts: string, token: string): Promise<boolean> {
  try {
    const r = await httpJson(`${accounts}/api/auth/session`, { method: "DELETE", token, timeoutMs: 10000 });
    return r.status >= 200 && r.status < 300;
  } catch {
    return false;
  }
}
