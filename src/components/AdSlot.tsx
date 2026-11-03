import { memo, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';

/**
 * The forum's breadcrumb AdSense unit, relocated into the chat shell.
 *
 * On /pages/ai the page is a full-viewport app shell that does not scroll, so
 * the 280px unit that used to sit above the chat (390px on a phone) would come
 * straight out of the conversation — it was 451px of the first screen on
 * desktop and 60% of it on mobile. The page-313 template hides the host's
 * breadcrumb copy; this renders the same slot as the last row of the shell
 * instead, where a fixed band cannot push the transcript around.
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
 * The host copy is held collapsed while this unit is pending on embeds that
 * expose it. On page-313 it is hidden by the page template, so it is not a
 * visible fallback if this unit does not fill.
 */
const AD_CLIENT = 'ca-pub-7455498979488414';
const AD_SLOT = '6778196821';

const adsEnabledOnHost = (): boolean => {
  if (typeof document === 'undefined' || typeof window === 'undefined') return false;
  const gate = (window as Window & { __wfAdGate?: { load?: string; lateDeny?: number } }).__wfAdGate;
  return !!document.querySelector('script[src*="adsbygoogle.js"]')
    && gate?.load !== 'error' && gate?.load !== 'withheld' && gate?.lateDeny !== 1;
};

/** A pending creative has been observed to fill about 20 seconds after loading. */
const UNFILLED_GRACE_MS = 30_000;

/**
 * Hold the forum's breadcrumb copy collapsed (zero-height, not display:none)
 * while our own unit decides whether it will fill.
 *
 * If ours fills, the held copy is removed. If it does not, cleanup releases
 * this inline hold. Whether the host copy is visible afterward is controlled
 * by the host template; page-313 explicitly keeps it hidden.
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
  const [hostLoaderPresent, setHostLoaderPresent] = useState(adsEnabledOnHost);
  const show = isGuest && hostLoaderPresent && adsEnabledOnHost() && !abandoned;

  useEffect(() => {
    if (!isGuest || hostLoaderPresent || abandoned || !document.head) return;
    // The host injects the loader only after its ad gate approves. The chat
    // may mount first, so watch its insertion rather than treating a one-time
    // absence as a permanent denial. The host appends the loader to <head>.
    const observer = new MutationObserver(() => {
      if (adsEnabledOnHost()) {
        observer.disconnect();
        setHostLoaderPresent(true);
      }
    });
    observer.observe(document.head, { childList: true, subtree: true });
    // Close the gap between the first render and observer registration.
    if (adsEnabledOnHost()) {
      observer.disconnect();
      setHostLoaderPresent(true);
    }
    return () => observer.disconnect();
  }, [isGuest, hostLoaderPresent, abandoned]);

  useEffect(() => {
    if (!show) return;
    // Gate state can change between render and this effect.
    if (!adsEnabledOnHost()) {
      setAbandoned(true);
      return;
    }
    holdBreadcrumbCollapsed();
    // StrictMode mounts twice in development, and AdSense throws
    // "All ins elements in the DOM with class=adsbygoogle already have ads in
    // them" on a second push into the same <ins>.
    if (!pushedRef.current) {
      pushedRef.current = true;
      try {
        (window.adsbygoogle = window.adsbygoogle || []).push({});
      } catch (error) {
        // A failed ad must never take the chat down with it.
        console.error('AdSense slot failed to initialise:', error);
      }
    }

    return () => releaseHeldBreadcrumb();
  }, [show]);

  /**
   * Give the band back to the conversation when nothing fills it — once, and
   * for good.
   *
   * The band reserves space inside a viewport that no longer scrolls, so an
   * empty 90px strip below the composer is a permanent cost. An unresolved
   * slot can fill later, so allow a bounded 30 seconds; explicit unfilled status
   * and loader errors still release the band immediately. The host treats
   * `unfill-optimized` and a sized iframe as rendered content; keep those
   * visible too without assuming that they are paid ads.
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
      const frame = ins.querySelector('iframe');
      const frameRect = frame?.getBoundingClientRect();
      const rendered = !!frameRect && frameRect.width > 1 && frameRect.height > 1;
      if (status === 'filled' || status === 'unfill-optimized' || (status !== 'unfilled' && rendered)) {
        // Ours won: retire the forum's held copy for good.
        document.getElementById('wf-ad-breadcrumb')?.remove();
        return true;
      }
      if (status === 'unfilled') {
        setAbandoned(true);
        return true;
      }
      return false;
    };

    if (settle()) return;
    const observer = new MutationObserver(() => { if (settle()) observer.disconnect(); });
    observer.observe(ins, { attributes: true, attributeFilter: ['data-ad-status'] });
    const loader = document.querySelector<HTMLScriptElement>('script[src*="adsbygoogle.js"]');
    const loaderFailed = () => { if (!settle()) setAbandoned(true); };
    loader?.addEventListener('error', loaderFailed);
    // AdSense does not always set a status, so an unresolved band also needs
    // a deadline. Once abandoned it never returns during this mount.
    const timer = window.setTimeout(() => {
      if (!settle()) setAbandoned(true);
      observer.disconnect();
    }, UNFILLED_GRACE_MS);

    return () => { observer.disconnect(); loader?.removeEventListener('error', loaderFailed); window.clearTimeout(timer); };
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
