/**
 * competition.js — opt-in competitive mode layered on top of free co-op.
 *
 * Free endless co-op is and stays the DEFAULT. Competition is inert until BOTH
 * players agree. It rides on top of the existing scoring (score.js getScore()) —
 * it never touches coin spawn/authority, lightning, consent, or aim.
 *
 * ROLES
 *   host  = session owner (getRoomName() === getOwnCode()). Owns the CLOCK and
 *           computes the WINNER. Proposing is symmetric (either side proposes).
 *
 * HANDSHAKE (all messages RELIABLE)
 *   cmp-propose  {name}                either → peer : "wants to compete"
 *   cmp-accept   {}                    peer → proposer : agreed
 *   cmp-decline  {}                    peer → proposer : stay free co-op
 *   cmp-count    {n}                   HOST → guest : 3-2-1 lead-in tick
 *   cmp-go       {}                    HOST → guest : round begins NOW → 0–0 reset
 *   cmp-clock    {remaining}           HOST → guest : authoritative seconds left
 *   cmp-score    {score}              either → peer : own score changed
 *   cmp-end      {hostScore,guestScore,winner}  HOST → guest : verdict
 *   (rematch reuses cmp-propose/accept/decline from the end card)
 *
 * SYNC MODEL — the host drives EVERYTHING time-related (3-2-1, the 260 s clock,
 * the end). Clients never run an independent clock, so there is no drift: they
 * display whatever the host last broadcast. The 0–0 reset happens on cmp-go
 * (host) / receipt of cmp-go (guest): each device zeroes its OWN score and
 * broadcasts 0. Rapid-fire is untouched here, so it stays SHARED during a match.
 */

import {
  onPeerJoin, onPeerLeave, onPeerEvent, sendEvent,
  getParticipantCount, getRoomName,
} from './room.js';
import { getOwnCode, getLocalName } from './coop-hud.js';
import { getScore, resetScore } from '../score.js';

// Round length. Dev override: ?cmpsecs=10 shortens it for testing.
const ROUND_SECONDS = (() => {
  const q = parseInt(new URLSearchParams(location.search).get('cmpsecs') || '', 10);
  return Number.isFinite(q) && q > 0 ? q : 260; // 260 s = 4:20
})();

// ── State ─────────────────────────────────────────────────────────────────────
// 'idle'      free co-op (default)
// 'proposed'  I proposed; waiting for peer accept/decline
// 'incoming'  peer proposed; I'm shown accept/decline
// 'countdown' 3-2-1 lead-in running
// 'active'    round running
// 'ended'     end card shown
let state = 'idle';

let peerId    = null;
let peerName  = 'Opponent';
let peerScore = 0;        // last cmp-score received from the peer
let lastSentScore = null; // last cmp-score we broadcast (dedupe)
let countValue = 0;       // 3/2/1 currently displayed
let clockRemaining = 0;   // seconds left (host-authoritative, shown on both)

let _hostTimers = [];     // setTimeout/interval ids owned by the host driver

const isHost = () => !!getOwnCode() && getRoomName() === getOwnCode();
const twoConnected = () => getParticipantCount() >= 2 && peerId !== null;

// ── DOM ─────────────────────────────────────────────────────────────────────
let competeBtn, proposalCard, waitToast, countOverlay, scoreHud, endCard, leftToast;

function send(type, extra = {}) {
  sendEvent({ t: type, ...extra }, { reliable: true });
}

// ── Setup ─────────────────────────────────────────────────────────────────────
export function setupCompetition() {
  injectStyles();
  buildDom();

  onPeerJoin((id, name) => {
    peerId = id; peerName = name || 'Opponent';
    refreshCompeteBtn();
  });

  onPeerLeave(() => {
    handlePeerLeave();
    peerId = null;
    refreshCompeteBtn();
  });

  onPeerEvent((msg, id, name) => {
    if (!msg || typeof msg.t !== 'string' || !msg.t.startsWith('cmp-')) return;
    if (name && id === peerId) peerName = name;
    handleMessage(msg);
  });

  refreshCompeteBtn();
}

// Called every animation frame from main.js. Cheap: refreshes the compete button
// visibility and, during a round, broadcasts our own score when it changes and
// repaints the dual-score HUD.
export function updateCompetition() {
  if (state === 'idle') { refreshCompeteBtn(); return; }

  if (state === 'active') {
    const s = getScore();
    if (s !== lastSentScore) {
      lastSentScore = s;
      send('cmp-score', { score: s });     // reliable — feeds the final verdict
    }
    paintScoreHud();
  }
}

