import { afterEach, expect, test, vi } from "vitest";
import { PgMemoryStore } from "../src/pg/memory-store.js";
import { openMemoryBridge } from "../src/pg/index.js";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

test("PG memory uses the configured Ollama model rather than overriding it with the provider default", async () => {
  vi.stubEnv("QMD_EMBED_MODEL", "qwen3-embedding:0.6b");
  const open = vi.spyOn(PgMemoryStore, "open").mockResolvedValue({ close: async () => {} } as any);
  const bridge = await openMemoryBridge({ QMD_BACKEND: "pg", QMD_PG_URL: "postgres://test:test@127.0.0.1:5432/test" });
  try {
    expect(open).toHaveBeenCalledWith(expect.anything(), expect.anything(), { model: "qwen3-embedding:0.6b" });
  } finally { await bridge.dispose(); }
});
