import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import * as undici from "undici";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;

type DispatcherGlobal = typeof globalThis & {
  __piWebHttpDispatcherConfigured?: boolean;
};

const dispatcherGlobal = globalThis as DispatcherGlobal;
const originalGlobalFetch = globalThis.fetch;
const ignoreUndiciDispatcherError = (): void => {};

function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === "disabled") return 0;
    if (trimmed.length === 0) return undefined;
    return parseHttpIdleTimeoutMs(Number(trimmed));
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

// Undici can emit an internal Client error while terminating a response body.
// The body stream still rejects; this prevents the EventEmitter error from
// terminating the Next.js process first.
function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
  }
  return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
  return withUndiciErrorListener(
    new undici.Client(origin, options as undici.Client.Options),
  );
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
  const dispatcherOptions = options as undici.Pool.Options;
  if (dispatcherOptions.connections === 1) {
    return createUndiciClient(origin, dispatcherOptions);
  }

  return withUndiciErrorListener(
    new undici.Pool(origin, {
      ...dispatcherOptions,
      factory: createUndiciClient,
    }),
  );
}


/**
 * Per-provider proxy routing. Undici's EnvHttpProxyAgent is global (it reads
 * process env), which cannot express "this provider through its own proxy".
 * This wrapper lazily reads <agentDir>/models.json and dispatches requests
 * whose origin matches a provider's baseUrl through that provider's `proxy`
 * value; everything else falls through to the base dispatcher unchanged.
 */
class ProviderAwareDispatcher {
  private readonly base: undici.Dispatcher;
  private readonly timeoutMs: number;
  private lastCheckedMs = -1;
  private modelsMtimeMs = -1;
  private readonly proxyByOrigin = new Map<string, string>();
  private readonly agentsByProxy = new Map<string, undici.ProxyAgent>();

  constructor(base: undici.Dispatcher, timeoutMs: number) {
    this.base = base;
    this.timeoutMs = timeoutMs;
  }

  /** Rebuild the origin -> proxy map when models.json changes. */
  private refresh(): void {
    const now = Date.now();
    if (now - this.lastCheckedMs < 500) return;
    this.lastCheckedMs = now;

    let mtimeMs = -1;
    const modelsPath = join(getAgentDir(), "models.json");
    try {
      mtimeMs = statSync(modelsPath).mtimeMs;
    } catch {
      // models.json missing: fall back to the base dispatcher for everything.
    }
    if (mtimeMs === this.modelsMtimeMs) return;
    this.modelsMtimeMs = mtimeMs;

    this.proxyByOrigin.clear();
    if (mtimeMs < 0) return;

    try {
      const data = JSON.parse(readFileSync(modelsPath, "utf8")) as {
        providers?: Record<string, { baseUrl?: string; proxy?: string }>;
      };
      for (const provider of Object.values(data.providers ?? {})) {
        if (!provider?.proxy || !provider.baseUrl) continue;
        try {
          this.proxyByOrigin.set(new URL(provider.baseUrl).origin, provider.proxy);
        } catch {
          // Invalid baseUrl: skip this provider.
        }
      }
    } catch {
      // Corrupt models.json: fall back to the base dispatcher.
    }
  }

  dispatch(
    options: undici.Dispatcher.DispatchOptions,
    handler: undici.Dispatcher.DispatchHandler,
  ): boolean {
    this.refresh();
    const origin = options.origin ? new URL(String(options.origin)) : undefined;
    const proxyUrl = origin ? this.proxyByOrigin.get(origin.origin) : undefined;
    if (proxyUrl) {
      let agent = this.agentsByProxy.get(proxyUrl);
      if (!agent) {
        agent = withUndiciErrorListener(
          new undici.ProxyAgent({
            uri: proxyUrl,
            allowH2: false,
            bodyTimeout: this.timeoutMs,
            headersTimeout: this.timeoutMs,
            clientFactory: createUndiciClient,
            factory: createUndiciOriginDispatcher,
          }),
        );
        this.agentsByProxy.set(proxyUrl, agent);
      }
      return agent.dispatch(options, handler);
    }
    return this.base.dispatch(options, handler);
  }

  close(): Promise<void> {
    return this.base.close();
  }

  destroy(): Promise<void> {
    return this.base.destroy();
  }
}

export function configureHttpDispatcher(
  timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS,
): void {
  if (dispatcherGlobal.__piWebHttpDispatcherConfigured) return;

  const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
  if (normalizedTimeoutMs === undefined) {
    throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
  }

  const baseDispatcher = withUndiciErrorListener(
    new undici.EnvHttpProxyAgent({
      allowH2: false,
      bodyTimeout: normalizedTimeoutMs,
      headersTimeout: normalizedTimeoutMs,
      clientFactory: createUndiciClient,
      factory: createUndiciOriginDispatcher,
    }),
  );
  const dispatcher = new ProviderAwareDispatcher(baseDispatcher, normalizedTimeoutMs);
  undici.setGlobalDispatcher(dispatcher as unknown as undici.Dispatcher);

  // Keep fetch and the dispatcher on the same undici implementation. Preserve
  // an intentional fetch override installed after this module was loaded.
  if (globalThis.fetch === originalGlobalFetch) {
    undici.install?.();
  }

  dispatcherGlobal.__piWebHttpDispatcherConfigured = true;
}
