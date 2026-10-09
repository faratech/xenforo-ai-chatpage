// @vitest-environment node
/**
 * #9: the public-shell service worker never serves executable assets or the
 * offline document from Cache Storage, which any windowsforum.com page can
 * write. Runs the real worker script against fake caches/fetch with poisoned
 * entries in every cache.
 */
import { describe, expect, it } from 'vitest';
import workerSource from '../../public/service-worker.js?raw';
import offlineHtml from '../../public/offline.html?raw';

const ORIGIN = 'https://windowsforum.com';
const POISON = '<script>steal()</script>';

interface FakeRequest { url: string; method: string; mode: string }
type RequestLike = FakeRequest | string;
interface FetchEvent { request: FakeRequest; respondWith: (response: Promise<Response> | Response) => void }
interface ExtendableEvent { waitUntil: (promise: Promise<unknown>) => void }
type Listener = (event: FetchEvent & ExtendableEvent) => void;

const keyOf = (request: RequestLike): string => (
  typeof request === 'string' ? new URL(request, ORIGIN).href : request.url
);

class FakeCache {
  readonly entries = new Map<string, string>();
  async match(request: RequestLike): Promise<Response | undefined> {
    const body = this.entries.get(keyOf(request));
    return body === undefined ? undefined : new Response(body);
  }
  async put(request: RequestLike, response: Response): Promise<void> {
    this.entries.set(keyOf(request), await response.text());
  }
  async add(url: string): Promise<void> {
    this.entries.set(keyOf(url), `precached ${url}`);
  }
  async keys(): Promise<FakeRequest[]> {
    return [...this.entries.keys()].map(url => ({ url, method: 'GET', mode: 'no-cors' }));
  }
  async delete(request: RequestLike): Promise<boolean> {
    return this.entries.delete(keyOf(request));
  }
}

function loadWorker() {
  const listeners: Record<string, Listener> = {};
  const stores = new Map<string, FakeCache>();
  const network = { online: true, requests: [] as string[] };
  const openCache = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new FakeCache());
    return stores.get(name) as FakeCache;
  };
  const caches = {
    open: openCache,
    async match(request: RequestLike) {
      for (const cache of stores.values()) {
        const hit = await cache.match(request);
        if (hit) return hit;
      }
      return undefined;
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const fakeFetch = async (request: RequestLike) => {
    network.requests.push(keyOf(request));
    if (!network.online) throw new TypeError('Failed to fetch');
    return new Response(`network ${keyOf(request)}`);
  };
  const self = {
    location: new URL(`${ORIGIN}/chatpage/service-worker.js`),
    addEventListener: (type: string, listener: Listener) => { listeners[type] = listener; },
    clients: { claim: async () => undefined },
    skipWaiting: async () => undefined,
  };
  const quietConsole = { warn: () => undefined, log: () => undefined, error: () => undefined };
  new Function('self', 'caches', 'fetch', 'URL', 'Response', 'console', workerSource)(
    self, caches, fakeFetch, URL, Response, quietConsole,
  );

  const dispatch = async (type: string, request?: FakeRequest) => {
    let response: Promise<Response> | undefined;
    const pending: Promise<unknown>[] = [];
    listeners[type]({
      request: request as FakeRequest,
      respondWith: value => { response = Promise.resolve(value); },
      waitUntil: promise => { pending.push(promise); },
    });
    await Promise.all(pending);
    return response;
  };

  // Poison every cache the worker could consult, including its own by name.
  const poison = async (...paths: string[]) => {
    for (const name of ['wf-ai-public-shell-v1', 'wf-ai-public-shell-v2', 'attacker-cache']) {
      const cache = await openCache(name);
      for (const path of paths) cache.entries.set(keyOf(path), POISON);
    }
  };

  return { dispatch, poison, stores, network };
}

const get = (path: string, mode = 'no-cors'): FakeRequest => ({ url: `${ORIGIN}${path}`, method: 'GET', mode });

describe('public-shell service worker (#9)', () => {
  it('never answers executable chunks itself, even when a poisoned copy is cached', async () => {
    const worker = loadWorker();
    const paths = [
      '/chatpage/static/js/ChatWindow-a1b2c3d4e5.chunk.js',
      '/chatpage/static/js/main.js',
      '/chatpage/static/css/main.css',
      '/chatpage/static/css/vendor-0123456789ab.css',
      '/chatpage/static/js/helpers-a1b2c3d4e5.mjs',
    ];
    await worker.poison(...paths);
    for (const path of paths) {
      expect(await worker.dispatch('fetch', get(path))).toBeUndefined();
    }
  });

  it('builds the offline page from the worker script, never from Cache Storage', async () => {
    const worker = loadWorker();
    await worker.poison('/chatpage/offline.html');
    worker.network.online = false;
    const response = await worker.dispatch('fetch', get('/pages/ai/c/abc', 'navigate'));
    expect(response).toBeDefined();
    const body = await (response as Response).text();
    expect(body).toBe(offlineHtml);
    expect(body).not.toContain(POISON);
    expect((response as Response).headers.get('content-type')).toContain('text/html');
  });

  it('keeps navigations network-only while online', async () => {
    const worker = loadWorker();
    const response = await worker.dispatch('fetch', get('/pages/ai/', 'navigate'));
    expect(await (response as Response).text()).toBe(`network ${ORIGIN}/pages/ai/`);
    expect(worker.stores.get('wf-ai-public-shell-v2')?.entries.size ?? 0).toBe(0);
  });

  it('serves non-executable public assets network-first and from its cache only offline', async () => {
    const worker = loadWorker();
    const icon = get('/chatpage/pwa-icon-192.png');
    expect(await (await worker.dispatch('fetch', icon) as Response).text()).toBe(`network ${icon.url}`);
    worker.network.online = false;
    expect(await (await worker.dispatch('fetch', icon) as Response).text()).toBe(`network ${icon.url}`);
  });

  it('installs without an offline precache and drops the v1 cache on activate', async () => {
    const worker = loadWorker();
    await worker.poison('/chatpage/static/js/ChatWindow-a1b2c3d4e5.chunk.js');
    await worker.dispatch('install');
    const current = worker.stores.get('wf-ai-public-shell-v2') as FakeCache;
    expect(current.entries.has(`${ORIGIN}/chatpage/offline.html`)).toBe(false);
    expect(current.entries.has(`${ORIGIN}/chatpage/manifest.json`)).toBe(true);
    await worker.dispatch('activate');
    expect(worker.stores.has('wf-ai-public-shell-v1')).toBe(false);
    expect(worker.stores.has('wf-ai-public-shell-v2')).toBe(true);
  });
});
