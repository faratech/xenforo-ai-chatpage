import { memo, useEffect, useRef } from 'react';
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
 */
const AD_CLIENT = 'ca-pub-7455498979488414';
const AD_SLOT = '6778196821';

const adsEnabledOnHost = (): boolean =>
  typeof document !== 'undefined'
  && !!document.querySelector('script[src*="adsbygoogle.js"]');

/** How long to wait for a creative before giving the space back to the chat. */
const UNFILLED_GRACE_MS = 4_000;

export const AdSlot = memo<{ isGuest: boolean }>(({ isGuest }) => {
  const pushedRef = useRef(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const show = isGuest && adsEnabledOnHost();

  useEffect(() => {
    if (!show || pushedRef.current) return;
    // StrictMode mounts twice in development, and AdSense throws
    // "All ins elements in the DOM with class=adsbygoogle already have ads in
    // them" on a second push into the same <ins>.
    pushedRef.current = true;

    // Take the forum's copy out of the document rather than leaving it hidden.
    // PAGE_CONTAINER emits it above the chat and it is outside this repo's
    // deployable template surface, so it cannot be suppressed at source from
    // here; removing it keeps exactly one unit on the page and avoids leaving
    // an ad rendering inside a display:none box, which is the thing AdSense
    // asks you not to do.
    document.getElementById('wf-ad-breadcrumb')?.remove();

    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch (error) {
      // A failed ad must never take the chat down with it.
      console.error('AdSense slot failed to initialise:', error);
    }
  }, [show]);

  /**
   * Give the band back to the conversation when nothing fills it.
   *
   * collapse.js does this site-wide, but only where it is loaded, and this slot
   * reserves space inside a viewport that no longer scrolls — an empty 90px
   * strip above the composer is a permanent cost, and the live unit already
   * reports `unfill-optimized` often enough to matter. Sets the same
   * `data-wf-ad-empty` attribute collapse.js uses, so the two cannot disagree.
   */
  useEffect(() => {
    if (!show) return;
    const wrapper = wrapperRef.current;
    const ins = wrapper?.querySelector('ins.adsbygoogle');
    if (!wrapper || !ins) return;

    const settle = () => {
      const status = ins.getAttribute('data-ad-status');
      if (status === 'filled') {
        wrapper.removeAttribute('data-wf-ad-empty');
        return true;
      }
      if (status && status !== 'filled') {
        wrapper.setAttribute('data-wf-ad-empty', '1');
        return true;
      }
      return false;
    };

    if (settle()) return;
    const observer = new MutationObserver(() => { if (settle()) observer.disconnect(); });
    observer.observe(ins, { attributes: true, attributeFilter: ['data-ad-status'] });
    // AdSense does not always set a status — a blocked or failed request simply
    // leaves the slot untouched, so the band needs a deadline of its own.
    const timer = window.setTimeout(() => {
      if (!settle()) wrapper.setAttribute('data-wf-ad-empty', '1');
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
