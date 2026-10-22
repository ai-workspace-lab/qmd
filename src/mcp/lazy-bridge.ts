/**
 * mcp/lazy-bridge.ts - Open a PG-backed bridge on first use, and retry later
 *
 * Clients start their stdio MCP servers when they launch, which is often before
 * PostgreSQL is up. Opening the bridge eagerly and giving up on the first
 * failure left those sessions without task tools for their whole lifetime.
 * A LazyBridge is registered up front; each tool call asks it for the bridge,
 * which connects on demand and, after a failure, tries again once the retry
 * interval has passed.
 */

export class BridgeUnavailableError extends Error {
  constructor(label: string, cause: Error) {
    super(`${label} is unavailable: ${cause.message}`);
    this.name = "BridgeUnavailableError";
  }
}

export class LazyBridge<T extends { dispose(): Promise<void> }> {
  private value: T | undefined;
  private pending: Promise<T> | undefined;
  private lastError: Error | undefined;
  private lastAttemptAt = 0;

  constructor(
    private readonly label: string,
    private readonly open: () => Promise<T>,
    private readonly retryMs = 5_000,
  ) {}

  /** The bridge if it is already open. */
  get current(): T | undefined {
    return this.value;
  }

  /** Open (or return) the bridge; throws BridgeUnavailableError when it cannot. */
  async get(): Promise<T> {
    if (this.value) return this.value;
    if (this.pending) return this.pending;
    if (this.lastError && Date.now() - this.lastAttemptAt < this.retryMs) {
      throw new BridgeUnavailableError(this.label, this.lastError);
    }
    this.lastAttemptAt = Date.now();
    this.pending = this.open()
      .then((value) => {
        this.value = value;
        this.lastError = undefined;
        return value;
      })
      .catch((err: Error) => {
        this.lastError = err;
        console.error(`[qmd:mcp] ${this.label} unavailable (will retry): ${err.message}`);
        throw new BridgeUnavailableError(this.label, err);
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  /** Like get(), but undefined instead of throwing. */
  async tryGet(): Promise<T | undefined> {
    try {
      return await this.get();
    } catch {
      return undefined;
    }
  }

  async dispose(): Promise<void> {
    const value = this.value;
    this.value = undefined;
    if (value) await value.dispose();
  }
}

/** MCP tool result for a call that could not reach its bridge. */
export function unavailableResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [
      {
        type: "text" as const,
        text: `${message}. Start PostgreSQL (and check QMD_PG_URL), then call this tool again — no restart needed.`,
      },
    ],
    isError: true,
  };
}
