const STORAGE_KEY = "players";
const UI_STATE_KEY = "trackerUiState";
const OVERLAY_ID = "dart-highscore-overlay";
const MENU_ID = "dart-highscore-menu";
const HEADER_BADGE_ID = "dart-highscore-header-badge";
const STATS_CARD_ID = "dart-highscore-stats-card";
const STATS_TABLE_HEAD_ID = "dart-highscore-stats-head";
const STATS_TABLE_BODY_ID = "dart-highscore-stats-body";
const HISTORY_LIMIT = 10000;

const DEFAULT_STATS = () => ({ highscore: 0, max180: 0, legHistory: [] });
const DEFAULT_PLAYER_RECORD = () => ({ global: DEFAULT_STATS(), modes: {} });

const DEFAULT_ACCENT_COLOR = "#cf6830";
const CARD_BG = "rgba(33, 33, 33, 0.96)";
const CARD_BORDER = "rgba(255, 255, 255, 0.08)";
const TEXT_MUTED = "rgba(255, 255, 255, 0.68)";
const BOX_SHADOW = "0 6px 22px rgba(0,0,0,0.24)";
const BOX_SHADOW_HOVER = "0 10px 28px rgba(0,0,0,0.32)";

function parseColorToRgbTuple(value) {
  const text = normalizeName(value);
  if (!text) return null;

  const hexMatch = text.match(/^#([a-f\d]{3}|[a-f\d]{6})$/i);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) {
      hex = hex.split("").map((char) => char + char).join("");
    }

    const num = Number.parseInt(hex, 16);
    return {
      r: (num >> 16) & 255,
      g: (num >> 8) & 255,
      b: num & 255
    };
  }

  const rgbMatch = text.match(/^rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgbMatch) {
    return {
      r: clampNumber(rgbMatch[1], 0, 255, 0),
      g: clampNumber(rgbMatch[2], 0, 255, 0),
      b: clampNumber(rgbMatch[3], 0, 255, 0)
    };
  }

  return null;
}

