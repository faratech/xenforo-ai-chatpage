import { memo, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';

/**
 * The forum's breadcrumb AdSense unit, relocated into the chat shell.
 *
 * On /pages/ai the page is a full-viewport app shell that does not scroll, so
 * the 280px unit that used to sit above the chat (390px on a phone) would come
 * straight out of the conversation — it was 451px of the first screen on
 * desktop and 60% of it on mobile. `_ads.html` no longer emits it for
 * `page-313`; this renders the same slot as the last row of the shell instead,
 * where a fixed band cannot push the transcript around.
 *
 * Two gates, both deliberately mirroring the host rather than duplicating its
 * policy:
 *
 *  - `isGuest` reproduces the macro's `$xf.visitor.isMemberOf([1])`. Members
 *    have never seen this unit and must not start seeing it here.
 *  - the presence of the AdSense loader — injected by the `container_header`
 *    macro, and only for viewers the forum has decided get ads — stands in for
 *    "we are embedded in the forum at all". On the standalone /chatpage route
 *    there is no loader and this renders nothing.
 *
 * The forum copy is held collapsed until our own unit proves itself; see
 * holdBreadcrumbCollapsed for why the decision is no longer made up front.
 */
const AD_CLIENT = 'ca-pub-7455498979488414';
const AD_SLOT = '6778196821';

const adsEnabledOnHost = (): boolean =>
  typeof document !== 'undefined'
  && !!document.querySelector('script[src*="adsbygoogle.js"]');

/** How long to wait for a creative before giving the space back to the chat. */
const UNFILLED_GRACE_MS = 4_000;

/**
 * Hold the forum's breadcrumb copy collapsed (zero-height, not display:none)
 * while our own unit decides whether it will fill.
 *
 * The old behaviour deleted the breadcrumb up front, before knowing our own
 * fate; measured on production, ~5 cold sessions in 6 never reach
 * data-ad-status within the grace period, so the band unmounted and the
 * deleted breadcrumb left the guest with no unit at all. Holding instead of
 * deleting keeps every ending covered:
 *   - ours fills      -> the held copy is deleted outright (as before);
 *   - ours unfills    -> this component unmounts and the cleanup un-collapses
 *                        the breadcrumb, so the guest sees the forum's unit;
 *   - app tears down  -> same cleanup path.
 * Zero-height overflow-hidden keeps both units from being visually live at
 * once without display:none-ing a serving <ins>, which is the thing AdSense
 * asks you not to do.
 */
const holdBreadcrumbCollapsed = (): void => {
  const bc = document.getElementById('wf-ad-breadcrumb');
  if (!bc || bc.dataset.wfChatHeld) return;
  bc.dataset.wfChatHeld = '1';
  bc.style.cssText += ';height:0!important;overflow:hidden!important;margin:0!important;';
};

const releaseHeldBreadcrumb = (): void => {
  const bc = document.getElementById('wf-ad-breadcrumb');
  if (bc?.dataset.wfChatHeld) {
    delete bc.dataset.wfChatHeld;
    // The server-rendered wrapper carries no inline style of its own.
    bc.removeAttribute('style');
  }
};

export const AdSlot = memo<{ isGuest: boolean }>(({ isGuest }) => {
  const pushedRef = useRef(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [abandoned, setAbandoned] = useState(false);
  const show = isGuest && adsEnabledOnHost() && !abandoned;

  useEffect(() => {
    if (!show || pushedRef.current) return;
    // StrictMode mounts twice in development, and AdSense throws
    // "All ins elements in the DOM with class=adsbygoogle already have ads in
    // them" on a second push into the same <ins>.
    pushedRef.current = true;

    // Hold the forum's breadcrumb copy collapsed while ours decides (see
    // holdBreadcrumbCollapsed). It is outside this repo's deployable template
    // surface, so it cannot be suppressed at source from here.
    holdBreadcrumbCollapsed();

    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch (error) {
      // A failed ad must never take the chat down with it.
      console.error('AdSense slot failed to initialise:', error);
    }

    return () => releaseHeldBreadcrumb();
  }, [show]);

  /**
   * Give the band back to the conversation when nothing fills it — once, and
   * for good.
   *
   * The band reserves space inside a viewport that no longer scrolls, so an
   * empty 90px strip above the composer is a permanent cost and the live unit
   * reports `unfill-optimized` often enough to matter. But a band that
   * collapses and then comes back is worse than either: measured on
   * production, the slot collapsed as unfilled and filled ~20s later, resizing
   * the transcript by 90px mid-conversation. That is the same class of
   * layout shift this whole change exists to remove.
   *
   * So the decision is final. Unfilled unmounts the slot outright rather than
   * hiding it, which also puts it beyond the reach of the site-wide
   * collapse.js — an attribute either script can toggle is not a decision.
   */
  useEffect(() => {
    if (!show) return;
    const ins = wrapperRef.current?.querySelector('ins.adsbygoogle');
    if (!ins) return;

    const settle = () => {
      const status = ins.getAttribute('data-ad-status');
      if (!status) return false;
      if (status === 'filled') {
        // Ours won: retire the forum's held copy for good.
        document.getElementById('wf-ad-breadcrumb')?.remove();
      } else {
        setAbandoned(true);
      }
      return true;
    };

    if (settle()) return;
    const observer = new MutationObserver(() => { if (settle()) observer.disconnect(); });
    observer.observe(ins, { attributes: true, attributeFilter: ['data-ad-status'] });
    // AdSense does not always set a status — a blocked or failed request simply
    // leaves the slot untouched, so the band needs a deadline of its own.
    const timer = window.setTimeout(() => {
      if (!settle()) setAbandoned(true);
      observer.disconnect();
    }, UNFILLED_GRACE_MS);

    return () => { observer.disconnect(); window.clearTimeout(timer); };
  }, [show]);

  if (!show) return null;

  return (
    // `adsense-wrapper` is the host's own contract: js/windowsforum/ads/collapse.js
    // watches for wrappers added to the DOM and sets data-wf-ad-empty="1" on
    // any whose unit does not fill, which extra.less then collapses. Reusing it
    // means an unfilled slot costs the conversation nothing instead of leaving
    // a dead band above the composer.
    <Box
      component="div"
      ref={wrapperRef}
      className="adsense-wrapper wf-chat-ad"
      id="wf-ad-chat"
      aria-label="Advertisement"
      sx={{ flexShrink: 0 }}
    >
      <ins
        className="adsbygoogle"
        style={{ display: 'block', width: '100%' }}
        data-ad-client={AD_CLIENT}
        data-ad-slot={AD_SLOT}
        // Fixed rather than `auto`: a responsive unit resizes itself, and the
        // whole point of this position is that it never moves the transcript.
        data-ad-format="horizontal"
        data-full-width-responsive="false"
      />
    </Box>
  );
});

AdSlot.displayName = 'AdSlot';
