import { test as base, type Page } from "@playwright/test";

export type MockStoreData = Record<string, unknown>;

export type TauriMockOptions = {
  /** Pre-populated store data keyed by store key (e.g. "repos", "recents") */
  storeData?: MockStoreData;
  /** Override individual invoke handlers: cmd -> return value or function */
  invokeHandlers?: Record<string, unknown>;
};

const DEFAULT_REPOS: unknown[] = [];

/**
 * Injects Tauri IPC mocks into the page before the app loads.
 * All `invoke`, `listen`, plugin:store, and plugin:dialog calls are handled in-browser.
 */
async function injectTauriMocks(page: Page, opts: TauriMockOptions = {}) {
  const storeData = opts.storeData ?? { repos: DEFAULT_REPOS };
  // Pre-evaluate function handlers since addInitScript serializes args (functions aren't serializable)
  const rawHandlers = opts.invokeHandlers ?? {};
  const invokeHandlers: Record<string, unknown> = {};
  for (const [cmd, handler] of Object.entries(rawHandlers)) {
    invokeHandlers[cmd] = typeof handler === "function" ? handler() : handler;
  }

  await page.addInitScript(
    ({ storeData, invokeHandlers }) => {
      const store = new Map<string, unknown>(Object.entries(storeData));
      type Callback = (...args: unknown[]) => void;
      const callbacks = new Map<number, Callback>();
      const eventListeners = new Map<string, number[]>();

      function registerCallback(cb: Callback, once = false): number {
        const id = Math.floor(Math.random() * 2 ** 32);
        callbacks.set(id, (data: unknown) => {
          if (once) callbacks.delete(id);
          return cb(data);
        });
        return id;
      }

      function unregisterCallback(id: number) {
        callbacks.delete(id);
      }

      function runCallback(id: number, data: unknown) {
        const cb = callbacks.get(id);
        if (cb) cb(data);
      }

      async function invoke(cmd: string, args: Record<string, unknown> = {}) {
        // Check custom handlers first
        if (cmd in invokeHandlers) {
          const handler = invokeHandlers[cmd];
          return typeof handler === "function" ? handler(args) : handler;
        }

        // Store plugin
        if (cmd === "plugin:store|load") return 1;
        if (cmd === "plugin:store|get") {
          const key = args.key as string;
          return [store.get(key) ?? null, store.has(key)];
        }
        if (cmd === "plugin:store|set") {
          store.set(args.key as string, args.value);
          return;
        }
        if (cmd === "plugin:store|save") return;
        if (cmd === "plugin:store|has") return store.has(args.key as string);
        if (cmd === "plugin:store|keys") return [...store.keys()];
        if (cmd === "plugin:store|delete") {
          store.delete(args.key as string);
          return true;
        }
        if (cmd === "plugin:store|clear") {
          store.clear();
          return;
        }

        // Dialog plugin
        if (cmd === "plugin:dialog|open") return null;

        // Event plugin
        if (cmd === "plugin:event|listen") {
          const event = args.event as string;
          const handler = args.handler as number;
          if (!eventListeners.has(event)) eventListeners.set(event, []);
          eventListeners.get(event)!.push(handler);
          return handler;
        }
        if (cmd === "plugin:event|unlisten") {
          const event = args.event as string;
          const handlers = eventListeners.get(event);
          if (handlers) {
            const idx = handlers.indexOf(args.id as number);
            if (idx !== -1) handlers.splice(idx, 1);
          }
          return;
        }
        if (cmd === "plugin:event|emit") {
          const handlers = eventListeners.get(args.event as string) ?? [];
          for (const id of handlers) runCallback(id, args);
          return;
        }

        // App commands — return empty defaults
        if (cmd === "list_traces") return [];
        if (cmd === "get_trace") return null;
        if (cmd === "get_trace_events") return [];
        if (cmd === "stop_session") return;

        console.warn(`[tauri-mock] unhandled invoke: ${cmd}`, args);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tauri global mock
      (window as any).__TAURI_INTERNALS__ = {
        invoke,
        transformCallback: registerCallback,
        unregisterCallback,
        runCallback,
        callbacks,
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { windowLabel: "main", label: "main" },
        },
        plugins: {
          path: { sep: "/", delimiter: ":" },
        },
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tauri global mock
      (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener: (event: string, id: number) => {
          unregisterCallback(id);
        },
      };
    },
    { storeData, invokeHandlers },
  );
}

export const test = base.extend<{ tauriPage: Page; mockTauri: (opts?: TauriMockOptions) => Promise<void> }>({
  mockTauri: async ({ page }, use) => {
    await use(async (opts?: TauriMockOptions) => {
      await injectTauriMocks(page, opts);
    });
  },
  tauriPage: async ({ page, mockTauri }, use) => {
    // Default: inject mocks with empty repos, then navigate
    await mockTauri();
    await page.goto("/");
    await use(page);
  },
});

export { expect } from "@playwright/test";