function colorWithAlpha(value, alpha, fallback = DEFAULT_ACCENT_COLOR) {
  const rgb = parseColorToRgbTuple(value) || parseColorToRgbTuple(fallback);
  if (!rgb) return fallback;

  const safeAlpha = Math.max(0, Math.min(1, Number(alpha) || 0));
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${safeAlpha})`;
}

function getThemeAccentColor() {
  const selectors = [
    ".ad-ext-player.ad-ext-player-active",
    ".ad-ext-player-active",
    "#ad-ext-turn .css-rrf7rv",
    "#ad-ext-turn .ad-ext-turn-points",
    "#root [role=\"tab\"][aria-selected=\"true\"]",
    ".chakra-tabs__tab[aria-selected=\"true\"]"
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    const candidate = getElementAccentColor(el);
    if (candidate) return candidate;
  }

  const activePlayerName = document.querySelector(".ad-ext-player-active .ad-ext-player-name");
  const playerCard = activePlayerName?.closest(".ad-ext-player");
  const fallbackCandidate = getElementAccentColor(playerCard);
  if (fallbackCandidate) return fallbackCandidate;

  const rootCandidate = getElementAccentColor(document.querySelector("#root"));
  if (rootCandidate) return rootCandidate;

  return DEFAULT_ACCENT_COLOR;
}

function getThemeColors() {
  const accentColor = getThemeAccentColor();

  return {
    accentColor,
    accentSoftBg: colorWithAlpha(accentColor, 0.15),
    accentSoftBorder: colorWithAlpha(accentColor, 0.28),
    accentRowBg: colorWithAlpha(accentColor, 0.16),
    accentRowBorder: colorWithAlpha(accentColor, 0.40)
  };
}

let players = {};
let currentPlayer = "";
let lastObservedPlayer = "";
let lastObservedScore = null;
let menuOpen = false;
let tickTimer = null;
let isLoaded = false;
let lastOverlaySignature = "";
let lastStatsSignature = "";
let lastHeaderSignature = "";
let lastThemeAccentColor = "";
let lastPathname = location.pathname;
let uiState = { collapsed: false };
let currentLegBestByPlayer = {};
let lastRemainingScoreByPlayer = {};
let matchFinishedCommitted = false;

function loadState() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY, UI_STATE_KEY], (res) => {
      players = sanitizePlayers(res?.[STORAGE_KEY]);
      uiState = sanitizeUiState(res?.[UI_STATE_KEY]);
      isLoaded = true;
      resolve();
    });
  });
}

function sanitizeUiState(raw) {
  return {
    collapsed: Boolean(raw?.collapsed)
  };
}

function savePlayers() {
  chrome.storage.local.set({ [STORAGE_KEY]: players });
}

function saveUiState() {
  chrome.storage.local.set({ [UI_STATE_KEY]: uiState });
}

function sanitizePlayers(raw) {
  if (!raw || typeof raw !== "object") return {};

  const clean = {};

  for (const [name, value] of Object.entries(raw)) {
    const safeName = normalizeName(name);
    if (!safeName) continue;

    const record = DEFAULT_PLAYER_RECORD();

    // Migration from old flat structure: { highscore, max180 }
    if (value && typeof value === "object" && ("highscore" in value || "max180" in value)) {
      record.global = sanitizeStats(value);
    }

    // New structure: { global: {...}, modes: {...} }
    if (value && typeof value === "object") {
      if (value.global && typeof value.global === "object") {
        record.global = sanitizeStats(value.global);
      }

      if (value.modes && typeof value.modes === "object") {
        for (const [modeKeyRaw, modeValue] of Object.entries(value.modes)) {
          const modeKey = normalizeModeKey(modeKeyRaw);
          if (!modeKey) continue;
          record.modes[modeKey] = sanitizeStats(modeValue);
        }
      }
    }

    clean[safeName] = record;
  }

  return clean;
}

function sanitizeStats(raw) {
  const legHistory = Array.isArray(raw?.legHistory)
    ? raw.legHistory
        .map((value) => clampNumber(value, 0, 180, 0))
        .filter((value) => Number.isFinite(value) && value > 0)
        .slice(-HISTORY_LIMIT)
    : [];

  return {
    highscore: clampNumber(raw?.highscore, 0, 180, 0),
    max180: clampNumber(raw?.max180, 0, Number.MAX_SAFE_INTEGER, 0),
    legHistory
  };
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(num)));
}

function isLikelyAccentColor(value) {
  const rgb = parseColorToRgbTuple(value);
  if (!rgb) return false;

  const max = Math.max(rgb.r, rgb.g, rgb.b);
  const min = Math.min(rgb.r, rgb.g, rgb.b);
  const brightness = (rgb.r + rgb.g + rgb.b) / 3;
  const saturation = max - min;

  return saturation >= 18 && brightness >= 35 && brightness <= 245;
}

function getElementAccentColor(el) {
  if (!el) return "";

  const style = window.getComputedStyle(el);
  const candidates = [
    style.getPropertyValue("--chakra-colors-blue-400"),
    style.getPropertyValue("--chakra-colors-blue-300"),
    style.getPropertyValue("--chakra-colors-orange-400"),
    style.backgroundColor,
    style.borderLeftColor,
    style.borderBottomColor,
    style.borderTopColor,
    style.outlineColor,
    style.color
  ]
    .map((value) => normalizeName(value))
    .filter(Boolean);

  for (const candidate of candidates) {
    if (
      candidate === "transparent" ||
      candidate === "rgba(0, 0, 0, 0)" ||
      candidate === "rgb(0, 0, 0)" ||
      candidate === "rgb(255, 255, 255)"
    ) {
      continue;
    }

    if (isLikelyAccentColor(candidate)) {
      return candidate;
    }
  }

  return "";
}

function normalizeName(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeModeKey(value) {
  const text = normalizeName(value).toLowerCase();
  return text.replace(/\s+/g, "_").replace(/[^a-z0-9_+-]/g, "");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function ensurePlayer(name) {
  const safeName = normalizeName(name);
  if (!safeName) return;

  if (!players[safeName]) {
    players[safeName] = DEFAULT_PLAYER_RECORD();
  }
}

function ensureModeStats(name, modeLabel) {
  const safeName = normalizeName(name);
  const modeKey = normalizeModeKey(modeLabel);
  if (!safeName || !modeKey) return;

  ensurePlayer(safeName);
  if (!players[safeName].modes[modeKey]) {
    players[safeName].modes[modeKey] = DEFAULT_STATS();
  }
}

function getPlayerRecord(name) {
  const safeName = normalizeName(name);
  return safeName && players[safeName] ? players[safeName] : DEFAULT_PLAYER_RECORD();
}

function getPlayerStats(name) {
  return getPlayerRecord(name).global;
}

function getPlayerModeStats(name, modeLabel) {
  const modeKey = normalizeModeKey(modeLabel);
  if (!modeKey) return DEFAULT_STATS();

  const record = getPlayerRecord(name);
  return record.modes[modeKey] || DEFAULT_STATS();
}
function appendLegHistory(stats, score) {
  if (!stats || !Number.isFinite(score) || score <= 0 || score > 180) return;
  if (!Array.isArray(stats.legHistory)) stats.legHistory = [];
  stats.legHistory.push(score);
  if (stats.legHistory.length > HISTORY_LIMIT) {
    stats.legHistory.splice(0, stats.legHistory.length - HISTORY_LIMIT);
  }
}

function getLegHistoryRange(stats, size) {
  if (!stats || !Array.isArray(stats.legHistory) || size <= 0) return [];
  return stats.legHistory.slice(-size);
}



function getHighscoreFromHistory(history) {
  if (!Array.isArray(history) || history.length === 0) return 0;
  return history.reduce((max, value) => (value > max ? value : max), 0);
}



function getRangeSizeFromLabel(rangeLabel) {
  const match = normalizeName(rangeLabel).match(/(\d+)/);
  if (!match) return 0;
  return clampNumber(Number.parseInt(match[1], 10), 1, HISTORY_LIMIT, 0);
}

function getActivePlayerName() {
  const activeNameEl = document.querySelector(".ad-ext-player-active .ad-ext-player-name");
  const activeName = normalizeName(activeNameEl?.innerText || activeNameEl?.textContent || "");
  if (activeName) return activeName;

  const fallbackEls = document.querySelectorAll(".ad-ext-player-name");
  for (const el of fallbackEls) {
    const name = normalizeName(el.innerText || el.textContent || "");
    if (name) return name;
  }

  return "";
}

function getAllVisiblePlayerNames() {
  const names = new Set();
  document.querySelectorAll(".ad-ext-player .ad-ext-player-name").forEach((el) => {
    const name = normalizeName(el.innerText || el.textContent || "");
    if (name) names.add(name);
  });
  return [...names];
}

function getTurnScore() {
  const el = document.querySelector("#ad-ext-turn .ad-ext-turn-points");
  if (!el) return null;

  const raw = (el.innerText || el.textContent || "").trim();
  const match = raw.match(/\d+/);
  if (!match) return null;

  const score = Number.parseInt(match[0], 10);
  return Number.isFinite(score) ? score : null;
}

function getSortedPlayerNames() {
  const visiblePlayers = getAllVisiblePlayerNames();
  visiblePlayers.forEach(ensurePlayer);

  return Object.keys(players).sort((a, b) => {
    const highscoreDiff = (players[b]?.global?.highscore || 0) - (players[a]?.global?.highscore || 0);
    if (highscoreDiff !== 0) return highscoreDiff;

    const max180Diff = (players[b]?.global?.max180 || 0) - (players[a]?.global?.max180 || 0);
    if (max180Diff !== 0) return max180Diff;

    return a.localeCompare(b, "de");
  });
}

function getCurrentPlayModeLabel() {
  const explicit = normalizeName(document.querySelector("#ad-ext-game-variant")?.innerText || "");
  if (explicit) return explicit;

  const fromTitle = normalizeName(document.title || "");
  if (/cricket/i.test(fromTitle)) return "Cricket";
  if (/count up/i.test(fromTitle)) return "Count Up";
  if (/killer/i.test(fromTitle)) return "Killer";
  if (/checkout/i.test(fromTitle)) return "Random Checkout";
  if (fromTitle) return "X01";

  return "";
}

function getCurrentLegStartScore() {
  const chips = Array.from(document.querySelectorAll(".chakra-wrap__list .css-bs3vp6, .chakra-wrap__list span"));
  for (const chip of chips) {
    const text = normalizeName(chip.innerText || chip.textContent || "");
    if (!/^(101|170|201|301|501|701|901|1001)$/.test(text)) continue;
    return Number.parseInt(text, 10);
  }

  const title = normalizeName(document.title || "");
  const titleMatch = title.match(/\b(101|170|201|301|501|701|901|1001)\b/);
  if (titleMatch) {
    return Number.parseInt(titleMatch[1], 10);
  }

  return 0;
}

function getVisiblePlayerRemainingScores() {
  const map = {};

  document.querySelectorAll(".ad-ext-player").forEach((playerEl) => {
    const name = normalizeName(
      playerEl.querySelector(".ad-ext-player-name")?.innerText ||
      playerEl.querySelector(".ad-ext-player-name")?.textContent ||
      ""
    );
    const scoreText = normalizeName(
      playerEl.querySelector(".ad-ext-player-score")?.innerText ||
      playerEl.querySelector(".ad-ext-player-score")?.textContent ||
      ""
    );
    const scoreMatch = scoreText.match(/\d+/);
    if (!name || !scoreMatch) return;

    map[name] = Number.parseInt(scoreMatch[0], 10);
  });

  return map;
}

function updateCurrentLegBest(player, score) {
  const safeName = normalizeName(player);
  if (!safeName || !Number.isFinite(score) || score <= 0 || score > 180) return;

  const previous = currentLegBestByPlayer[safeName] || 0;
  if (score > previous) {
    currentLegBestByPlayer[safeName] = score;
  }
}

function commitLegForPlayer(player, modeLabel) {
  const safeName = normalizeName(player);
  if (!safeName) return false;

  const bestScore = clampNumber(currentLegBestByPlayer[safeName], 0, 180, 0);
  currentLegBestByPlayer[safeName] = 0;

  if (!bestScore) return false;

  ensurePlayer(safeName);
  appendLegHistory(players[safeName].global, bestScore);

  const modeKey = normalizeModeKey(modeLabel);
  if (modeKey) {
    ensureModeStats(safeName, modeLabel);
    appendLegHistory(players[safeName].modes[modeKey], bestScore);
  }

  return true;
}

function commitFinishedLegs(modeLabel) {
  const legStartScore = getCurrentLegStartScore();
  const currentScores = getVisiblePlayerRemainingScores();
  let changed = false;

  if (!legStartScore) {
    lastRemainingScoreByPlayer = currentScores;
    return false;
  }

  const allPlayers = new Set([
    ...Object.keys(lastRemainingScoreByPlayer),
    ...Object.keys(currentScores)
  ]);

  allPlayers.forEach((player) => {
    const previousScore = lastRemainingScoreByPlayer[player];
    const currentScore = currentScores[player];

    if (!Number.isFinite(previousScore) || !Number.isFinite(currentScore)) return;

    const startedNewLeg = previousScore < legStartScore && currentScore === legStartScore;
    if (startedNewLeg) {
      changed = commitLegForPlayer(player, modeLabel) || changed;
    }
  });

  lastRemainingScoreByPlayer = currentScores;
  return changed;
}

function isMatchFinished() {
  return Boolean(document.querySelector(".ad-ext-player-winner"));
}

function commitCompletedMatch(modeLabel) {
  if (!isMatchFinished()) {
    matchFinishedCommitted = false;
    return false;
  }

  if (matchFinishedCommitted) return false;

  let changed = false;
  Object.keys(currentLegBestByPlayer).forEach((player) => {
    changed = commitLegForPlayer(player, modeLabel) || changed;
  });

  matchFinishedCommitted = true;
  return changed;
}

function finalizeTurn(player, score, modeLabel) {
  const safeName = normalizeName(player);
  if (!safeName) return;
  if (!Number.isFinite(score) || score <= 0 || score > 180) return;

  ensurePlayer(safeName);
  if (modeLabel) ensureModeStats(safeName, modeLabel);

  updateCurrentLegBest(safeName, score);

  let changed = false;
  let newHighscore = false;

  const globalStats = players[safeName].global;
  if (score > globalStats.highscore) {
    globalStats.highscore = score;
    changed = true;
    newHighscore = true;
  }

  if (score === 180) {
    globalStats.max180 += 1;
    changed = true;
  }

  const modeKey = normalizeModeKey(modeLabel);
  if (modeKey) {
    const modeStats = players[safeName].modes[modeKey];
    if (score > modeStats.highscore) {
      modeStats.highscore = score;
      changed = true;
    }

    if (score === 180) {
      modeStats.max180 += 1;
      changed = true;
    }
  }

  if (changed) {
    savePlayers();
    lastOverlaySignature = "";
    lastHeaderSignature = "";
    lastStatsSignature = "";
    updateOverlay();
    updateHeaderBadge();
    updateStatisticsCard();
  }

  if (newHighscore) {
    flashOverlay();
    playSound();
  }
}

function getUserMenuButton() {
  const buttons = document.querySelectorAll("button.chakra-menu__menu-button");
  for (const button of buttons) {
    if (button.querySelector("img[alt], .chakra-avatar__img")) {
      return button;
    }
  }
  return null;
}

function getLoggedInUserName() {
  const button = getUserMenuButton();
  if (!button) return "";

  const imgAlt = normalizeName(button.querySelector("img[alt]")?.getAttribute("alt") || "");
  if (imgAlt && imgAlt.toLowerCase() !== "avatar") return imgAlt;

  const rawText = normalizeName(button.innerText || button.textContent || "");
  return rawText.replace(/\s+/g, " ").trim();
}

function getStatisticsMount() {
  return (
    document.querySelector("#root .css-nfhdnc") ||
    document.querySelector("#root [role='main']") ||
    document.querySelector("#root main") ||
    null
  );
}

function isStatisticsPage() {
  return location.pathname === "/statistics" || location.pathname.startsWith("/statistics/");
}

function getOverlayElement() {
  let el = document.getElementById(OVERLAY_ID);
  if (el) return el;

  el = document.createElement("div");
  el.id = OVERLAY_ID;
  el.style.position = "fixed";
  el.style.top = "88px";
  el.style.left = "16px";
  el.style.zIndex = "2147483647";
  el.style.fontFamily = "inherit";
  el.style.userSelect = "none";
  el.style.transition = "transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease, width 0.18s ease, height 0.18s ease";

  document.body.appendChild(el);
  return el;
}

function removeOverlay() {
  document.getElementById(OVERLAY_ID)?.remove();
  closeMenu();
  lastOverlaySignature = "";
}

function buildPlayerRow(name, index) {
  const stats = getPlayerStats(name);
  const active = name === currentPlayer;
  const theme = getThemeColors();
  const rowBg = active ? theme.accentRowBg : "rgba(255,255,255,0.03)";
  const rowBorder = active ? theme.accentRowBorder : "rgba(255,255,255,0.06)";
  const activeLabel = active ? `<div style="font-size:11px;color:${theme.accentColor};font-weight:600;letter-spacing:0.02em;">AKTIV</div>` : "";

  return `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 10px;border-radius:10px;background:${rowBg};border:1px solid ${rowBorder};">
      <div style="min-width:0;display:flex;flex-direction:column;gap:2px;">
        <div style="display:flex;align-items:center;gap:8px;min-width:0;">
          <span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:999px;background:rgba(255,255,255,0.08);font-size:12px;color:${TEXT_MUTED};flex:0 0 auto;">${index + 1}</span>
          <span style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(name)}</span>
        </div>
        ${activeLabel}
      </div>
      <div style="text-align:right;display:flex;flex-direction:column;gap:2px;flex:0 0 auto;">
        <span style="font-size:18px;font-weight:700;color:${active ? theme.accentColor : "#ffffff"};">${stats.highscore}</span>
        <span style="font-size:11px;color:${TEXT_MUTED};">180er: ${stats.max180}</span>
      </div>
    </div>
  `;
}

function buildExpandedOverlayHtml(playerNames) {
  const theme = getThemeColors();
  const activeInfo = currentPlayer
    ? `<div style="font-size:11px;color:${TEXT_MUTED};margin-top:2px;">Aktiv: <span style="color:#fff;font-weight:600;">${escapeHtml(currentPlayer)}</span></div>`
    : `<div style="font-size:11px;color:${TEXT_MUTED};margin-top:2px;">Highscores werden automatisch gespeichert</div>`;

  const rows = playerNames.length
    ? playerNames.map((name, index) => buildPlayerRow(name, index)).join("")
    : `<div style="padding:12px 10px;border-radius:10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);font-size:13px;color:${TEXT_MUTED};">Noch keine Daten gespeichert.</div>`;

  return `
    <div style="min-width:280px;max-width:320px;background:${CARD_BG};color:#ffffff;padding:12px;border-radius:12px;border:1px solid ${CARD_BORDER};border-left:4px solid ${theme.accentColor};box-shadow:${BOX_SHADOW};backdrop-filter:blur(8px);">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px;">
        <div>
          <div style="font-size:15px;font-weight:700;letter-spacing:0.01em;">3-Dart Highscores</div>
          ${activeInfo}
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex:0 0 auto;">
          <button id="dart-highscore-collapse" type="button" style="padding:4px 8px;border-radius:999px;background:${theme.accentSoftBg};border:1px solid ${theme.accentSoftBorder};font-size:11px;font-weight:700;color:${theme.accentColor};white-space:nowrap;cursor:pointer;font-family:inherit;">Tracker</button>
          <button id="dart-highscore-menu-button" type="button" aria-label="Tracker-Menü" style="width:30px;height:30px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.04);color:#ffffff;cursor:pointer;font-size:18px;line-height:1;font-family:inherit;">⋯</button>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;">${rows}</div>
      <div style="margin-top:10px;font-size:11px;color:${TEXT_MUTED};display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <span>Klick auf Tracker zum Einklappen</span>
        <span>Menü für Reset</span>
      </div>
    </div>
  `;
}

function buildCollapsedOverlayHtml() {
  const theme = getThemeColors();
  return `
    <button id="dart-highscore-expand" type="button" aria-label="Tracker öffnen" title="Tracker öffnen" style="width:52px;height:52px;border-radius:999px;border:1px solid ${theme.accentSoftBorder};background:${CARD_BG};color:${theme.accentColor};box-shadow:${BOX_SHADOW};display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;font-size:24px;backdrop-filter:blur(8px);font-family:inherit;">
      🎯
    </button>
  `;
}

function bindOverlayEvents() {
  const root = document.getElementById(OVERLAY_ID);
  if (!root) return;

  const collapseBtn = root.querySelector("#dart-highscore-collapse");
  const menuBtn = root.querySelector("#dart-highscore-menu-button");
  const expandBtn = root.querySelector("#dart-highscore-expand");

  if (collapseBtn) {
    collapseBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleCollapsed();
    });
  }

  if (menuBtn) {
    menuBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleMenu();
    });
  }

  if (expandBtn) {
    expandBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleCollapsed(false);
    });

    expandBtn.addEventListener("mouseenter", () => {
      expandBtn.style.boxShadow = BOX_SHADOW_HOVER;
      expandBtn.style.transform = "translateY(-1px)";
    });

    expandBtn.addEventListener("mouseleave", () => {
      expandBtn.style.boxShadow = BOX_SHADOW;
      expandBtn.style.transform = "translateY(0)";
    });
  }
}

function handleThemeChanges() {
  const accentColor = getThemeColors().accentColor;
  if (accentColor === lastThemeAccentColor) return;

  lastThemeAccentColor = accentColor;
  lastOverlaySignature = "";
  lastHeaderSignature = "";
  lastStatsSignature = "";

  if (menuOpen) {
    closeMenu();
  }

  updateOverlay();
  updateHeaderBadge();
  updateStatisticsCard();
}

function updateOverlay() {
  if (!document.body) return;

  if (isStatisticsPage()) {
    removeOverlay();
    return;
  }

  const playerNames = getSortedPlayerNames();
  const signatureObject = {
    collapsed: uiState.collapsed,
    currentPlayer,
    playerNames,
    players: playerNames.reduce((acc, name) => {
      acc[name] = getPlayerStats(name);
      return acc;
    }, {}),
    path: location.pathname,
    accentColor: getThemeColors().accentColor
  };

  const nextSignature = JSON.stringify(signatureObject);
  if (nextSignature === lastOverlaySignature) return;

  const el = getOverlayElement();
  el.innerHTML = uiState.collapsed ? buildCollapsedOverlayHtml() : buildExpandedOverlayHtml(playerNames);

  if (uiState.collapsed) {
    el.style.width = "52px";
    el.style.height = "52px";
  } else {
    el.style.width = "auto";
    el.style.height = "auto";
  }

  bindOverlayEvents();
  lastOverlaySignature = nextSignature;

  if (menuOpen) {
    repositionMenu();
  }
}

function toggleCollapsed(forceState) {
  const nextState = typeof forceState === "boolean" ? forceState : !uiState.collapsed;
  uiState.collapsed = nextState;
  saveUiState();
  closeMenu();
  lastOverlaySignature = "";
  updateOverlay();
}

function toggleMenu() {
  if (menuOpen) {
    closeMenu();
    return;
  }

  const existing = document.getElementById(MENU_ID);
  if (existing) existing.remove();

  const theme = getThemeColors();
  const menu = document.createElement("div");
  menu.id = MENU_ID;
  menu.style.position = "fixed";
  menu.style.background = CARD_BG;
  menu.style.color = "#ffffff";
  menu.style.padding = "10px";
  menu.style.borderRadius = "12px";
  menu.style.boxShadow = "0 12px 34px rgba(0,0,0,0.36)";
  menu.style.border = `1px solid ${CARD_BORDER}`;
  menu.style.borderLeft = `4px solid ${theme.accentColor}`;
  menu.style.zIndex = "2147483647";
  menu.style.fontSize = "13px";
  menu.style.minWidth = "280px";
  menu.style.maxWidth = "320px";
  menu.style.fontFamily = "inherit";
  menu.style.backdropFilter = "blur(8px)";

  const names = getSortedPlayerNames();
  menu.appendChild(createMenuLabel("Tracker zurücksetzen"));

  if (names.length === 0) {
    menu.appendChild(createMenuHint("Keine gespeicherten Spieler"));
  } else {
    names.forEach((name) => {
      menu.appendChild(createMenuItem(`Spieler löschen: ${name}`, () => resetPlayerStats(name)));
    });
  }

  menu.appendChild(createMenuSeparator());
  menu.appendChild(createMenuItem("Alle Daten löschen", resetAllStats, true));

  document.body.appendChild(menu);
  menuOpen = true;
  repositionMenu();

  setTimeout(() => {
    document.addEventListener("click", handleOutsideClick, { once: true });
  }, 0);
}

function repositionMenu() {
  const overlay = document.getElementById(OVERLAY_ID);
  const menu = document.getElementById(MENU_ID);
  if (!overlay || !menu) return;

  const rect = overlay.getBoundingClientRect();
  menu.style.left = `${Math.round(rect.left)}px`;
  menu.style.top = `${Math.round(rect.bottom + 8)}px`;
}

function handleOutsideClick(event) {
  const overlay = document.getElementById(OVERLAY_ID);
  const menu = document.getElementById(MENU_ID);
  if (overlay?.contains(event.target) || menu?.contains(event.target)) return;
  closeMenu();
}

function createMenuLabel(text) {
  const label = document.createElement("div");
  label.innerText = text;
  label.style.padding = "2px 4px 8px";
  label.style.fontSize = "14px";
  label.style.fontWeight = "700";
  return label;
}

function createMenuHint(text) {
  const hint = document.createElement("div");
  hint.innerText = text;
  hint.style.padding = "6px 8px";
  hint.style.fontSize = "12px";
  hint.style.color = TEXT_MUTED;
  return hint;
}

function createMenuSeparator() {
  const hr = document.createElement("div");
  hr.style.height = "1px";
  hr.style.margin = "8px 0";
  hr.style.background = "rgba(255,255,255,0.08)";
  return hr;
}

function createMenuItem(text, onClick, danger = false) {
  const theme = getThemeColors();
  const item = document.createElement("button");
  item.type = "button";
  item.innerText = text;
  item.style.width = "100%";
  item.style.textAlign = "left";
  item.style.padding = "9px 10px";
  item.style.cursor = "pointer";
  item.style.borderRadius = "10px";
  item.style.border = `1px solid ${danger ? "rgba(255,80,80,0.22)" : "rgba(255,255,255,0.06)"}`;
  item.style.background = danger ? "rgba(255,80,80,0.08)" : "rgba(255,255,255,0.03)";
  item.style.color = danger ? "#ffb4b4" : "#ffffff";
  item.style.marginBottom = "6px";
  item.style.fontFamily = "inherit";
  item.style.fontSize = "13px";

  item.addEventListener("mouseenter", () => {
    item.style.background = danger ? "rgba(255,80,80,0.14)" : theme.accentSoftBg;
    item.style.borderColor = danger ? "rgba(255,80,80,0.30)" : theme.accentSoftBorder;
  });

  item.addEventListener("mouseleave", () => {
    item.style.background = danger ? "rgba(255,80,80,0.08)" : "rgba(255,255,255,0.03)";
    item.style.borderColor = danger ? "rgba(255,80,80,0.22)" : "rgba(255,255,255,0.06)";
  });

  item.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });

  return item;
}

function closeMenu() {
  document.getElementById(MENU_ID)?.remove();
  menuOpen = false;
}

function resetPlayerStats(name) {
  const safeName = normalizeName(name);
  if (!safeName || !players[safeName]) {
    closeMenu();
    return;
  }

  delete players[safeName];

  if (currentPlayer === safeName) currentPlayer = "";
  if (lastObservedPlayer === safeName) {
    lastObservedPlayer = "";
    lastObservedScore = null;
  }

  delete currentLegBestByPlayer[safeName];
  delete lastRemainingScoreByPlayer[safeName];

  savePlayers();
  lastOverlaySignature = "";
  lastHeaderSignature = "";
  lastStatsSignature = "";
  updateOverlay();
  updateHeaderBadge();
  updateStatisticsCard();
  closeMenu();
}

function resetAllStats() {
  players = {};
  currentPlayer = "";
  lastObservedPlayer = "";
  lastObservedScore = null;
  lastOverlaySignature = "";
  lastHeaderSignature = "";
  lastStatsSignature = "";
  currentLegBestByPlayer = {};
  lastRemainingScoreByPlayer = {};
  matchFinishedCommitted = false;

  chrome.storage.local.remove(STORAGE_KEY, () => {
    updateOverlay();
    updateHeaderBadge();
    updateStatisticsCard();
    closeMenu();
  });
}

function flashOverlay() {
  const el = document.getElementById(OVERLAY_ID);
  if (!el) return;

  el.style.transform = "translateY(-1px) scale(1.01)";
  setTimeout(() => {
    el.style.transform = "scale(1)";
  }, 320);
}

function playSound() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "triangle";
    osc.frequency.value = 880;
    gain.gain.value = 0.02;

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.12);
    osc.onended = () => ctx.close().catch(() => {});
  } catch (_) {
    // ignore audio errors
  }
}

function updateHeaderBadge() {
  const loggedIn = getLoggedInUserName();
  const signature = JSON.stringify({
    loggedIn,
    stats: getPlayerStats(loggedIn),
    path: location.pathname,
    accentColor: getThemeColors().accentColor
  });

  if (signature === lastHeaderSignature) return;

  const userButton = getUserMenuButton();
  if (!userButton) return;

  const theme = getThemeColors();
  let badge = document.getElementById(HEADER_BADGE_ID);
  const stats = getPlayerStats(loggedIn);

  if (!badge) {
    badge = document.createElement("span");
    badge.id = HEADER_BADGE_ID;
  }

  badge.style.display = "inline-flex";
  badge.style.alignItems = "center";
  badge.style.justifyContent = "center";
  badge.style.marginLeft = "8px";
  badge.style.padding = "3px 8px";
  badge.style.borderRadius = "999px";
  badge.style.background = theme.accentSoftBg;
  badge.style.border = `1px solid ${theme.accentSoftBorder}`;
  badge.style.color = theme.accentColor;
  badge.style.fontSize = "11px";
  badge.style.fontWeight = "700";
  badge.style.whiteSpace = "nowrap";

  badge.textContent = `HS ${stats.highscore}`;
  badge.title = loggedIn
    ? `${loggedIn}: All-Time Highscore ${stats.highscore} | 180er ${stats.max180}`
    : `All-Time Highscore ${stats.highscore} | 180er ${stats.max180}`;

  const usernameSpan = Array.from(userButton.querySelectorAll("span")).find((span) => {
    const text = normalizeName(span.innerText || span.textContent || "");
    return text && !span.querySelector("img, svg");
  });

  if (usernameSpan && badge.parentElement !== userButton) {
    usernameSpan.insertAdjacentElement("afterend", badge);
  } else if (!userButton.contains(badge)) {
    userButton.appendChild(badge);
  }

  lastHeaderSignature = signature;
}


function removeStatisticsCard() {
  document.getElementById(STATS_CARD_ID)?.remove();
  document.getElementById(STATS_TABLE_HEAD_ID)?.remove();
  document.getElementById(STATS_TABLE_BODY_ID)?.remove();
  lastStatsSignature = "";
}

function isVisibleElement(el) {
  return !!(el && el.getClientRects && el.getClientRects().length);
}

function getSelectedLabelFromTablist(tablist) {
  if (!tablist) return "";
  const selected = tablist.querySelector('[role="tab"][aria-selected="true"]');
  return normalizeName(selected?.innerText || selected?.textContent || "");
}

function getStatisticsModeLabel() {
  const tablists = Array.from(document.querySelectorAll('[role="tablist"]')).filter(isVisibleElement);

  for (const tablist of tablists) {
    const labels = Array.from(tablist.querySelectorAll('[role="tab"]')).map((tab) => normalizeName(tab.innerText || tab.textContent || ""));
    if (labels.some((label) => /^(x01|x01\+|cricket|count up|random checkout|killer)$/i.test(label))) {
      return getSelectedLabelFromTablist(tablist);
    }
  }

  return "";
}

function getStatisticsRangeLabel() {
  const tablists = Array.from(document.querySelectorAll('[role="tablist"]')).filter(isVisibleElement);

  for (const tablist of tablists) {
    const labels = Array.from(tablist.querySelectorAll('[role="tab"]')).map((tab) => normalizeName(tab.innerText || tab.textContent || ""));
    if (labels.some((label) => /^letzte\s+\d+/i.test(label))) {
      return getSelectedLabelFromTablist(tablist);
    }
  }

  return "";
}

function getVisibleStatisticsTable() {
  const visibleTopPanel = Array.from(document.querySelectorAll('.chakra-tabs__tab-panel')).find(
    (panel) => isVisibleElement(panel) && !panel.hasAttribute('hidden')
  );

  if (!visibleTopPanel) return null;
  return visibleTopPanel.querySelector('table.chakra-table');
}

function formatStatDelta(value) {
  return value > 0 ? "▲" : value < 0 ? "▼" : "•";
}

function getDeltaColor(value) {
  if (value > 0) return "#6bd993";
  if (value < 0) return "#ff7b6b";
  return TEXT_MUTED;
}

function buildTrackerStatCell(value) {
  return `
    <div style="display:flex;align-items:center;justify-content:center;min-height:32px;">
      <p class="chakra-text css-0" style="font-weight:700;color:#ffffff;">${value}</p>
    </div>
  `;
}

function updateStatisticsCard() {
  if (!isStatisticsPage()) {
    removeStatisticsCard();
    return;
  }

  const table = getVisibleStatisticsTable();
  if (!table) return;

  document.getElementById(STATS_CARD_ID)?.remove();

  const loggedIn = getLoggedInUserName();
  const modeLabel = getStatisticsModeLabel();
  const rangeLabel = getStatisticsRangeLabel();
  const rangeSize = getRangeSizeFromLabel(rangeLabel);

  const sourceStats = modeLabel ? getPlayerModeStats(loggedIn, modeLabel) : getPlayerStats(loggedIn);
  const currentRange = rangeSize > 0 ? getLegHistoryRange(sourceStats, rangeSize) : sourceStats.legHistory || [];
  const currentHighscore = rangeSize > 0 ? getHighscoreFromHistory(currentRange) : sourceStats.highscore;

  const signature = JSON.stringify({
    loggedIn,
    modeLabel,
    rangeLabel,
    rangeSize,
    currentHighscore,
    path: location.pathname,
    accentColor: getThemeColors().accentColor
  });

  if (signature === lastStatsSignature) return;

  let thead = document.getElementById(STATS_TABLE_HEAD_ID);
  let tbody = document.getElementById(STATS_TABLE_BODY_ID);

  if (!thead) {
    thead = document.createElement("thead");
    thead.id = STATS_TABLE_HEAD_ID;
    thead.className = "css-7x0bgn";
  }

  if (!tbody) {
    tbody = document.createElement("tbody");
    tbody.id = STATS_TABLE_BODY_ID;
    tbody.className = "css-ige2xq";
  }

  const currentTitle = modeLabel && rangeLabel
    ? `${modeLabel} • ${rangeLabel}`
    : modeLabel || rangeLabel || "Aktueller Filter";

  thead.innerHTML = `
    <tr class="css-0">
      <th class="css-z865eh"><p class="chakra-text css-9c7r58">TRACKER-WERT</p></th>
      <th class="css-1k95i1t" colspan="2"><p class="chakra-text css-1kuy7z7">${escapeHtml(currentTitle)}</p></th>
    </tr>
  `;

  tbody.innerHTML = `
    <tr class="css-0">
      <td class="css-1y8jmcr">3-Dart Highscore</td>
      <td class="css-1fq7vy1" colspan="2">${buildTrackerStatCell(currentHighscore)}</td>
    </tr>
  `;

  if (!table.contains(thead)) {
    table.appendChild(thead);
  }
  if (!table.contains(tbody)) {
    table.appendChild(tbody);
  }

  lastStatsSignature = signature;
}


function handleRouteChanges() {
  if (location.pathname === lastPathname) return;
  lastPathname = location.pathname;
  lastOverlaySignature = "";
  lastHeaderSignature = "";
  lastStatsSignature = "";
  closeMenu();
  currentLegBestByPlayer = {};
  lastRemainingScoreByPlayer = {};
  matchFinishedCommitted = false;
  updateOverlay();
  updateHeaderBadge();
  updateStatisticsCard();
}

function tick() {
  try {
    if (!isLoaded) return;

    handleRouteChanges();
    handleThemeChanges();

    const player = getActivePlayerName();
    const score = getTurnScore();
    const modeLabel = getCurrentPlayModeLabel();

    getAllVisiblePlayerNames().forEach(ensurePlayer);

    if (player && score !== null) {
      currentPlayer = player;
      ensurePlayer(player);

      if (!lastObservedPlayer || lastObservedScore === null) {
        lastObservedPlayer = player;
        lastObservedScore = score;
      } else {
        if (player !== lastObservedPlayer) {
          finalizeTurn(lastObservedPlayer, lastObservedScore, modeLabel);
        } else if (score < lastObservedScore) {
          finalizeTurn(player, lastObservedScore, modeLabel);
        }

        lastObservedPlayer = player;
        lastObservedScore = score;
      }
    }

    const legHistoryChanged = commitFinishedLegs(modeLabel);
    const matchCommitChanged = commitCompletedMatch(modeLabel);

    if (legHistoryChanged || matchCommitChanged) {
      savePlayers();
      lastStatsSignature = "";
      updateStatisticsCard();
      updateHeaderBadge();
      updateOverlay();
    }

    updateOverlay();
    updateHeaderBadge();
    updateStatisticsCard();
  } catch (error) {
    console.error("[Autodarts Highscore Tracker]", error);
  }
}

function startTracker() {
  if (tickTimer) return;

  loadState().then(() => {
    updateOverlay();
    updateHeaderBadge();
    updateStatisticsCard();
    tick();
    tickTimer = window.setInterval(tick, 300);
    window.addEventListener("resize", repositionMenu);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startTracker, { once: true });
} else {
  startTracker();
}
