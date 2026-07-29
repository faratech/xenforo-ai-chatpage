/**
 * Publishes the forum header's height as `--wf-shell-top`.
 *
 * On the XenForo page node the chat is a viewport-pinned shell (`#root` is
 * `position: fixed`, see `_page_node.313`), which has to start below the forum
 * header. The header is content-sized — 57px on desktop, 60px on a phone, and
 * more if its contents ever wrap — so the offset is measured rather than
 * guessed. The template carries a 57px fallback for the moment before this runs
 * and for the standalone route, where there is no header and the variable is
 * never set.
 *
 * Fixed positioning is what makes the shell immune to the host: Google's Auto
 * Ads both rewrites `.p-pageWrapper`'s height inline with `!important` and
 * injects in-flow slots directly into `<body>`, so any layout that measures
 * through the document can be taken apart underneath it.
 */
const HEADER_SELECTOR = '.p-header';
const CSS_VAR = '--wf-shell-top';

export const trackHostShellOffset = (): (() => void) => {
  const header = document.querySelector<HTMLElement>(HEADER_SELECTOR);
  // Standalone route: no forum chrome, so the shell starts at the top and the
  // template's fallback never applies because the rule is not there either.
  if (!header) return () => {};

  const publish = () => {
    const height = Math.round(header.getBoundingClientRect().height);
    document.documentElement.style.setProperty(CSS_VAR, `${height}px`);
  };

  publish();

  if (typeof ResizeObserver === 'undefined') {
    window.addEventListener('resize', publish);
    return () => window.removeEventListener('resize', publish);
  }

  const observer = new ResizeObserver(publish);
  observer.observe(header);
  return () => observer.disconnect();
};
