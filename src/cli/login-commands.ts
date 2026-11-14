/**
 * cli/login-commands.ts - `qmd login`, `qmd logout`, `qmd whoami`.
 *
 * Baseline: ai-workspace-services/knowledge#400
 * (docs/reference/platform-delivery/architecture/QMD单体运行与分布式异步同步架构规范.md)
 *
 * Signs the CLI in to a QMD Hub — the official https://qmd.svc.plus or any
 * custom-domain Hub — reusing the accounts.svc.plus unified account service:
 *   interactive: identifier + hidden password (+ TOTP when MFA is on) via the public
 *                accounts API; the resulting session is verified against the Hub
 *                (role policy is enforced Hub-side) before it is stored;
 *   non-interactive: --token / --token-stdin / QMD_HUB_TOKEN (Hub sync token or an
 *                existing accounts session token), verified the same way.
 * Credentials are stored per Hub origin in <config dir>/credentials.json (0600).
 */

import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import {
  getCredentialsPath,
  getProfile,
  loadCredentials,
  putProfile,
  removeProfile,
  saveCredentials,
  emptyCredentials,
  type HubCredentialKind,
  type HubProfile,
  type HubUser,
} from "../hub/credentials.js";
import {
  accountsLogin,
  accountsRevoke,
  accountsVerifyMfa,
  discoverHubAuth,
  hubWhoami,
  HubAuthError,
  resolveAccountsUrl,
  resolveHubToken,
  resolveHubUrl,
} from "../hub/client.js";

type Values = Record<string, unknown>;

/** Exit codes: 0 ok, 1 auth/network failure, 2 usage (missing input), 3 MFA code required. */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_MFA_REQUIRED = 3;

