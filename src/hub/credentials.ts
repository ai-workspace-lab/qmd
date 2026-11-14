/**
 * hub/credentials.ts - per-Hub login profiles for `qmd login` / `qmd logout` / `qmd whoami`.
 *
 * Baseline: ai-workspace-services/knowledge#400
 * (docs/reference/platform-delivery/architecture/QMD单体运行与分布式异步同步架构规范.md)
 *
 * Profiles live in `<config dir>/credentials.json` (QMD_CREDENTIALS_FILE overrides),
 * written atomically with mode 0600 inside a 0700 directory and keyed by the Hub
 * origin (scheme://host[:port]) so the official Hub and any custom-domain Hub keep
 * separate sessions. Token values are never logged; use `redactToken` for display.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../collections.js";

export const DEFAULT_HUB_URL = "https://qmd.svc.plus";
export const DEFAULT_ACCOUNTS_URL = "https://accounts.svc.plus";

/** How the stored credential authenticates against the Hub. */
export type HubCredentialKind = "accounts_session" | "static_token";

export interface HubUser {
  id?: string;
  email?: string;
  name?: string;
  roles?: string[];
}

export interface HubProfile {
  hub: string;
  accounts_url?: string;
  kind: HubCredentialKind;
  token: string;
  user?: HubUser;
  expires_at?: string;
  created_at: string;
}

export interface CredentialsFile {
  version: 1;
  default?: string;
  profiles: Record<string, HubProfile>;
}

export function getCredentialsPath(): string {
  const override = process.env.QMD_CREDENTIALS_FILE?.trim();
  return override || join(getConfigDir(), "credentials.json");
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Normalize a Hub/accounts URL to its origin. Bare hosts get https://. Plain http
 * is only accepted for loopback hosts (local development / tests) so a session
 * token is never sent in clear text over the network.
 */
export function normalizeServiceUrl(raw: string, what = "hub"): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) throw new Error(`${what} URL is empty`);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error(`invalid ${what} URL: ${trimmed}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`${what} URL must use https: ${trimmed}`);
  if (u.protocol === "http:" && !isLoopbackHost(u.hostname)) {
    throw new Error(`${what} URL must use https (plain http is only allowed for localhost): ${trimmed}`);
  }
  if (u.username || u.password) throw new Error(`${what} URL must not embed credentials`);
  return u.origin.toLowerCase();
}

export function emptyCredentials(): CredentialsFile {
  return { version: 1, profiles: {} };
}

export function loadCredentials(path = getCredentialsPath()): CredentialsFile {
  if (!existsSync(path)) return emptyCredentials();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`credentials file is not valid JSON: ${path}`);
  }
  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Partial<CredentialsFile>;
  const profiles: Record<string, HubProfile> = {};
  for (const [key, p] of Object.entries(obj.profiles ?? {})) {
    if (p && typeof p === "object" && typeof p.token === "string" && p.token) profiles[key] = p as HubProfile;
  }
  return { version: 1, default: typeof obj.default === "string" ? obj.default : undefined, profiles };
}

export function saveCredentials(data: CredentialsFile, path = getCredentialsPath()): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/** Mode bits of the credentials file (for warnings / tests); undefined when absent. */
export function credentialsMode(path = getCredentialsPath()): number | undefined {
  return existsSync(path) ? statSync(path).mode & 0o777 : undefined;
}

export function getProfile(hub: string, path = getCredentialsPath()): HubProfile | undefined {
  return loadCredentials(path).profiles[normalizeServiceUrl(hub)];
}

export function putProfile(profile: HubProfile, opts: { makeDefault?: boolean } = {}, path = getCredentialsPath()): void {
  const data = loadCredentials(path);
  const key = normalizeServiceUrl(profile.hub);
  data.profiles[key] = { ...profile, hub: key };
  if (opts.makeDefault !== false) data.default = key;
  saveCredentials(data, path);
}

/** Remove one profile; returns the removed profile (if any). */
export function removeProfile(hub: string, path = getCredentialsPath()): HubProfile | undefined {
  const data = loadCredentials(path);
  const key = normalizeServiceUrl(hub);
  const removed = data.profiles[key];
  if (!removed) return undefined;
  delete data.profiles[key];
  if (data.default === key) data.default = Object.keys(data.profiles)[0];
  saveCredentials(data, path);
  return removed;
}

/** Show only enough of a token to tell two apart. Never prints the value. */
export function redactToken(token: string): string {
  if (!token) return "(none)";
  return `${"*".repeat(8)} (${token.length} chars)`;
}
