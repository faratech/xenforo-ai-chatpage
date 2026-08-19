import { startIdentityBootstrap } from './services/identityBootstrap';
import { pwaInstallPrompt, registerPWA } from './services/pwa';

const initialIdentityPromise = startIdentityBootstrap();

// The manifest points installed launches at the canonical XenForo /pages/ai/
// shell; registerPWA selects a separate narrow scope for legacy /chatpage/.
pwaInstallPrompt.start();
void registerPWA().catch(() => undefined);

// Avoid an unhandled-rejection report while the hashed application graph is
// loading. App still awaits this exact promise and renders its retry state.
void initialIdentityPromise.catch(() => undefined);

const reportBootstrapFailure = (): void => {
  const configuredBase = import.meta.env.VITE_API_BASE?.trim() ?? '';
  const endpoint = `${configuredBase.replace(/\/$/, '')}/chat.php`;
  void fetch(endpoint, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'clientTelemetry',
      event: 'app_error',
      release: __WF_BUILD_ID__,
      surface: __WF_SURFACE__,
      error_code: 'chunk_load_error',
    }),
    keepalive: true,
  }).catch(() => undefined);
};

const renderBootstrapFailure = (): void => {
  const root = document.getElementById('root');
  if (!root) return;

  const panel = document.createElement('div');
  panel.setAttribute('role', 'alert');
  panel.style.cssText = 'box-sizing:border-box;max-width:38rem;margin:4rem auto;padding:1.5rem;font:16px/1.5 system-ui,sans-serif;text-align:center;color:#1a1b1b;background:#fff;border:1px solid #d5d8dc;border-radius:8px';

  const message = document.createElement('p');
  message.textContent = 'The chat interface could not load. Your message history is still safe in this browser.';

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Retry loading chat';
  retry.style.cssText = 'padding:.6rem 1rem;font:inherit;font-weight:600;color:#fff;background:#0f6cbd;border:0;border-radius:8px;cursor:pointer';
  retry.addEventListener('click', () => window.location.reload());

  panel.append(message, retry);
  root.replaceChildren(panel);
  root.dataset.chatBootstrapError = 'true';
};

void import('./index')
  .then(({ mountApp }) => mountApp(initialIdentityPromise))
  .catch(() => {
    reportBootstrapFailure();
    renderBootstrapFailure();
  });