// ── Message handling ────────────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.t) {
    case 'cmp-propose':
      // A proposal (fresh match OR a rematch from the end card). Only meaningful
      // when we're idle or showing the end card; ignore if already arming/running.
      if (state === 'idle' || state === 'ended') {
        peerName = msg.name || peerName;
        showIncoming();
      }
      break;

    case 'cmp-accept':
      if (state === 'proposed') onMutualAgreement();
      break;

    case 'cmp-decline':
      if (state === 'proposed') {
        toIdle();
        setWait(`${peerName} declined`, true);
      }
      break;

    case 'cmp-count':      // guest: show the host's 3-2-1
      state = 'countdown';
      hideAllPrompts();
      showCount(msg.n);
      break;

    case 'cmp-go':         // guest: round begins now
      beginRound();
      break;

    case 'cmp-clock':      // guest: authoritative seconds left
      clockRemaining = msg.remaining;
      if (state === 'active') paintScoreHud();
      break;

    case 'cmp-score':      // peer's own score changed
      peerScore = msg.score | 0;
      if (state === 'active') paintScoreHud();
      break;

    case 'cmp-end':        // guest: verdict from the host
      showEndCard(msg.hostScore, msg.guestScore, msg.winner);
      break;
  }
}

// Reached on BOTH devices the instant mutual agreement is confirmed (proposer on
// receiving accept; accepter having just sent accept). Whoever is host drives.
function onMutualAgreement() {
  state = 'countdown';
  hideAllPrompts();
  if (isHost()) hostRunCountdown();
  else showCount(3); // guest shows a placeholder until the first cmp-count lands
}

// ── Host: 3-2-1 lead-in, then the round + authoritative clock ────────────────
function hostRunCountdown() {
  clearHostTimers();
  let n = 3;
  const tick = () => {
    send('cmp-count', { n });
    showCount(n);
    n -= 1;
    if (n >= 1) {
      _hostTimers.push(setTimeout(tick, 1000));
    } else {
      _hostTimers.push(setTimeout(() => { send('cmp-go'); beginRound(); }, 1000));
    }
  };
  tick();
}

function hostRunClock() {
  clearHostTimers();
  clockRemaining = ROUND_SECONDS;
  send('cmp-clock', { remaining: clockRemaining });
  const id = setInterval(() => {
    clockRemaining -= 1;
    if (clockRemaining <= 0) {
      clockRemaining = 0;
      send('cmp-clock', { remaining: 0 });
      clearHostTimers();
      hostEndRound();
    } else {
      send('cmp-clock', { remaining: clockRemaining });
      paintScoreHud();
    }
  }, 1000);
  _hostTimers.push(id);
}

function hostEndRound() {
  const hostScore  = getScore();
  const guestScore = peerScore;
  const winner = hostScore > guestScore ? 'host'
               : guestScore > hostScore ? 'guest'
               : 'draw';
  send('cmp-end', { hostScore, guestScore, winner });
  showEndCard(hostScore, guestScore, winner);
}

// ── Round begin — the mandatory 0–0 reset (both devices) ─────────────────────
function beginRound() {
  hideAllPrompts();
  hideCount();
  state = 'active';

  // HARD 0–0 RESET: zero our own score locally, show 0, and broadcast 0 so the
  // peer's live view of us starts at 0 too. Pre-match free-play score is dropped.
  resetScore();
  lastSentScore = 0;
  peerScore = 0;
  send('cmp-score', { score: 0 });

  clockRemaining = ROUND_SECONDS;
  if (isHost()) hostRunClock(); // host owns the authoritative countdown
  showScoreHud();
  paintScoreHud();
}

// ── Peer leaves mid-flow ─────────────────────────────────────────────────────
function handlePeerLeave() {
  const wasMidMatch = state === 'countdown' || state === 'active' || state === 'ended';
  clearHostTimers();
  toIdle();
  if (wasMidMatch) showLeftToast();
}

// ── Transitions to idle (free co-op) ─────────────────────────────────────────
function toIdle() {
  state = 'idle';
  clearHostTimers();
  hideAllPrompts();
  hideCount();
  hideScoreHud();
  hideEndCard();
  setCoopScoreHidden(false); // restore the normal single-score co-op HUD
  peerScore = 0;
  lastSentScore = null;
  refreshCompeteBtn();
}

