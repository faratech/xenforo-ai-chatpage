/**
 * Publishes where the chat shell must start as `--wf-shell-top`.
 *
 * On the XenForo page node the chat is a viewport-pinned shell (`#root` is
 * `position: fixed`, see `_page_node.313`) because the document is not a
 * reliable container: Google's Auto Ads rewrites `.p-pageWrapper`'s height
 * inline with `!important` and injects in-flow slots straight into `<body>`,
 * so anything that measures through document flow can be taken apart
 * underneath it.
 *
 * The value is the forum header's **bottom edge in viewport coordinates**, not
 * its height. Those differ the moment anything sits above the header — a staff
 * bar or a notice, which logged-in members get and guests do not — and using
 * the height put the chat 44px over the logo. The page cannot scroll, so the
 * bottom edge is stable once measured.
 *
 * Watched rather than measured once: the header grows when its logo or avatar
 * finishes loading, and notices can be inserted above it well after first
 * paint.
 */
const HEADER_SELECTOR = '.p-header';
const CSS_VAR = '--wf-shell-top';

export const trackHostShellOffset = (): (() => void) => {
  const header = document.querySelector<HTMLElement>(HEADER_SELECTOR);
  // Standalone route: no forum chrome, and the rule that reads this variable
  // is not present either, so there is nothing to publish.
  if (!header) return () => {};

  let last = -1;
  const publish = () => {
    const bottom = Math.max(0, Math.round(header.getBoundingClientRect().bottom));
    if (bottom === last) return;
    last = bottom;
    document.documentElement.style.setProperty(CSS_VAR, `${bottom}px`);
  };

  publish();

  const cleanups: Array<() => void> = [];
  window.addEventListener('resize', publish);
  cleanups.push(() => window.removeEventListener('resize', publish));

  if (typeof ResizeObserver !== 'undefined') {
    const resize = new ResizeObserver(publish);
    // The header for its own growth, and the page wrapper because anything
    // inserted *above* the header moves it down without resizing it.
    resize.observe(header);
    const wrapper = header.parentElement;
    if (wrapper) resize.observe(wrapper);
    cleanups.push(() => resize.disconnect());
  }

  if (typeof MutationObserver !== 'undefined' && header.parentElement) {
    // A notice added above the header changes nothing's size — only position.
    const mutation = new MutationObserver(publish);
    mutation.observe(header.parentElement, { childList: true });
    cleanups.push(() => mutation.disconnect());
  }

  return () => cleanups.forEach(fn => fn());
};
