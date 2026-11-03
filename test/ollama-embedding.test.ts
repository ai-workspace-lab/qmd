import { afterEach, expect, test, vi } from "vitest";
import { LlamaCpp } from "../src/llm.js";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function noKey() {
  for (const key of ["QMD_EMBED_API_KEY", "NVIDIA_API_KEY", "OPENAI_API_KEY"]) vi.stubEnv(key, "");
}

test.each(["127.0.0.1", "localhost", "[::1]"])("local Ollama embeddings need no key on %s", async host => {
  noKey();
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ model: "qwen3-embedding:0.6b", data: [{ index: 0, embedding: [0.1, 0.2] }] })));
  const llm = new LlamaCpp({ embedModel: "qwen3-embedding:0.6b", embedApiBaseUrl: `http://${host}:11434/v1` });
  expect(await llm.embed("中文技术文档")).toEqual({ model: "qwen3-embedding:0.6b", embedding: [0.1, 0.2] });
  expect(fetch).toHaveBeenCalledWith(`http://${host}:11434/v1/embeddings`, expect.objectContaining({ headers: { "Content-Type": "application/json" } }));
});

test.each(["https://integrate.api.nvidia.com/v1", "http://127.0.0.1.example.com/v1"])("remote embedding still requires credentials: %s", async endpoint => {
  noKey();
  const fetch = vi.spyOn(globalThis, "fetch");
  const llm = new LlamaCpp({ embedModel: "qwen3-embedding:0.6b", embedApiBaseUrl: endpoint });
  await expect(llm.embed("test")).rejects.toThrow(/API key is required/);
  expect(fetch).not.toHaveBeenCalled();
});
