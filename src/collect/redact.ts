/**
 * collect/redact.ts - Refuse to persist anything that looks like a credential
 *
 * Session transcripts routinely contain tokens pasted into commands. Context
 * items are shared across agents and machines, so an item containing a secret
 * is dropped outright — never masked and kept, because a partial mask still
 * leaks length, prefix and the fact that a secret lived there.
 */

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "openai-style-key", re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "nvidia-api-key", re: /\bnvapi-[A-Za-z0-9_-]{20,}\b/ },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "url-credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i },
  { name: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/ },
  {
    name: "assigned-secret",
    re: /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY)[A-Z0-9_]*\s*[=:]\s*['"]?[^\s'"$]{8,}/,
  },
];

/** Name of the first matching secret pattern, or undefined when clean. */
export function findSecret(text: string): string | undefined {
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) return name;
  }
  return undefined;
}
