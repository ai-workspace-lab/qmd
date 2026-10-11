/**
 * tier/summarize.ts - Pluggable summarizer (PLAN 2.3).
 *
 * The default is deterministic and extractive (no model call), so tests and
 * offline runs are reproducible. An LLM summarizer can be plugged in by the
 * routine later through the same interface.
 */

export interface SummaryInput {
  title: string | null;
  body: string;
  kind: string;
}

export interface Summarizer {
  readonly name: string;
  summarize(input: SummaryInput): Promise<string>;
}

export const SUMMARY_MAX_CHARS = 1200;

const NOISE = /^(?:-{3,}|#{1,6}\s*$|```|\s*[-*]\s*(?:来源|时间|模型|角色|source|time|model|role)\s*[:：])/i;

/** First meaningful lines of the body, de-duplicated, capped at 1200 chars. */
export class ExtractiveSummarizer implements Summarizer {
  readonly name = "extractive-v1";

  async summarize(input: SummaryInput): Promise<string> {
    const body = stripFrontmatter(input.body);
    const seen = new Set<string>();
    const lines: string[] = [];
    let len = 0;
    for (const raw of body.split("\n")) {
      const line = raw.replace(/^#+\s*/, "").replace(/^\s*[-*>]\s+/, "").trim();
      if (!line || NOISE.test(raw)) continue;
      if (input.title && line === input.title.trim()) continue;
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (len + line.length + 1 > SUMMARY_MAX_CHARS) {
        const room = SUMMARY_MAX_CHARS - len - 1;
        if (room > 20) lines.push(line.slice(0, room - 1) + "…");
        break;
      }
      lines.push(line);
      len += line.length + 1;
    }
    const head = input.title ? `${input.title.trim()}：` : "";
    return (head + lines.join(" ")).slice(0, SUMMARY_MAX_CHARS);
  }
}

export function stripFrontmatter(text: string): string {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return text;
  return text.slice(text.indexOf("\n", end + 1) + 1).replace(/^\s+/, "");
}