export interface LoginIO {
  out: (line: string) => void;
  err: (line: string) => void;
  /** true when both stdin and stderr are TTYs (prompts are possible) */
  interactive: boolean;
  promptText: (question: string) => Promise<string>;
  promptSecret: (question: string) => Promise<string>;
  readStdin: () => Promise<string>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function wantsJson(values: Values): boolean {
  return values.json === true || values.format === "json";
}

export function defaultLoginIO(): LoginIO {
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const ask = (question: string, hidden: boolean) =>
    new Promise<string>((resolve, reject) => {
      let muted = false;
      const output = new Writable({
        write(chunk, _enc, cb) {
          if (!muted) process.stderr.write(chunk);
          cb();
        },
      });
      const rl = createInterface({ input: process.stdin, output, terminal: true });
      rl.on("SIGINT", () => {
        rl.close();
        process.stderr.write("\n");
        reject(new Error("login cancelled"));
      });
      rl.question(question, (answer) => {
        rl.close();
        if (hidden) process.stderr.write("\n");
        resolve(answer);
      });
      muted = hidden;
    });
  return {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    interactive,
    promptText: (q) => ask(q, false),
    promptSecret: (q) => ask(q, true),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(Buffer.from(c));
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}

function describeUser(user?: HubUser): string {
  if (!user) return "";
  const who = user.email || user.name || user.id || "";
  const roles = user.roles?.length ? ` [${user.roles.join(", ")}]` : "";
  return `${who}${roles}`;
}

function kindOf(method: string): HubCredentialKind {
  return method === "static_token" ? "static_token" : "accounts_session";
}

/** First line of piped stdin (secrets are never accepted as argv when avoidable). */
async function stdinLine(io: LoginIO): Promise<string> {
  return (await io.readStdin()).split(/\r?\n/)[0]!.trim();
}

export async function runLoginCommand(args: string[], values: Values, io: LoginIO = defaultLoginIO()): Promise<number> {
  const sub = args[0];
  if (sub === "status" || values["login-status"] === true) return runWhoamiCommand([], values, io);
  if (sub === "help" || values.help) {
    printLoginHelp(io);
    return 0;
  }

  let hub: string;
  try {
    hub = resolveHubUrl(str(values.hub));
  } catch (e) {
    io.err(e instanceof Error ? e.message : String(e));
    return 2;
  }

  // ---- non-interactive: --token / --token-stdin / QMD_HUB_TOKEN ----------------
  let token: string | undefined;
  let tokenSource = "";
  if (values["token-stdin"] === true) {
    token = await stdinLine(io);
    tokenSource = "stdin";
  } else if (str(values.token)) {
    token = str(values.token);
    tokenSource = "--token";
    io.err("warning: --token leaves the secret in shell history; prefer --token-stdin or QMD_HUB_TOKEN.");
  } else if (str(process.env.QMD_HUB_TOKEN) && !str(values.identifier) && !str(values.email) && values["password-stdin"] !== true && !process.env.QMD_PASSWORD) {
    token = str(process.env.QMD_HUB_TOKEN);
    tokenSource = "QMD_HUB_TOKEN";
  }
  if (tokenSource && !token) {
    io.err(`no token received from ${tokenSource}`);
    return 2;
  }

  try {
    if (token) {
      const id = await hubWhoami(hub, token);
      const kind = kindOf(id.method);
      const saved = getProfile(hub);
      const profile: HubProfile = {
        hub,
        kind,
        token,
        user: id.user,
        created_at: new Date().toISOString(),
        ...(kind === "accounts_session"
          ? { accounts_url: resolveAccountsUrl({ flag: str(values["accounts-url"]), saved: saved?.accounts_url }) }
          : {}),
      };
      putProfile(profile);
      report(io, values, profile, `token from ${tokenSource}`);
      return 0;
    }

    // ---- accounts.svc.plus password (+TOTP) --------------------------------------
    // Interactive: prompt email/username -> hidden password -> TOTP (only when accounts
    // answers mfaRequired), mirroring xworkmate-remote-desktop's login/MFA proxy.
    // Non-interactive ("all at once"): identifier, password and TOTP come from flags /
    // env / stdin and go out in ONE /api/auth/login call; no prompt is ever shown and a
    // missing MFA code exits with EXIT_MFA_REQUIRED.
    const envPassword = process.env.QMD_PASSWORD;
    const passwordFromStdin = values["password-stdin"] === true;
    const nonInteractive = values["non-interactive"] === true || !io.interactive || passwordFromStdin || Boolean(envPassword);
    let identifier = str(values.identifier) ?? str(values.email) ?? str(values.username) ?? str(process.env.QMD_IDENTIFIER) ?? str(process.env.QMD_EMAIL);
    let mfaCode = str(values["mfa-code"]) ?? str(values.totp) ?? str(values.code) ?? str(process.env.QMD_MFA_CODE);

    if (nonInteractive) {
      const missing: string[] = [];
      if (!identifier) missing.push("--email/--identifier (or QMD_EMAIL)");
      if (!passwordFromStdin && !envPassword) missing.push("--password-stdin (or QMD_PASSWORD)");
      if (missing.length) {
        io.err(`non-interactive login needs: ${missing.join(", ")}`);
        io.err("Or use a machine token: qmd login --token-stdin < token-file   (or QMD_HUB_TOKEN=...)");
        return EXIT_USAGE;
      }
    }

    const saved = getProfile(hub);
    const hints = str(values["accounts-url"]) ? {} : await discoverHubAuth(hub);
    const accounts = resolveAccountsUrl({ flag: str(values["accounts-url"]), saved: saved?.accounts_url, advertised: hints.accounts_url });
    io.err(`Signing in to QMD Hub ${hub}`);
    io.err(`Unified account service: ${accounts}`);

    if (!identifier) identifier = (await io.promptText("Email or username: ")).trim();
    if (!identifier) {
      io.err("an email or username is required");
      return EXIT_USAGE;
    }
    const password = passwordFromStdin ? await stdinLine(io) : envPassword ? envPassword : await io.promptSecret("Password (hidden): ");
    if (!password) {
      io.err("a password is required");
      return EXIT_USAGE;
    }

    let result = await accountsLogin(accounts, identifier, password, mfaCode);
    if (result.mfaRequired) {
      if (!result.mfaTicket) throw new Error("accounts requested MFA but returned no MFA ticket");
      if (nonInteractive) {
        io.err("this account requires MFA: re-run with --mfa-code <totp> (or --totp / QMD_MFA_CODE) in the same command");
        return EXIT_MFA_REQUIRED;
      }
      mfaCode = (await io.promptText(`Authenticator code (${(result.mfaMethod || "totp").toUpperCase()}): `)).trim();
      if (!mfaCode) {
        io.err("an authenticator code is required for this account");
        return EXIT_MFA_REQUIRED;
      }
      result = await accountsVerifyMfa(accounts, result.mfaTicket, mfaCode);
    }
    if (!result.token) throw new Error("accounts login did not return a session token");

    let id;
    try {
      id = await hubWhoami(hub, result.token);
    } catch (e) {
      // Do not leave an unusable session behind (e.g. role not allowed on this Hub).
      await accountsRevoke(accounts, result.token);
      throw e;
    }
    const profile: HubProfile = {
      hub,
      accounts_url: accounts,
      kind: kindOf(id.method),
      token: result.token,
      user: id.user ?? result.user,
      expires_at: result.expiresAt,
      created_at: new Date().toISOString(),
    };
    putProfile(profile);
    report(io, values, profile, `accounts session (${accounts})`);
    return 0;
  } catch (e) {
    io.err(`login failed: ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof HubAuthError && e.hints.login_url) io.err(`Web sign-in: ${e.hints.login_url}`);
    return 1;
  }
}

function report(io: LoginIO, values: Values, p: HubProfile, via: string): void {
  if (wantsJson(values)) {
    io.out(JSON.stringify({ logged_in: true, hub: p.hub, method: p.kind, user: p.user ?? null, accounts_url: p.accounts_url ?? null, expires_at: p.expires_at ?? null, credentials: getCredentialsPath() }, null, 2));
    return;
  }
  const who = p.kind === "static_token" ? "machine sync token" : describeUser(p.user) || "accounts session";
  io.out(`Logged in to ${p.hub} as ${who} (${p.kind}, via ${via}).`);
  if (p.expires_at) io.out(`Session expires at ${p.expires_at}.`);
  io.out(`Credentials saved to ${getCredentialsPath()} (mode 0600).`);
}

export async function runLogoutCommand(_args: string[], values: Values, io: LoginIO = defaultLoginIO()): Promise<number> {
  try {
    const targets: HubProfile[] = [];
    if (values.all === true) {
      targets.push(...Object.values(loadCredentials().profiles));
      if (targets.length) saveCredentials(emptyCredentials());
    } else {
      const hub = resolveHubUrl(str(values.hub));
      const removed = removeProfile(hub);
      if (removed) targets.push(removed);
      else {
        io.out(`Not logged in to ${hub}.`);
        return 0;
      }
    }
    for (const p of targets) {
      let revoked = "";
      if (p.kind === "accounts_session" && p.accounts_url && values["keep-session"] !== true) {
        revoked = (await accountsRevoke(p.accounts_url, p.token)) ? " (accounts session revoked)" : " (accounts session could not be revoked; it will expire)";
      }
      io.out(`Logged out of ${p.hub}${revoked}.`);
    }
    if (!targets.length) io.out("No saved Hub credentials.");
    return 0;
  } catch (e) {
    io.err(`logout failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

export async function runWhoamiCommand(_args: string[], values: Values, io: LoginIO = defaultLoginIO()): Promise<number> {
  let hub: string;
  try {
    hub = resolveHubUrl(str(values.hub));
  } catch (e) {
    io.err(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const cred = resolveHubToken(hub);
  if (!cred) {
    if (wantsJson(values)) io.out(JSON.stringify({ logged_in: false, hub }, null, 2));
    else io.out(`Not logged in to ${hub}. Run: qmd login${hub === resolveHubUrl() ? "" : ` --hub ${hub}`}`);
    return 1;
  }
  const profile = getProfile(hub);
  try {
    const id = await hubWhoami(hub, cred.token);
    if (wantsJson(values)) {
      io.out(JSON.stringify({ logged_in: true, hub, method: id.method, user: id.user ?? null, credential_source: cred.source, expires_at: profile?.expires_at ?? null }, null, 2));
    } else {
      const who = id.method === "static_token" ? "machine sync token" : describeUser(id.user) || "accounts session";
      io.out(`Hub:        ${hub}`);
      io.out(`Identity:   ${who}`);
      io.out(`Method:     ${id.method}`);
      if (profile?.accounts_url && id.method !== "static_token") io.out(`Accounts:   ${profile.accounts_url}`);
      if (profile?.expires_at) io.out(`Expires:    ${profile.expires_at}`);
      io.out(`Credential: ${cred.source}`);
    }
    return 0;
  } catch (e) {
    if (wantsJson(values)) io.out(JSON.stringify({ logged_in: false, hub, error: e instanceof Error ? e.message : String(e), credential_source: cred.source }, null, 2));
    else {
      io.err(e instanceof Error ? e.message : String(e));
      io.err(`Run: qmd login${hub === resolveHubUrl() ? "" : ` --hub ${hub}`}`);
    }
    return 1;
  }
}

export function printLoginHelp(io: Pick<LoginIO, "out"> = { out: (l) => console.log(l) }): void {
  const lines = [
    "Usage: qmd login [--hub <url>] [options]",
    "       qmd login status | qmd whoami [--hub <url>] [--json]",
    "       qmd logout [--hub <url>] [--all] [--keep-session]",
    "",
    "Sign in to a QMD Hub (default https://qmd.svc.plus, or any custom-domain Hub)",
    "with the accounts.svc.plus unified account. Credentials are stored per Hub in",
    "<config dir>/credentials.json (mode 0600).",
    "",
    "Hub selection: --hub > QMD_HUB_URL > index.yml hub.url > last login > https://qmd.svc.plus",
    "",
    "Interactive (TTY): prompts for email/username, a hidden password and, when the",
    "account has MFA, the authenticator (TOTP) code. Non-interactive: give everything at",
    "once (flags/env/stdin) and a single accounts call completes login + MFA. The session",
    "is verified against the Hub (the Hub enforces its role policy) before it is saved.",
    "Exit codes: 0 ok, 1 failed, 2 missing input, 3 MFA code required.",
    "",
    "Options:",
    "  --hub <url>              Hub URL or host (https; http only for localhost)",
    "  --accounts-url <url>     Account service (default: Hub-advertised, else https://accounts.svc.plus)",
    "  --email, --identifier <id>  Email or username (skips the prompt; env QMD_EMAIL)",
    "  --password-stdin         Read the password from stdin (recommended for scripts)",
    "  QMD_PASSWORD             Password from the environment (non-interactive)",
    "  --mfa-code, --totp <code>  Authenticator code sent with the password in one call (env QMD_MFA_CODE)",
    "  --non-interactive        Never prompt; fail with exit 2 (missing input) / 3 (MFA code required)",
    "  --token-stdin            Non-interactive: read a Hub sync token / accounts session token from stdin",
    "  --token <value>          Same as --token-stdin but from argv (lands in shell history)",
    "  QMD_HUB_TOKEN            Same, from the environment",
    "  --json                   Machine-readable output",
    "",
    "Examples:",
    "  qmd login",
    "  qmd login --hub qmd.example.com",
    "  qmd login --email me@example.com --password-stdin --mfa-code 123456 < pw-file",
    "  qmd login --token-stdin < /etc/qmd/hub-token",
    "  qmd whoami --json",
    "  qmd logout --all",
  ];
  for (const l of lines) io.out(l);
}
