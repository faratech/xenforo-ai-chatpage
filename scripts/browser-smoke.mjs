#!/usr/bin/env node
/* global document -- page.evaluate() callbacks run in the browser context;
   everything else in this file is Node. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:https';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const distRoot = path.join(projectRoot, 'dist');
const require = createRequire(import.meta.url);
const axePath = require.resolve('axe-core/axe.min.js');
const identityId = '1'.repeat(64);
const scenarios = new Map();

const executableCandidates = [
  process.env.WF_CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const executablePath = executableCandidates.find(candidate => existsSync(candidate));
assert(executablePath, 'No system Chrome/Chromium executable was found. Set WF_CHROME_PATH.');

let certPath = process.env.WF_BROWSER_SMOKE_CERT
  || '/etc/letsencrypt/live/windowsforum.com/fullchain.pem';
let keyPath = process.env.WF_BROWSER_SMOKE_KEY
  || '/etc/letsencrypt/live/windowsforum.com/privkey.pem';
let temporaryTlsDirectory = null;
if (!existsSync(certPath) || !existsSync(keyPath)) {
  temporaryTlsDirectory = await mkdtemp(path.join(os.tmpdir(), 'wf-chat-browser-smoke-'));
  certPath = path.join(temporaryTlsDirectory, 'cert.pem');
  keyPath = path.join(temporaryTlsDirectory, 'key.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1',
    '-keyout', keyPath,
    '-out', certPath,
  ], { stdio: 'ignore' });
}

const json = (response, status, body, request) => {
  const origin = request.headers.origin;
  response.writeHead(status, {
    'access-control-allow-credentials': 'true',
    'access-control-allow-origin': origin || '*',
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
};

const streamAnswer = async (request, response, state, { slow = false } = {}) => {
  const origin = request.headers.origin;
  response.writeHead(200, {
    'access-control-allow-credentials': 'true',
    'access-control-allow-origin': origin || '*',
    'cache-control': 'no-store',
    'content-type': 'text/event-stream; charset=utf-8',
    'x-accel-buffering': 'no',
  });
  response.write('data: {"type":"response.output_text.delta","delta":"Browser smoke"}\n\n');

  if (slow) {
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 5_000);
      const stopped = () => {
        clearTimeout(timer);
        state.streamAborted = true;
        resolve();
      };
      request.once('aborted', stopped);
      response.once('close', stopped);
    });
    if (state.streamAborted || response.destroyed) return;
  }

  response.write('data: {"type":"response.output_text.delta","delta":" reply"}\n\n');
  response.end('data: {"type":"chat.stream.completed","response_id":"resp_browser_smoke"}\n\n');
};

const mime = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'],
]);

const server = createServer({
  cert: await readFile(certPath),
  key: await readFile(keyPath),
}, async (request, response) => {
  const requestUrl = new URL(request.url || '/', 'https://browser-smoke.invalid');
  const scenarioName = String(request.headers['x-wf-smoke-scenario'] || 'unscoped');
  const state = scenarios.get(scenarioName);

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'content-type,x-wf-turn-id',
      'access-control-allow-methods': 'GET,HEAD,POST,OPTIONS',
      'access-control-allow-origin': request.headers.origin || '*',
      'access-control-max-age': '60',
    });
    response.end();
    return;
  }

  if (requestUrl.pathname === '/chat.php' && request.method === 'POST') {
    if (!state) {
      // A throw inside this async handler escapes as an unhandled rejection,
      // killing the whole smoke run without saying which scenario broke.
      console.error(`[smoke] API request arrived without a known smoke scenario: ${scenarioName}`);
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`unknown smoke scenario: ${scenarioName}`);
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body || '{}');

    if (payload.action === 'getUserData') {
      state.identityCalls += 1;
      json(response, 200, {
        avatar: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E',
        identity_id: identityId,
        name: 'Browser Smoke',
        user_id: '42',
      }, request);
      return;
    }
    if (payload.action === 'getUsage') {
      json(response, 200, { logged_in: true, remaining: 10, used: 0, limit: 10 }, request);
      return;
    }
    if (payload.action === 'clientTelemetry') {
      state.telemetry.push(payload);
      json(response, 200, { success: true }, request);
      return;
    }
    if (payload.action === 'clearConversation' || payload.action === 'deleteConversation') {
      json(response, 200, { success: true }, request);
      return;
    }

    state.chatPayloads.push(payload);
    if (state.mode === 'captcha' && state.chatPayloads.length === 1) {
      json(response, 403, { captcha_required: true, error: 'captcha_required' }, request);
      return;
    }
    await streamAnswer(request, response, state, { slow: state.mode === 'abort' });
    return;
  }

  if (requestUrl.pathname === '/tts.php') {
    response.writeHead(204, { 'cache-control': 'no-store' });
    response.end();
    return;
  }

  let relative = requestUrl.pathname.startsWith('/chatpage/')
    ? requestUrl.pathname.slice('/chatpage/'.length)
    : '';
  if (!relative) relative = 'index.html';
  const filePath = path.resolve(distRoot, relative);
  if (!filePath.startsWith(`${distRoot}${path.sep}`)) {
    response.writeHead(403);
    response.end();
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error('not a file');
    const headers = {
      'cache-control': 'no-store',
      'content-type': mime.get(path.extname(filePath)) || 'application/octet-stream',
    };
    if (requestUrl.pathname === '/chatpage/service-worker.js') {
      headers['service-worker-allowed'] = '/pages/ai/';
    }
    response.writeHead(200, headers);
    response.end(await readFile(filePath));
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert(address && typeof address === 'object');
const origin = `https://127.0.0.1:${address.port}`;

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--disable-dev-shm-usage', '--ignore-certificate-errors', '--no-sandbox'],
});

const createPage = async (
  name,
  mode,
  {
    failChatChunk = false,
    failPreferencesChunkOnce = false,
    blockServiceWorkers = false,
    viewport,
  } = {},
) => {
  const state = {
    chatPayloads: [],
    identityCalls: 0,
    mode,
    optionalChunkFailures: 0,
    optionalChunkRequests: 0,
    streamAborted: false,
    telemetry: [],
  };
  scenarios.set(name, state);
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    serviceWorkers: blockServiceWorkers ? 'block' : 'allow',
    ...(viewport ? { viewport } : {}),
  });
  const page = await context.newPage();
  const routeApi = async route => {
    const request = route.request();
    const headers = { ...request.headers(), 'x-wf-smoke-scenario': name };
    const url = new URL(request.url());
    if (url.hostname === 'windowsforum.com') {
      url.protocol = 'https:';
      url.hostname = '127.0.0.1';
      url.port = String(address.port);
    }
    await route.continue({ headers, url: url.toString() });
  };
  await page.route('**/chat.php', routeApi);
  await page.route('**/tts.php', routeApi);
  await page.route('https://challenges.cloudflare.com/turnstile/**', async route => {
    await route.fulfill({
      contentType: 'text/javascript',
      body: `window.turnstile={render:function(_selector,options){setTimeout(function(){options.callback('browser-smoke-token')},0);return 'browser-smoke-widget'},remove:function(){},reset:function(){}};`,
    });
  });
  if (failChatChunk) {
    await page.route(/\/ChatWindow-[^/]+\.chunk\.js(?:\?.*)?$/, route => route.abort('failed'));
  }
  if (failPreferencesChunkOnce) {
    await page.route(/\/PreferencesDialog-[^/]+\.chunk\.js(?:\?.*)?$/, route => {
      state.optionalChunkRequests += 1;
      if (state.optionalChunkFailures === 0) {
        state.optionalChunkFailures += 1;
        return route.abort('failed');
      }
      return route.continue();
    });
  }
  return { context, page, state };
};