function clearHostTimers() {
  _hostTimers.forEach((t) => { clearTimeout(t); clearInterval(t); });
  _hostTimers = [];
}

// ── Match state (read by the skins module) ────────────────────────────────────
/**
 * True while the round clock is running or counting in. Skin switching is
 * disabled in this window: pausing both players mid-match would distort the
 * host-authoritative clock and hand either side a pause-cheat.
 * 'ended' is NOT active — the end card is up and free co-op has resumed.
 */
export function isMatchActive() {
  return state === 'countdown' || state === 'active';
}

// ── In-world (VR/AR) accessors ────────────────────────────────────────────────
// The immersive menu has no DOM. These delegate to the SAME propose() handshake
// the DOM COMPETE button uses, and expose the identical enablement condition
// refreshCompeteBtn() applies, so the two views can never disagree.

/** True when the COMPETE action is available (2 connected and no match in flight). */
export function canCompete() { return twoConnected() && state === 'idle'; }

/** Fire the COMPETE proposal (identical to clicking #cmp-compete). */
export function proposeCompetition() { propose(); }

// ── UI actions ────────────────────────────────────────────────────────────────
function propose() {
  if (!twoConnected() || (state !== 'idle' && state !== 'ended')) return;
  hideEndCard();
  state = 'proposed';
  send('cmp-propose', { name: getLocalName() });
  setWait(`Waiting for ${peerName} to accept…`, false);
}

function acceptIncoming() {
  hideIncoming();
  send('cmp-accept');
  onMutualAgreement(); // accepter reaches mutual agreement on sending accept
}

function declineIncoming() {
  hideIncoming();
  send('cmp-decline');
  toIdle();
}

function rematch() {
  // Reuse the propose handshake from the end card.
  propose();
}

// ── DOM build ─────────────────────────────────────────────────────────────────
function buildDom() {
  // Compete button — inside the co-op panel's active section (2-connected only).
  competeBtn = document.createElement('button');
  competeBtn.id = 'cmp-compete';
  competeBtn.textContent = '⚔ COMPETE';
  competeBtn.style.display = 'none';
  competeBtn.addEventListener('click', (e) => { e.stopPropagation(); propose(); });
  (document.querySelector('#coop-active') || document.body).appendChild(competeBtn);

  // Waiting toast (proposer side).
  waitToast = mkCentered('cmp-wait'); waitToast.style.display = 'none';

  // Incoming proposal card (Accept / Decline).
  proposalCard = document.createElement('div');
  proposalCard.id = 'cmp-proposal';
  proposalCard.style.display = 'none';
  proposalCard.innerHTML = `
    <div class="cmp-card-title" id="cmp-prop-text"></div>
    <div class="cmp-card-btns">
      <button id="cmp-accept" class="cmp-yes">ACCEPT</button>
      <button id="cmp-decline" class="cmp-no">DECLINE</button>
    </div>`;
  document.body.appendChild(proposalCard);
  proposalCard.querySelector('#cmp-accept').addEventListener('click', (e) => { e.stopPropagation(); acceptIncoming(); });
  proposalCard.querySelector('#cmp-decline').addEventListener('click', (e) => { e.stopPropagation(); declineIncoming(); });

  // 3-2-1 / GO overlay.
  countOverlay = document.createElement('div');
  countOverlay.id = 'cmp-count';
  countOverlay.style.display = 'none';
  document.body.appendChild(countOverlay);

  // Dual-score + timer HUD (top-center), shown during countdown + active.
  scoreHud = document.createElement('div');
  scoreHud.id = 'cmp-scorehud';
  scoreHud.style.display = 'none';
  scoreHud.innerHTML = `
    <div class="cmp-timer" id="cmp-timer">4:20</div>
    <div class="cmp-scores">
      <span class="cmp-you">YOU <b id="cmp-you-n">0</b></span>
      <span class="cmp-vs">·</span>
      <span class="cmp-opp"><b id="cmp-opp-n">0</b> OPP</span>
    </div>`;
  document.body.appendChild(scoreHud);

  // End card.
  endCard = document.createElement('div');
  endCard.id = 'cmp-end';
  endCard.style.display = 'none';
  endCard.innerHTML = `
    <div class="cmp-end-verdict" id="cmp-verdict">DRAW</div>
    <div class="cmp-end-scores" id="cmp-end-scores"></div>
    <div class="cmp-card-btns">
      <button id="cmp-rematch" class="cmp-yes">REMATCH</button>
      <button id="cmp-close" class="cmp-no">CLOSE</button>
    </div>`;
  document.body.appendChild(endCard);
  endCard.querySelector('#cmp-rematch').addEventListener('click', (e) => { e.stopPropagation(); rematch(); });
  endCard.querySelector('#cmp-close').addEventListener('click', (e) => { e.stopPropagation(); toIdle(); });

  // "Opponent left" toast.
  leftToast = mkCentered('cmp-left'); leftToast.style.display = 'none';
  leftToast.textContent = 'Opponent left — back to free co-op';
}

