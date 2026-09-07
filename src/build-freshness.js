/**
 * build-freshness.js — make a shipped fix actually reach the player.
 *
 * ── THERE IS NO SERVICE WORKER ──────────────────────────────────────────────
 * The reported "live link is not updated" is not a stale service worker. This
 * project registers none, and https://<host>/sats-arena-4/sw.js is a 404. The
 * actual mechanism is plain HTTP caching, and it is measurable:
 *
 *     $ curl -sI https://developerofwebxr-oss.github.io/sats-arena-4/
 *     cache-control: max-age=600
 *
 * GitHub Pages serves index.html with a TEN MINUTE max-age and gives you no way
 * to change it — there is no server config on Pages. The JS/CSS/GLB assets are
 * content-hashed and immutable, so they are never the stale part; index.html is,
 * and a stale index.html points at the PREVIOUS build's hashed bundle. So for up
 * to ten minutes after a deploy, a browser that has visited recently runs
 * yesterday's code from its own HTTP cache. That is exactly "not updated for a
 * load or two", and it means a shipped fix can be invisible to the person who
 * asked for it.
 *
 * ── The fix ─────────────────────────────────────────────────────────────────
 * Once the game is up and idle, re-fetch index.html with `cache: 'no-store'`
 * (which bypasses that 600s entry), read which main bundle the CURRENT deploy
 * references, and compare it with the one actually running. If they differ, the
 * page is running stale code and reloads ONCE.
 *
 * ── Why this cannot loop ────────────────────────────────────────────────────
 * The target bundle name is written to sessionStorage BEFORE reloading, and a
 * hash already recorded there is never acted on again. So the worst case is one
 * reload per new deploy per tab — even if the reload itself somehow comes back
 * stale again. It also refuses to run: on localhost, while the tab is hidden,
 * while an XR session is presenting (yanking someone out of a headset mid-session
 * would be far worse than stale code), and if anything at all throws.
 *
 * This does not shorten the cache; it detects the consequence and recovers.
 */

const KEY = 'sats-arena:reloaded-for-build';

/**
 * @param {object} opts
 * @param {number} opts.delayMs        wait before checking (keep off the boot path)
 * @param {() => boolean} opts.isBusy  return true to skip (e.g. an XR session)
 */
export function watchForNewBuild({ delayMs = 5000, isBusy = () => false } = {}) {
  // Dev servers rebuild in place; there is nothing to compare and Vite already
  // hot-reloads. Also skips any local file/preview host.
  if (import.meta.env.DEV) return;
  const host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '') return;

  setTimeout(() => { check(isBusy); }, delayMs);
}

async function check(isBusy) {
  try {
    if (document.hidden || isBusy()) return;

    // The bundle this page is actually running.
    const running = [...document.querySelectorAll('script[src]')]
      .map((s) => s.getAttribute('src') || '')
      .find((src) => /assets\/main-[A-Za-z0-9_-]+\.js$/.test(src));
    if (!running) return;                       // not a built page — nothing to do

    // The bundle the CURRENT deploy references. no-store bypasses the 600s entry.
    const indexUrl = location.pathname.replace(/[^/]*$/, '') + 'index.html';
    const res = await fetch(indexUrl, { cache: 'no-store' });
    if (!res.ok) return;
    const html = await res.text();
    const latest = (html.match(/assets\/main-[A-Za-z0-9_-]+\.js/) || [])[0];
    if (!latest) return;

    if (running.endsWith(latest)) return;       // already current

    // One reload per build, per tab — recorded BEFORE reloading so a reload that
    // somehow comes back stale cannot start a loop.
    if (sessionStorage.getItem(KEY) === latest) {
      console.warn(`[build] still running ${running} while ${latest} is deployed — ` +
                   'already reloaded once for this build, not retrying.');
      return;
    }
    sessionStorage.setItem(KEY, latest);
    console.log(`[build] deployed build changed (${latest}) — reloading once to pick it up`);
    location.reload();
  } catch {
    // Offline, blocked, or storage unavailable — running stale code is not worth
    // an error, and the next visit picks it up anyway.
  }
}