const waitForComposer = page => page.getByRole('textbox', { name: 'Type your message' }).waitFor();

try {
  const manifest = JSON.parse(await readFile(path.join(distRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.id, '/pages/ai/');
  assert.equal(manifest.start_url, '/pages/ai/');
  assert.equal(manifest.scope, '/pages/ai/');

  {
    const { context, page } = await createPage('pwa-canonical', 'completion');
    await page.goto(`${origin}/pages/ai/`);
    await waitForComposer(page);
    let pwaState;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      pwaState = await page.evaluate(async () => ({
        secure: globalThis.isSecureContext,
        supported: 'serviceWorker' in globalThis.navigator,
        manifest: globalThis.document.querySelector('link[rel="manifest"]')?.getAttribute('href'),
        scopes: (await globalThis.navigator.serviceWorker.getRegistrations())
          .map(registration => registration.scope),
      }));
      if (pwaState.scopes.includes(`${origin}/pages/ai/`)) break;
      await page.waitForTimeout(100);
    }
    assert.equal(pwaState.manifest, '/chatpage/manifest.json');
    assert(
      pwaState.scopes.includes(`${origin}/pages/ai/`),
      `canonical service worker scope was not registered: ${JSON.stringify(pwaState)}`,
    );
    await context.close();
  }

  {
    const { context, page, state } = await createPage('completion', 'completion');
    await page.goto(`${origin}/chatpage/`, { waitUntil: 'networkidle' });
    await waitForComposer(page);
    await page.waitForTimeout(500);
    assert.equal(state.identityCalls, 1, 'cold load must issue exactly one getUserData request');

    const entries = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name));
    const mainScripts = entries.filter(url => new URL(url).pathname.endsWith('/static/js/main.js'));
    const mainStyles = entries.filter(url => new URL(url).pathname.endsWith('/static/css/main.css'));
    assert.equal(mainScripts.length, 1, `expected one stable main.js fetch, saw ${mainScripts.join(', ')}`);
    assert.equal(mainStyles.length, 1, `expected one stable main.css fetch, saw ${mainStyles.join(', ')}`);

    await page.getByRole('textbox', { name: 'Type your message' }).fill('Browser completion test');
    await page.getByRole('button', { name: 'Send message' }).click();
    await page.getByText('Browser smoke reply', { exact: true }).waitFor();
    assert.equal(state.chatPayloads.length, 1);
    assert.equal(state.chatPayloads[0].expected_identity_id, identityId);

    await page.addScriptTag({ path: axePath });
    const axeResult = await page.evaluate(async () => {
      const result = await globalThis.axe.run(globalThis.document, {
        resultTypes: ['violations'],
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      });
      return result.violations
        .filter(item => item.impact === 'serious' || item.impact === 'critical')
        .map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.length }));
    });
    assert.deepEqual(axeResult, [], `serious accessibility violations: ${JSON.stringify(axeResult)}`);
    await context.close();
  }

  {
    const mobileViewport = { width: 390, height: 844 };
    const { context, page, state } = await createPage('cold-mobile', 'completion', {
      viewport: mobileViewport,
    });
    const debugCls = process.env.WF_SMOKE_DEBUG_CLS === '1';
    await page.addInitScript(captureSources => {
      globalThis.__wfSmokeVitals = { cls: 0, lcp: 0, shifts: [] };
      try {
        new PerformanceObserver(list => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1];
          if (last) globalThis.__wfSmokeVitals.lcp = last.startTime;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            if (entry.hadRecentInput) continue;
            globalThis.__wfSmokeVitals.cls += entry.value || 0;
            // WF_SMOKE_DEBUG_CLS=1 makes a budget failure diagnosable: which
            // nodes moved, when, and from where to where.
            if (captureSources) {
              globalThis.__wfSmokeVitals.shifts.push({
                value: entry.value,
                time: Math.round(entry.startTime),
                sources: (entry.sources ?? []).map(source => {
                  const node = source.node;
                  const label = node && node.getAttribute ? (node.getAttribute('aria-label') || node.id || '') : '';
                  return {
                    node: node
                      ? `${node.tagName}.${String(node.className ?? '').slice(0, 40)}[${label}]`
                      : 'null',
                    prev: source.previousRect ? [Math.round(source.previousRect.x), Math.round(source.previousRect.y)] : null,
                    cur: source.currentRect ? [Math.round(source.currentRect.x), Math.round(source.currentRect.y)] : null,
                  };
                }),
              });
            }
          }
        }).observe({ type: 'layout-shift', buffered: true });
      } catch {
        // Startup timing below still provides coverage in older Chromium.
      }
    }, debugCls);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 100,
      downloadThroughput: 200_000,
      uploadThroughput: 75_000,
      connectionType: 'cellular3g',
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const startedAt = Date.now();
    await page.goto(`${origin}/chatpage/`);
    await waitForComposer(page);
    const composerReadyMs = Date.now() - startedAt;
    if (debugCls) {
      // Is the read-aloud button present at composer-ready, or does it mount
      // during the shift window?
      globalThis.__wfInputProbeAtReady = await page.evaluate(() => {
        const area = document.querySelector('.wf-input-area');
        const mute = document.querySelector('button[aria-label="Mute read-aloud"], button[aria-label="Enable read-aloud"]');
        return {
          areaHeight: area?.getBoundingClientRect().height ?? null,
          mutePresent: Boolean(mute),
          buttons: [...(area?.querySelectorAll('button') ?? [])].map(b => b.getAttribute('aria-label')),
        };
      });
      globalThis.__wfRegionProbe = await page.evaluate(() => {
        const dump = [];
        const walk = (el, depth) => {
          if (!el || depth > 3) return;
          const r = el.getBoundingClientRect();
          dump.push(`${'  '.repeat(depth)}${el.tagName}.${String(el.className).slice(0, 40)} h=${Math.round(r.height)} y=${Math.round(r.y)}`);
          for (const child of [...el.children].slice(0, 8)) walk(child, depth + 1);
        };
        walk(document.querySelector('#wf-chat-window'), 0);
        return dump;
      });
    }
    await page.waitForTimeout(500);
    if (debugCls) {
      globalThis.__wfRegionProbeAfter = null;
      globalThis.__wfRegionProbeAfter = await page.evaluate(() => {
        const dump = [];
        const walk = (el, depth) => {
          if (!el || depth > 3) return;
          const r = el.getBoundingClientRect();
          dump.push(`${'  '.repeat(depth)}${el.tagName}.${String(el.className).slice(0, 40)} h=${Math.round(r.height)} y=${Math.round(r.y)}`);
          for (const child of [...el.children].slice(0, 8)) walk(child, depth + 1);
        };
        walk(document.querySelector('#wf-chat-window'), 0);
        return dump;
      });
      globalThis.__wfInputProbeAfter = await page.evaluate(() => {
        const area = document.querySelector('.wf-input-area');
        const mute = document.querySelector('button[aria-label="Mute read-aloud"], button[aria-label="Enable read-aloud"]');
        return {
          areaHeight: area?.getBoundingClientRect().height ?? null,
          mutePresent: Boolean(mute),
          buttons: [...(area?.querySelectorAll('button') ?? [])].map(b => b.getAttribute('aria-label')),
          placeholderLines: Math.round((document.querySelector('.wf-input-area textarea')?.getBoundingClientRect().height ?? 0) / 21),
          alerts: [...document.querySelectorAll('#wf-chat-window [role="alert"]')].map(a => a.textContent?.slice(0, 90)),
        };
      });
    }
    const vitals = await page.evaluate(() => {
      const firstContentfulPaint = performance.getEntriesByName('first-contentful-paint')[0];
      return {
        cls: globalThis.__wfSmokeVitals?.cls ?? 0,
        fcp: firstContentfulPaint?.startTime ?? 0,
        lcp: globalThis.__wfSmokeVitals?.lcp ?? 0,
        shifts: globalThis.__wfSmokeVitals?.shifts ?? [],
      };
    });
    if (debugCls && vitals.cls > 0.05) {
      console.log(`[smoke] input-area at composer-ready: ${JSON.stringify(globalThis.__wfInputProbeAtReady)}`);
      console.log('[smoke] region diff (ready -> after):');
      const before = globalThis.__wfRegionProbe ?? [];
      const after = globalThis.__wfRegionProbeAfter ?? [];
      const max = Math.max(before.length, after.length);
      for (let i = 0; i < max; i += 1) {
        if (before[i] !== after[i]) console.log(`  - ${before[i] ?? '(none)'}
  + ${after[i] ?? '(none)'}`);
      }
      console.log('[smoke] CLS budget exceeded; shift sources:');
      for (const shift of vitals.shifts) {
        console.log(`  v=${shift.value.toFixed(4)} at ${shift.time}ms`);
        for (const source of shift.sources.slice(0, 5)) {
          console.log(`    ${source.node} ${JSON.stringify(source.prev)} -> ${JSON.stringify(source.cur)}`);
        }
      }
      const shotPrefix = process.env.WF_SMOKE_DEBUG_CLS_SHOT || '/tmp/cls-debug';
      await page.screenshot({ path: `${shotPrefix}-after.png` });
      console.log(`[smoke] saved post-shift screenshot to ${shotPrefix}-after.png`);
    }
    assert.equal(state.identityCalls, 1, 'throttled cold load must still issue one identity request');
    assert(composerReadyMs < 10_000, `cold mobile composer took ${composerReadyMs} ms (budget 10000)`);
    assert(vitals.fcp > 0 && vitals.fcp < 6_000, `cold mobile FCP was ${vitals.fcp} ms (budget 6000)`);
    assert(vitals.lcp > 0 && vitals.lcp < 8_000, `cold mobile LCP was ${vitals.lcp} ms (budget 8000)`);
    assert(vitals.cls <= 0.05, `cold mobile CLS was ${vitals.cls} (budget 0.05)`);

    const openHistory = page.getByRole('button', { name: 'Open chat history' });
    await openHistory.click();
    const closeHistory = page.getByRole('button', { name: 'Close chat history' });
    await closeHistory.waitFor();
    const drawer = page.locator('.MuiDrawer-paper').filter({ has: closeHistory });
    await page.waitForFunction(() => {
      const close = globalThis.document.querySelector('[aria-label="Close chat history"]');
      const paper = close?.closest('.MuiDrawer-paper');
      if (!paper) return false;
      const bounds = paper.getBoundingClientRect();
      return bounds.left >= -1 && bounds.right <= globalThis.innerWidth + 1;
    });
    const drawerBox = await drawer.boundingBox();
    assert(drawerBox, 'mobile history drawer must have a visible paper');
    assert(
      drawerBox.width >= mobileViewport.width * 0.85,
      `mobile history drawer is too narrow: ${drawerBox.width}px at ${mobileViewport.width}px`,
    );
    assert(
      drawerBox.width <= 361,
      `mobile history drawer exceeded its 360px cap: ${drawerBox.width}px`,
    );
    assert(
      drawerBox.x >= -1 && drawerBox.x + drawerBox.width <= mobileViewport.width + 1,
      `mobile history drawer escaped the viewport: ${JSON.stringify(drawerBox)}`,
    );

    const assertNoHorizontalOverflow = async label => {
      const widths = await page.evaluate(() => ({
        viewport: globalThis.document.documentElement.clientWidth,
        document: globalThis.document.documentElement.scrollWidth,
        body: globalThis.document.body.scrollWidth,
        chat: globalThis.document.getElementById('wf-chat-window')?.scrollWidth ?? 0,
      }));
      assert(
        widths.document <= widths.viewport + 1
          && widths.body <= widths.viewport + 1
          && widths.chat <= widths.viewport + 1,
        `${label} overflowed horizontally: ${JSON.stringify(widths)}`,
      );
    };
    await assertNoHorizontalOverflow('open mobile history');

    await closeHistory.click();
    await closeHistory.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => (
      globalThis.document.activeElement?.getAttribute('aria-label') === 'Open chat history'
    ));
    await assertNoHorizontalOverflow('closed mobile history');

    process.stdout.write(
      `cold mobile smoke: composer=${composerReadyMs}ms fcp=${Math.round(vitals.fcp)}ms `
      + `lcp=${Math.round(vitals.lcp)}ms cls=${vitals.cls.toFixed(4)} `
      + `drawer=${Math.round(drawerBox.width)}px viewport=${mobileViewport.width}px\n`,
    );
    await context.close();
  }

  {
    const { context, page, state } = await createPage('captcha', 'captcha');
    await page.goto(`${origin}/chatpage/`);
    await waitForComposer(page);
    await page.getByRole('textbox', { name: 'Type your message' }).fill('Browser Turnstile test');
    await page.getByRole('button', { name: 'Send message' }).click();
    await page.getByText('Browser smoke reply', { exact: true }).waitFor();
    assert.equal(state.chatPayloads.length, 2, 'captcha flow must retry the parked turn exactly once');
    assert.equal(state.chatPayloads[1].captcha_token, 'browser-smoke-token');
    assert.equal(state.chatPayloads[1].expected_identity_id, identityId);
    await context.close();
  }

  {
    const { context, page, state } = await createPage('abort', 'abort');
    await page.goto(`${origin}/chatpage/`);
    await waitForComposer(page);
    await page.getByRole('textbox', { name: 'Type your message' }).fill('Browser abort test');
    await page.getByRole('button', { name: 'Send message' }).click();
    await page.getByText('Browser smoke', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Stop generation' }).click();
    await page.getByText(/Generation stopped/).waitFor();
    await page.waitForFunction(() => !globalThis.document.querySelector('[aria-label="Stop generation"]'));
    await page.waitForTimeout(100);
    assert.equal(state.streamAborted, true, 'Stop generation must abort the active SSE request');
    await context.close();
  }

  {
    const { context, page, state } = await createPage('lazy-recovery', 'completion', {
      failPreferencesChunkOnce: true,
      blockServiceWorkers: true,
    });
    await page.addInitScript(() => {
      const key = 'wf_browser_smoke_document_loads';
      const count = Number(globalThis.sessionStorage.getItem(key) || '0');
      globalThis.sessionStorage.setItem(key, String(count + 1));
    });
    await page.goto(`${origin}/chatpage/`);
    await waitForComposer(page);
    assert.equal(
      await page.evaluate(() => globalThis.sessionStorage.getItem('wf_browser_smoke_document_loads')),
      '1',
      'optional chunk scenario must start from one document load',
    );

    await page.getByRole('button', { name: 'Chat actions' }).click();
    await page.getByRole('menuitem', { name: 'Chat settings' }).click();
    await page.waitForFunction(() => (
      globalThis.sessionStorage.getItem('wf_browser_smoke_document_loads') === '2'
    ));
    await waitForComposer(page);
    assert.equal(state.optionalChunkFailures, 1, 'optional chunk must fail exactly once');

    await page.getByRole('button', { name: 'Chat actions' }).click();
    await page.getByRole('menuitem', { name: 'Chat settings' }).click();
    await page.getByRole('heading', { name: 'Chat settings' }).waitFor();
    await page.waitForTimeout(250);
    assert.equal(state.optionalChunkRequests, 2, 'recovered dialog must fetch the optional chunk once more');
    assert.equal(
      await page.evaluate(() => globalThis.sessionStorage.getItem('wf_browser_smoke_document_loads')),
      '2',
      'optional chunk recovery must reload the document exactly once',
    );
    await context.close();
  }

  {
    const { context, page, state } = await createPage('chunk-failure', 'completion', {
      failChatChunk: true,
      blockServiceWorkers: true,
    });
    await page.goto(`${origin}/chatpage/`);
    await page.getByText('Oops! Something went wrong').waitFor();
    await page.waitForTimeout(250);
    assert(state.telemetry.some(event => event.event === 'app_error'), 'chunk failure must emit app_error telemetry');
    await context.close();
  }

  process.stdout.write('browser smoke: PWA, completion, cold mobile, abort, Turnstile, lazy recovery, chunk failure, manifest, and axe checks passed\n');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  if (temporaryTlsDirectory) {
    await rm(temporaryTlsDirectory, { force: true, recursive: true });
  }
}
