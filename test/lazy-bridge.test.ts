/**
 * lazy-bridge.test.ts - PG bridges connect on first use and recover later.
 */

import { describe, test, expect, vi, afterEach } from "vitest";
import { BridgeUnavailableError, LazyBridge, unavailableResult } from "../src/mcp/lazy-bridge.js";

const bridgeValue = () => ({ dispose: vi.fn(async () => {}) });

afterEach(() => {
  vi.useRealTimers();
});

describe("LazyBridge", () => {
  test("does not connect until first use, then reuses the connection", async () => {
    const open = vi.fn(async () => bridgeValue());
    const lazy = new LazyBridge("test", open);
    expect(open).not.toHaveBeenCalled();
    const a = await lazy.get();
    const b = await lazy.get();
    expect(a).toBe(b);
    expect(open).toHaveBeenCalledTimes(1);
  });

  test("concurrent callers share one connection attempt", async () => {
    let release!: (v: ReturnType<typeof bridgeValue>) => void;
    const open = vi.fn(() => new Promise<ReturnType<typeof bridgeValue>>((r) => (release = r)));
    const lazy = new LazyBridge("test", open);
    const calls = [lazy.get(), lazy.get(), lazy.get()];
    release(bridgeValue());
    const values = await Promise.all(calls);
    expect(new Set(values).size).toBe(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  test("after a failure it waits for the retry interval, then recovers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T10:00:00Z"));
    const open = vi
      .fn<() => Promise<ReturnType<typeof bridgeValue>>>()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue(bridgeValue());
    const lazy = new LazyBridge("pg", open, 5_000);

    await expect(lazy.get()).rejects.toBeInstanceOf(BridgeUnavailableError);
    await expect(lazy.get()).rejects.toThrow(/pg is unavailable: ECONNREFUSED/);
    expect(open).toHaveBeenCalledTimes(1); // still inside the retry window

    vi.setSystemTime(new Date("2026-09-18T10:00:06Z"));
    await expect(lazy.get()).resolves.toBeDefined();
    expect(open).toHaveBeenCalledTimes(2);
    expect(await lazy.tryGet()).toBeDefined();
  });

  test("tryGet returns undefined instead of throwing", async () => {
    const lazy = new LazyBridge("pg", async () => {
      throw new Error("down");
    });
    expect(await lazy.tryGet()).toBeUndefined();
  });

  test("dispose closes an open connection", async () => {
    const value = bridgeValue();
    const lazy = new LazyBridge("pg", async () => value);
    await lazy.get();
    await lazy.dispose();
    expect(value.dispose).toHaveBeenCalledTimes(1);
    expect(lazy.current).toBeUndefined();
  });

  test("unavailable tool results are explicit errors", () => {
    const result = unavailableResult(new BridgeUnavailableError("pg", new Error("down")));
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/pg is unavailable: down.*no restart needed/);
  });
});