function mkCentered(id) {
  const el = document.createElement('div');
  el.id = id;
  el.className = 'cmp-toast';
  document.body.appendChild(el);
  return el;
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function refreshCompeteBtn() {
  if (!competeBtn) return;
  competeBtn.style.display = (twoConnected() && state === 'idle') ? 'block' : 'none';
}

function setWait(text, autohide) {
  waitToast.textContent = text;
  waitToast.style.display = 'block';
  if (autohide) setTimeout(() => { if (state === 'idle') waitToast.style.display = 'none'; }, 2500);
}
function hideWait() { waitToast.style.display = 'none'; }

function showIncoming() {
  state = 'incoming';
  hideEndCard();
  proposalCard.querySelector('#cmp-prop-text').textContent = `${peerName} wants to compete`;
  proposalCard.style.display = 'block';
}
function hideIncoming() { proposalCard.style.display = 'none'; }

function hideAllPrompts() { hideWait(); hideIncoming(); }

function showCount(n) {
  countValue = n;
  countOverlay.textContent = n > 0 ? String(n) : 'GO';
  countOverlay.style.display = 'flex';
  countOverlay.classList.remove('cmp-pop'); void countOverlay.offsetWidth; // restart anim
  countOverlay.classList.add('cmp-pop');
}
function hideCount() { countOverlay.style.display = 'none'; }

function showScoreHud() {
  scoreHud.style.display = 'block';
  setCoopScoreHidden(true); // avoid duplicating my score (top-left SCORE == YOU)
}
function hideScoreHud() { scoreHud.style.display = 'none'; }

// Toggle hud.js's normal single-score element (top-left) without touching hud.js.
// Hidden during a match (dual-score HUD takes over); restored in toIdle().
function setCoopScoreHidden(hidden) {
  const el = document.getElementById('score');
  if (el) el.style.display = hidden ? 'none' : '';
}
function paintScoreHud() {
  scoreHud.querySelector('#cmp-you-n').textContent = String(getScore());
  scoreHud.querySelector('#cmp-opp-n').textContent = String(peerScore);
  const m = Math.floor(clockRemaining / 60);
  const s = String(Math.max(0, clockRemaining % 60)).padStart(2, '0');
  scoreHud.querySelector('#cmp-timer').textContent = `${m}:${s}`;
}

function showEndCard(hostScore, guestScore, winner) {
  clearHostTimers();
  state = 'ended';
  hideCount();
  hideScoreHud();
  const host = isHost();
  const myScore  = host ? hostScore : guestScore;
  const oppScore = host ? guestScore : hostScore;
  const iWon = (winner === 'host' && host) || (winner === 'guest' && !host);
  const verdict = winner === 'draw' ? 'DRAW' : (iWon ? 'YOU WIN' : 'YOU LOSE');
  const vEl = endCard.querySelector('#cmp-verdict');
  vEl.textContent = verdict;
  vEl.className = 'cmp-end-verdict ' + (winner === 'draw' ? 'cmp-draw' : iWon ? 'cmp-win' : 'cmp-lose');
  endCard.querySelector('#cmp-end-scores').innerHTML =
    `<span class="cmp-you">YOU <b>${myScore}</b></span><span class="cmp-vs">—</span><span class="cmp-opp"><b>${oppScore}</b> OPP</span>`;
  endCard.style.display = 'block';
}
function hideEndCard() { endCard.style.display = 'none'; }

function showLeftToast() {
  leftToast.style.display = 'block';
  setTimeout(() => { leftToast.style.display = 'none'; }, 3000);
}

// ── Styles ────────────────────────────────────────────────────────────────────
function injectStyles() {
  const s = document.createElement('style');
  s.textContent = `
    #cmp-compete {
      width: 100%; margin-top: 8px; padding: 9px 0;
      background: linear-gradient(#b14bff33, #00000000);
      color: #d9a3ff; border: 1px solid #b14bff; border-radius: 6px;
      font: 700 13px monospace; letter-spacing: .12em; cursor: pointer;
      text-shadow: 0 0 8px #b14bff;
    }
    #cmp-compete:hover { background: #b14bff44; }

    .cmp-toast {
      position: fixed; top: 84px; left: 50%; transform: translateX(-50%);
      z-index: 9500; background: rgba(0,0,0,.82); color: #cef;
      border: 1px solid #7df6; border-radius: 8px; padding: 8px 16px;
      font: 12px monospace; letter-spacing: .06em; pointer-events: none;
    }

    #cmp-proposal, #cmp-end {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%);
      z-index: 9600; background: rgba(6,6,14,.95);
      border: 1px solid #b14bff; border-radius: 12px; padding: 20px 24px;
      font-family: monospace; text-align: center; min-width: 240px;
      box-shadow: 0 0 30px rgba(177,75,255,.4);
    }
    .cmp-card-title { color: #e7c9ff; font-size: 15px; letter-spacing: .06em; margin-bottom: 16px; }
    .cmp-card-btns { display: flex; gap: 10px; justify-content: center; }
    .cmp-yes, .cmp-no {
      padding: 10px 18px; border-radius: 6px; border: none;
      font: 700 13px monospace; letter-spacing: .08em; cursor: pointer;
    }
    .cmp-yes { background: #b14bff; color: #fff; text-shadow: 0 0 6px #fff6; }
    .cmp-yes:hover { background: #c366ff; }
    .cmp-no { background: #333; color: #bbb; border: 1px solid #666; }
    .cmp-no:hover { background: #444; }

    #cmp-count {
      position: fixed; inset: 0; z-index: 9700;
      align-items: center; justify-content: center;
      font: 900 clamp(90px,22vw,220px) monospace; color: #fff;
      text-shadow: 0 0 30px #b14bff, 0 0 60px #b14bff; pointer-events: none;
    }
    @keyframes cmp-pop { from { transform: scale(.4); opacity: 0; } 40% { transform: scale(1.15); opacity: 1; } to { transform: scale(1); opacity: 1; } }
    .cmp-pop { animation: cmp-pop .5s ease-out; }

    #cmp-scorehud {
      position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
      z-index: 9400; text-align: center; font-family: monospace;
      pointer-events: none; user-select: none;
    }
    .cmp-timer { font: 900 26px monospace; letter-spacing: .1em; color: #fff; text-shadow: 0 0 12px #00e5ff; }
    .cmp-scores { margin-top: 3px; font: 700 16px monospace; letter-spacing: .08em; }
    .cmp-you { color: #00e5ff; text-shadow: 0 0 8px #00e5ff; }
    .cmp-opp { color: #f7931a; text-shadow: 0 0 8px #f7931a; }
    .cmp-vs  { color: #889; margin: 0 8px; }

    .cmp-end-verdict { font: 900 30px monospace; letter-spacing: .1em; margin-bottom: 10px; }
    .cmp-win  { color: #4dff9e; text-shadow: 0 0 16px #4dff9e; }
    .cmp-lose { color: #ff5d6c; text-shadow: 0 0 16px #ff5d6c; }
    .cmp-draw { color: #ffd23f; text-shadow: 0 0 16px #ffd23f; }
    .cmp-end-scores { font: 700 18px monospace; letter-spacing: .06em; margin-bottom: 18px; }
    .cmp-end-scores .cmp-vs { margin: 0 10px; }
  `;
  document.head.appendChild(s);
}

// ── Dev hook — drive the FSM without a second device (mock/BC testing) ────────
if (import.meta.env.DEV) {
  window.__competition = {
    get state() { return state; },
    get clockRemaining() { return clockRemaining; },
    get peerScore() { return peerScore; },
    isHost,
    inject: (msg) => handleMessage(msg),   // simulate a peer message
    setPeer: (id, name) => { peerId = id; peerName = name || 'Bot'; refreshCompeteBtn(); },
  };
}
