/*
 * Antigravity Vitals — Auxiliary Pane Frontend.
 *
 * Performance & Lifecycle:
 * - Zero background work when hidden/collapsed: pauses both polling and live
 *   timers via `visibilityState` + `ResizeObserver` (`clientWidth/Height > 0`).
 * - Incremental DOM patching during streaming: avoids redrawing SVG charts,
 *   turns ledger, and 100-cell matrix when `historyRev` is unchanged.
 * - On-demand 100ms clock ticker: only active while pane is visible & model
 *   or tools are actively running.
 * - Automatic bilingual UI (zh / en) via `window.VitalsI18n`.
 */
(() => {
  const ACTIVE_POLL_MS = 350;
  const IDLE_POLL_MS = 900;
  const EMPTY_POLL_MS = 1500;
  const LIVE_TICK_MS = 100;
  const LIMIT_PRESETS = [0, 200000, 256000, 512000, 1000000]; // 0 = auto-detected

  const i18n = window.VitalsI18n;
  const t = (key, vars) => (i18n ? i18n.t(key, vars) : key);

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  const state = {
    conv: null,
    etag: '',
    data: null,
    renderedHistoryRev: '',
    renderedToolsRev: '',
    lastOk: 0,
    clockOffsetMs: 0,
    stale: false,
    visible: true,
    pollTimer: null,
    pollInFlight: false,
    clockTimer: null,
    activeTab: 'overview',
    chartMode: 'tps', // 'tps' | 'cache'
    tpsMode: 'decode', // 'decode' | 'e2e'
    tpsModeUserPinned: false,
    limitPresetIdx: 0, // 0 => auto detected
    turnFilter: 'all',
    expandedTurnId: null,
    dismissedAlerts: new Set(),
    currentAlertKey: '',
  };

  // ---------- Host Bridge & Theme ----------
  const currentConv = () => window.sidecar?.conversationId || params.get('conversationId') || '';

  async function fetchJson(path) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, { method: 'GET' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  function syncThemeScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const theme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }
  syncThemeScheme();
  new MutationObserver(syncThemeScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  // ---------- Visibility & On-Demand Timers ----------
  function isPaneVisible() {
    if (document.visibilityState !== 'visible') return false;
    const el = document.documentElement;
    return el.clientWidth > 0 && el.clientHeight > 0;
  }

  function isActiveState(activity) {
    return activity === 'waiting_ttft' || activity === 'streaming' || activity === 'tool_running';
  }

  function stopLiveClock() {
    if (state.clockTimer != null) {
      clearInterval(state.clockTimer);
      state.clockTimer = null;
    }
  }

  function syncLiveClock() {
    const needClock = state.visible && isActiveState(state.data?.activity);
    if (needClock && state.clockTimer == null) {
      state.clockTimer = setInterval(updateLiveClocks, LIVE_TICK_MS);
    } else if (!needClock && state.clockTimer != null) {
      stopLiveClock();
    }
  }

  function schedulePoll(delayMs) {
    if (state.pollTimer != null) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
    if (!state.visible) return;
    state.pollTimer = setTimeout(() => {
      state.pollTimer = null;
      poll();
    }, delayMs);
  }

  function syncVisibility() {
    const nowVisible = isPaneVisible();
    if (nowVisible === state.visible) return;
    state.visible = nowVisible;

    if (!nowVisible) {
      if (state.pollTimer != null) {
        clearTimeout(state.pollTimer);
        state.pollTimer = null;
      }
      stopLiveClock();
    } else {
      syncLiveClock();
      if (!state.pollInFlight) {
        schedulePoll(0);
      }
    }
  }

  document.addEventListener('visibilitychange', syncVisibility);
  window.addEventListener('focus', syncVisibility);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(syncVisibility).observe(document.documentElement);
  }

  // ---------- Formatting Helpers ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function nowSyncedMs() {
    return Date.now() + state.clockOffsetMs;
  }

  function fmtNum(n) {
    if (n == null || !Number.isFinite(n)) return '--';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 100_000) return `${Math.round(n / 1000)}k`;
    if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
    return String(Math.round(n));
  }

  function fmtLimit(n) {
    if (!n) return '--';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
    return `${Math.round(n / 1000)}k`;
  }

  function fmtSec(sec, digits = 2) {
    if (sec == null || !Number.isFinite(sec)) return '--';
    return `${sec.toFixed(digits)}s`;
  }

  function fmtDurShort(sec) {
    if (sec == null || !Number.isFinite(sec)) return '--';
    if (sec >= 60) {
      const m = Math.floor(sec / 60);
      const s = Math.round(sec % 60);
      return `${m}m${String(s).padStart(2, '0')}s`;
    }
    return `${sec.toFixed(1)}s`;
  }

  function fmtTps(tps) {
    if (tps == null || !Number.isFinite(tps) || tps <= 0) return '--';
    return tps.toFixed(1);
  }

  function fmtClock(ms) {
    if (!ms || !Number.isFinite(ms)) return '--:--:--';
    const d = new Date(ms);
    return d.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function activeContextLimit(data) {
    const preset = LIMIT_PRESETS[state.limitPresetIdx];
    return preset > 0 ? preset : data.contextLimit || 256000;
  }

  function effectiveTpsMode(data) {
    if (data?.tpsPrecision !== 'decode') return 'e2e';
    return state.tpsMode;
  }

  function cacheToneColor(rate) {
    if (rate >= 75) return 'var(--v-success)';
    if (rate >= 30) return 'var(--v-warning)';
    return 'var(--v-error)';
  }

  function localizeCategory(c) {
    const labelKey = `cat_${c.key}`;
    const label = t(labelKey);
    let detail = c.detail || '';
    if (c.key === 'system_prompt') {
      detail = c.count ? t('detail_system_prompt', { n: c.count }) : t('detail_system_prompt_fallback');
    } else if (c.count != null && ['tool_outputs', 'assistant', 'tool_defs', 'user'].includes(c.key)) {
      detail = t(`detail_${c.key}`, { n: c.count });
    } else if (['cache_read', 'uncached_input', 'output'].includes(c.key)) {
      detail = t(`detail_${c.key}`);
    }
    return { label: label === labelKey ? c.label : label, detail };
  }

  function formatAlert(alertObj, ctxPct, latestContextUsed, limit) {
    if (!alertObj) return null;
    if (alertObj.code === 'cache_drop' && alertObj.params) {
      const p = alertObj.params;
      const warmStr = p.avgWarmTtft != null ? `${p.avgWarmTtft.toFixed(2)}s` : t('alertWarmDefault');
      const ttftPart =
        p.ttftSec != null ? t('alertCacheDropTtft', { cur: p.ttftSec.toFixed(2), warm: warmStr }) : '';
      return {
        level: alertObj.level,
        title: t('alertCacheDropTitle', { rate: p.cacheRate }),
        desc: t('alertCacheDropDesc', {
          id: p.turnId,
          tokens: Number(p.totalPrompt || 0).toLocaleString(),
          ttftPart,
        }),
      };
    }
    if (alertObj.code === 'context_high') {
      const pctVal = alertObj.params?.ctxPct ?? Number(ctxPct.toFixed(1));
      const usedVal = alertObj.params?.contextUsed ?? latestContextUsed;
      const limitVal = alertObj.params?.contextLimit ?? limit;
      return {
        level: alertObj.level,
        title: t('alertCtxHighTitle', { pct: pctVal.toFixed(1) }),
        desc: t('alertCtxHighDesc', {
          used: Number(usedVal).toLocaleString(),
          limit: Number(limitVal).toLocaleString(),
        }),
      };
    }
    return alertObj;
  }

  function syncLangButton() {
    const btn = $('langToggleBtn');
    if (btn) btn.textContent = t('langLabel');
  }

  // ---------- Smooth 100ms Live Clocks ----------
  function updateLiveClocks() {
    const data = state.data;
    if (!state.visible || !data || !isActiveState(data.activity)) return;
    const now = nowSyncedMs();

    if (data.liveTurn && data.hasData && data.summary) {
      const lt = data.liveTurn;
      if (lt.phase === 'waiting_ttft' && lt.startedAtMs) {
        const waitSec = Math.max(0, (now - lt.startedAtMs) / 1000);
        $('kpiTtft').textContent = `${waitSec.toFixed(1)}s…`;
        $('lastTurnLabel').textContent = t('stripRequesting');
        $('lastTurnMeta').textContent = t('stripWaitingTtft', { sec: waitSec.toFixed(1) });
      } else if (lt.phase === 'streaming' && lt.streamingStartedAtMs) {
        const decSec = Math.max(0.1, (now - lt.streamingStartedAtMs) / 1000);
        const estTok = lt.estOutputTokens || 0;
        const liveTps = decSec >= 0.4 && estTok >= 15 ? estTok / decSec : null;
        if (liveTps != null) {
          $('kpiTps').textContent = liveTps.toFixed(1);
        }
        $('kpiTtft').textContent = fmtSec(lt.elapsedTtftSec);
        $('lastTurnLabel').textContent = t('stripGenerating');
        $('lastTurnMeta').textContent = t('stripStreamingMeta', {
          tok: fmtNum(estTok),
          sec: decSec.toFixed(1),
        });
      }
    }

    const activeTools = data.toolStats?.activeTools || [];
    if (activeTools.length > 0) {
      activeTools.forEach((tool, idx) => {
        const el = $(`active-tool-timer-${idx}`);
        if (el && tool.startedAtMs) {
          const sec = Math.max(0, (now - tool.startedAtMs) / 1000);
          el.textContent = `${sec.toFixed(1)}s`;
        }
      });
    }
  }

  // ---------- Shared Status / Live Section Renderer ----------
  function renderStatusAndLive(data) {
    const s = data.summary;
    const turns = data.turns || [];
    const last = turns[turns.length - 1];
    const mode = effectiveTpsMode(data);

    const liveDot = $('liveDot');
    if (state.stale) {
      liveDot.className = 'live-dot dot-warn';
      $('footerSync').textContent = t('syncDisconnected');
    } else if (data.activity === 'waiting_ttft') {
      liveDot.className = 'live-dot dot-live';
      $('footerSync').textContent = t('syncWaitingTtft');
    } else if (data.activity === 'streaming') {
      liveDot.className = 'live-dot dot-live';
      $('footerSync').textContent = t('syncStreaming');
    } else if (data.activity === 'tool_running') {
      liveDot.className = 'live-dot dot-live';
      $('footerSync').textContent = t('syncToolRunning');
    } else if (data.alert?.level === 'error') {
      liveDot.className = 'live-dot dot-err';
      $('footerSync').textContent = t('syncLiveIdle');
    } else if (data.alert?.level === 'warning') {
      liveDot.className = 'live-dot dot-warn';
      $('footerSync').textContent = t('syncLiveIdle');
    } else {
      liveDot.className = 'live-dot dot-ok';
      $('footerSync').textContent = t('syncLiveIdle');
    }

    // KPI 1: TPS & TTFT
    $('tpsTitle').textContent = mode === 'decode' ? t('kpiDecodeTps') : t('kpiE2eTps');
    let mainTps = mode === 'decode' ? s.headlineDecodeTps : s.latestE2eTps;
    if (data.activity === 'streaming' && data.liveTurn?.estLiveTps != null) {
      mainTps = data.liveTurn.estLiveTps;
    }
    const avgTps = mode === 'decode' ? s.avgDecodeTps : s.avgE2eTps;
    $('kpiTps').textContent = fmtTps(mainTps);
    $('kpiTtft').textContent =
      data.activity === 'streaming' && data.liveTurn?.elapsedTtftSec != null
        ? fmtSec(data.liveTurn.elapsedTtftSec)
        : fmtSec(s.latestTtftSec);
    $('kpiAvgTps').textContent = fmtTps(avgTps);

    const tpsTag = $('tpsStateTag');
    if (data.activity === 'waiting_ttft') {
      tpsTag.textContent = t('stateWaitingTtft');
      tpsTag.className = 'mono tag-live';
    } else if (data.activity === 'streaming') {
      tpsTag.textContent = data.liveTurn?.estLiveTps != null ? t('stateStreamingLive') : t('stateStreaming');
      tpsTag.className = 'mono tag-live';
    } else if (data.activity === 'tool_running') {
      tpsTag.textContent = t('stateToolRunning');
      tpsTag.className = 'mono tag-live';
    } else if (mode === 'decode' && s.headlineDecodeIsFallback) {
      tpsTag.textContent = t('statePrevSteady');
      tpsTag.className = 'mono muted';
    } else if (last.cacheRate < 20) {
      tpsTag.textContent = t('stateColdPrefill');
      tpsTag.className = 'mono tag-warn';
    } else {
      tpsTag.textContent = t('stateWarmCache');
      tpsTag.className = 'mono tag-ok';
    }

    // Latest Turn Strip
    const stripCard = $('lastTurnCard');
    stripCard.classList.toggle('is-live', data.activity === 'streaming' || data.activity === 'waiting_ttft');
    if (data.activity === 'waiting_ttft' && data.liveTurn) {
      $('lastTurnLabel').textContent = t('stripRequesting');
      $('lastTurnMeta').textContent = t('stripWaitingTtft', { sec: data.liveTurn.elapsedTtftSec.toFixed(1) });
    } else if (data.activity === 'streaming' && data.liveTurn) {
      $('lastTurnLabel').textContent = t('stripGenerating');
      $('lastTurnMeta').textContent = t('stripStreamingMeta', {
        tok: fmtNum(data.liveTurn.estOutputTokens),
        sec: (data.liveTurn.elapsedDecodeSec || 0).toFixed(1),
      });
    } else {
      $('lastTurnLabel').textContent = t('stripLatest');
      const durStr = last.e2eSec != null ? t('stripDur', { sec: last.e2eSec.toFixed(1) }) : t('stripNoDur');
      $('lastTurnMeta').textContent = t('stripLatestMeta', {
        id: last.id,
        tok: fmtNum(last.totalOutput),
        dur: durStr,
      });
    }
  }

  function renderLivePatch(data) {
    renderStatusAndLive(data);
    if (data.toolsRev !== state.renderedToolsRev) {
      renderToolsCard(data.toolStats);
      state.renderedToolsRev = data.toolsRev || '';
    }
    syncLiveClock();
    if (isActiveState(data.activity)) updateLiveClocks();
  }

  // ---------- Full Rendering ----------
  function render() {
    syncLangButton();
    const data = state.data;
    const conv = state.conv || data?.conversationId || '';
    $('footerConv').textContent = conv ? `conv: ${conv.slice(0, 8)}…` : 'conv: --';

    if (!data || !data.hasData || !data.summary) {
      state.renderedHistoryRev = '';
      state.renderedToolsRev = '';
      $('emptyState').classList.remove('hidden');
      $('content').classList.add('hidden');
      $('modelLabel').textContent = t('waitingSessionShort');
      $('turnsCountBadge').textContent = '0';
      $('sourceBadge').textContent = data?.source === 'transcript' ? 'JSONL' : 'SQLite';
      $('liveDot').className = `live-dot ${state.stale ? 'dot-warn' : 'dot-live'}`;
      $('emptyTitle').textContent =
        data?.activity === 'waiting_ttft' || data?.activity === 'streaming'
          ? t('emptyTitleStreaming')
          : conv
            ? t('emptyTitleWaiting')
            : t('emptyTitleNoConv');
      $('emptyHintText').textContent = conv ? t('emptyHintWatching', { id: conv.slice(0, 8) }) : t('emptyHintSelect');
      $('footerSync').textContent = state.stale ? t('syncReconnecting') : t('syncWaitingData');
      syncLiveClock();
      return;
    }

    $('emptyState').classList.add('hidden');
    $('content').classList.remove('hidden');

    const s = data.summary;
    const turns = data.turns || [];
    const last = turns[turns.length - 1];
    const limit = activeContextLimit(data);
    const mode = effectiveTpsMode(data);

    $('modelLabel').textContent = data.model?.display || data.model?.id || 'Unknown Model';
    $('modelLabel').title = `${data.model?.display || ''} (${data.model?.id || ''})`;
    $('turnsCountBadge').textContent = String(turns.length);

    const srcBadge = $('sourceBadge');
    srcBadge.textContent = data.source === 'sqlite' ? 'SQLite' : 'JSONL';
    srcBadge.title = data.source === 'sqlite' ? t('sourceTitleSqlite') : t('sourceTitleJsonl');

    const tpsBtn = $('tpsModeBtn');
    tpsBtn.textContent = mode === 'decode' ? 'Decode' : 'E2E';
    tpsBtn.disabled = data.tpsPrecision !== 'decode';
    tpsBtn.title = data.tpsPrecision === 'decode' ? t('tpsBtnTitleDecode') : t('tpsBtnTitleFallback');

    // Dismissible Localized Alert Banner
    const ctxPct = limit > 0 ? (s.latestContextUsed / limit) * 100 : 0;
    let rawAlert = data.alert;
    if (!rawAlert && ctxPct >= 80) {
      rawAlert = {
        code: 'context_high',
        level: ctxPct >= 92 ? 'error' : 'warning',
        params: {
          ctxPct: Number(ctxPct.toFixed(1)),
          contextUsed: s.latestContextUsed,
          contextLimit: limit,
        },
      };
    }

    let alertKey = '';
    if (rawAlert) {
      alertKey =
        rawAlert.code === 'context_high'
          ? `${conv}:context_high:${rawAlert.level}:${Math.floor(ctxPct / 5) * 5}`
          : `${conv}:${rawAlert.code || 'alert'}:${last.id}`;
    }
    state.currentAlertKey = alertKey;

    const alertEl = $('alertBanner');
    const formattedAlert = formatAlert(rawAlert, ctxPct, s.latestContextUsed, limit);
    if (formattedAlert && !state.dismissedAlerts.has(alertKey)) {
      alertEl.className = `alert-banner level-${formattedAlert.level === 'error' ? 'error' : 'warning'}`;
      $('alertTitle').textContent = formattedAlert.title;
      $('alertDesc').textContent = formattedAlert.desc;
    } else {
      alertEl.className = 'alert-banner hidden';
    }

    renderStatusAndLive(data);

    // KPI 2: Cache Hit Rate
    const kpiCache = $('kpiCache');
    kpiCache.textContent = `${s.overallCacheRate.toFixed(1)}%`;
    kpiCache.style.color =
      last.isCacheDrop
        ? 'var(--v-error)'
        : s.overallCacheRate >= 75
          ? 'var(--v-success)'
          : s.overallCacheRate >= 30
            ? 'var(--v-warning)'
            : 'var(--v-error)';

    const cacheTrend = $('cacheTrend');
    cacheTrend.textContent = t('kpiTurnCache', { pct: s.latestCacheRate.toFixed(1) });
    cacheTrend.style.color = cacheToneColor(s.latestCacheRate);
    $('kpiCacheSaved').textContent = fmtNum(s.totalCacheRead);
    $('kpiCacheCold').textContent = t('kpiColdCount', { n: s.coldCount });

    // KPI 3: Context Utilization
    const limitBtn = $('limitCycleBtn');
    const isAutoLimit = state.limitPresetIdx === 0;
    limitBtn.textContent = isAutoLimit ? fmtLimit(limit) : `${fmtLimit(limit)}*`;

    const kpiCtxPct = $('kpiCtxPct');
    kpiCtxPct.textContent = `${Math.min(100, ctxPct).toFixed(1)}%`;
    kpiCtxPct.style.color =
      ctxPct >= 80 ? 'var(--v-error)' : ctxPct >= 65 ? 'var(--v-warning)' : 'var(--v-fg)';
    $('kpiCtxUsed').textContent = t('kpiCtxUsed', { n: fmtNum(s.latestContextUsed) });
    $('kpiCtxLeft').textContent = t('kpiCtxLeft', { n: fmtNum(Math.max(0, limit - s.latestContextUsed)) });

    // KPI 4: Session Tokens
    $('kpiCalls').textContent = t('kpiCallsCount', { n: s.turnCount });
    $('kpiTotalTok').textContent = fmtNum(s.totalTokensAll);
    $('kpiInTok').textContent = fmtNum(s.totalPromptAll);
    $('kpiOutTok').textContent = fmtNum(s.totalOutputAll);

    // Context Window Segmented Bar
    const segs = s.latestWindowSegments;
    $('ctxBarSummary').textContent = `${s.latestContextUsed.toLocaleString()} / ${limit.toLocaleString()}`;
    const pctW = (val) => `${Math.min(100, Math.max(0, limit > 0 ? (val / limit) * 100 : 0)).toFixed(2)}%`;
    $('segCache').style.width = pctW(segs.cacheRead);
    $('segUncached').style.width = pctW(segs.uncachedInput);
    $('segThinking').style.width = pctW(segs.thinking);
    $('segReply').style.width = pctW(segs.response);

    $('legCache').textContent = fmtNum(segs.cacheRead);
    $('legUncached').textContent = fmtNum(segs.uncachedInput);
    $('legThinking').textContent = fmtNum(segs.thinking);
    $('legReply').textContent = fmtNum(segs.response);

    renderTrendChart(turns, mode);
    renderToolsCard(data.toolStats);
    renderTurnsList(turns, mode);
    renderBreakdown(data, limit);

    state.renderedHistoryRev = data.historyRev || '';
    state.renderedToolsRev = data.toolsRev || '';

    syncLiveClock();
    if (isActiveState(data.activity)) updateLiveClocks();
  }

  function renderToolsCard(toolStats) {
    const summaryEl = $('toolsSummary');
    const activeWrap = $('activeToolsStrip');
    const listEl = $('toolsList');

    if (!toolStats || toolStats.totalCalls === 0) {
      summaryEl.textContent = t('toolsCallsUnit', { n: 0 });
      activeWrap.classList.add('hidden');
      activeWrap.innerHTML = '';
      listEl.innerHTML = `<div class="tools-empty">${esc(t('toolsEmpty'))}</div>`;
      return;
    }

    const parts = [t('toolsCallsUnit', { n: toolStats.totalCalls })];
    if (toolStats.totalDurationSec > 0) parts.push(fmtDurShort(toolStats.totalDurationSec));
    if (toolStats.errorCalls > 0) parts.push(t('toolsErrorsUnit', { n: toolStats.errorCalls }));
    summaryEl.textContent = parts.join(' · ');

    const active = toolStats.activeTools || [];
    if (active.length > 0) {
      activeWrap.classList.remove('hidden');
      activeWrap.innerHTML = active
        .map(
          (tool, idx) => `
          <div class="active-tool-pill">
            <span class="active-tool-left">
              <span class="live-dot dot-live" aria-hidden="true"></span>
              <span class="mono strong truncate">${esc(tool.name)}</span>
              <span class="muted">${esc(t('toolsRunning'))}</span>
            </span>
            <span id="active-tool-timer-${idx}" class="mono strong">${(tool.elapsedSec || 0).toFixed(1)}s</span>
          </div>
        `
        )
        .join('');
    } else {
      activeWrap.classList.add('hidden');
      activeWrap.innerHTML = '';
    }

    const top = (toolStats.hotspots || []).slice(0, 5);
    const maxCount = Math.max(1, ...top.map((item) => item.count));

    listEl.innerHTML = top
      .map((item) => {
        const w = Math.max(6, (item.count / maxCount) * 100);
        const dur = item.totalDurationSec > 0 ? fmtDurShort(item.totalDurationSec) : '';
        const errPill =
          item.errors > 0
            ? `<span class="tool-err-pill mono">${esc(t('toolsErrorsUnit', { n: item.errors }))}</span>`
            : '';
        const runDot = item.running > 0 ? `<span class="live-dot dot-live" aria-hidden="true"></span>` : '';
        return `
          <div class="tool-row">
            <div class="tool-row-head">
              <span class="tool-name-wrap">
                ${runDot}
                <span class="tool-name mono truncate">${esc(item.name)}</span>
                ${errPill}
              </span>
              <span class="tool-metrics mono">
                <span class="strong">×${item.count}</span>
                ${dur ? `<span>${dur}</span>` : ''}
              </span>
            </div>
            <div class="tool-bar-track">
              <div class="tool-bar-fill${item.running > 0 ? ' is-running' : ''}" style="width: ${w.toFixed(1)}%;"></div>
            </div>
          </div>
        `;
      })
      .join('');
  }

  function renderTrendChart(turns, mode) {
    const wrap = $('svgChartWrap');
    const recent = turns.slice(-12);
    $('chartTitle').textContent = t('chartTitleRecent', { n: recent.length || 12 });
    const insp = $('chartInspectorVal');

    if (recent.length === 0) {
      wrap.innerHTML = '';
      insp.textContent = '--';
      return;
    }

    const W = 330;
    const H = 108;
    const padL = 28;
    const padR = 8;
    const padT = 10;
    const padB = 18;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const n = recent.length;
    const latest = recent[n - 1];

    if (state.chartMode === 'tps') {
      const getVal = (turn) => (mode === 'decode' ? turn.decodeTps : turn.e2eTps);
      const validVals = recent.map(getVal).filter((v) => v != null && v > 0);
      const maxTps = Math.max(80, ...(validVals.length ? validVals : [100])) * 1.12;
      const maxTtft = Math.max(4, ...recent.map((turn) => turn.ttftSec || 0));
      const stepX = n > 1 ? innerW / (n - 1) : 0;

      const formatInsp = (turn) => {
        const v = getVal(turn);
        if (mode === 'decode' && turn.isShortSample) {
          return t('inspShortSample', {
            id: turn.id,
            sec: fmtSec(turn.decodeSec, 1),
            tok: turn.totalOutput,
            ttft: fmtSec(turn.ttftSec),
          });
        }
        return t('inspTps', {
          id: turn.id,
          tps: v != null ? v.toFixed(1) : '--',
          ttft: fmtSec(turn.ttftSec),
        });
      };
      insp.textContent = formatInsp(latest);

      const points = recent.map((turn, i) => {
        const cx = n > 1 ? padL + i * stepX : padL + innerW / 2;
        const v = getVal(turn);
        const cy = v != null ? padT + innerH - (v / maxTps) * innerH : null;
        const barH = turn.ttftSec != null ? Math.max(3, (turn.ttftSec / maxTtft) * (innerH * 0.65)) : 0;
        return { cx, cy, v, barH, turn, idx: i };
      });

      const validPoints = points.filter((p) => p.cy != null);
      const pathD = validPoints
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.cx.toFixed(1)},${p.cy.toFixed(1)}`)
        .join(' ');
      const areaD =
        validPoints.length > 1
          ? `${pathD} L${validPoints[validPoints.length - 1].cx.toFixed(1)},${padT + innerH} L${validPoints[0].cx.toFixed(1)},${padT + innerH} Z`
          : '';

      wrap.innerHTML = `
        <svg viewBox="0 0 ${W} ${H}">
          <line x1="${padL}" y1="${padT}" x2="${W - padR}" y2="${padT}" stroke="var(--v-card-border)" stroke-dasharray="2 2" />
          <line x1="${padL}" y1="${padT + innerH / 2}" x2="${W - padR}" y2="${padT + innerH / 2}" stroke="var(--v-card-border)" stroke-dasharray="2 2" />
          <line x1="${padL}" y1="${padT + innerH}" x2="${W - padR}" y2="${padT + innerH}" stroke="var(--v-border)" />
          <text x="${padL - 4}" y="${padT + 4}" text-anchor="end" fill="var(--v-muted)" font-size="9" font-family="monospace">${Math.round(maxTps)}</text>
          <text x="${padL - 4}" y="${padT + innerH}" text-anchor="end" fill="var(--v-muted)" font-size="9" font-family="monospace">0</text>
          ${points
            .map((p) =>
              p.barH > 0
                ? `<rect x="${(p.cx - 4).toFixed(1)}" y="${(padT + innerH - p.barH).toFixed(1)}" width="8" height="${p.barH.toFixed(1)}" rx="2" fill="${
                    (p.turn.ttftSec || 0) > 6 ? 'var(--v-warning)' : 'var(--v-chart-3)'
                  }" opacity="0.28" />`
                : ''
            )
            .join('')}
          ${areaD ? `<path d="${areaD}" fill="var(--v-chart-1)" opacity="0.11" />` : ''}
          ${validPoints.length > 1 ? `<path d="${pathD}" fill="none" stroke="var(--v-chart-1)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />` : ''}
          ${points
            .map((p, idx) => {
              const dotY = p.cy != null ? p.cy : padT + innerH - 2;
              const strokeColor = p.cy != null ? 'var(--v-chart-1)' : 'var(--v-muted)';
              const dotR = p.cy != null ? '3.2' : '2.3';
              return `
                <g class="chart-pt" data-idx="${idx}" style="cursor:pointer;">
                  <rect x="${(p.cx - 9).toFixed(1)}" y="${padT}" width="18" height="${innerH}" fill="transparent" />
                  <circle cx="${p.cx.toFixed(1)}" cy="${dotY.toFixed(1)}" r="${dotR}" fill="var(--v-card)" stroke="${strokeColor}" stroke-width="${p.cy != null ? '2' : '1.4'}" ${p.cy == null ? 'stroke-dasharray="2 1.5"' : ''} />
                  ${
                    idx === 0 || idx === n - 1 || idx % 3 === 0
                      ? `<text x="${p.cx.toFixed(1)}" y="${H - 3}" text-anchor="middle" fill="var(--v-muted)" font-size="9" font-family="monospace">#${p.turn.id}</text>`
                      : ''
                  }
                </g>
              `;
            })
            .join('')}
        </svg>
      `;

      wrap.querySelectorAll('.chart-pt').forEach((el) => {
        el.addEventListener('mouseenter', () => {
          const item = recent[Number(el.dataset.idx)];
          if (item) insp.textContent = formatInsp(item);
        });
      });
    } else {
      const formatInsp = (turn) =>
        t('inspCache', {
          id: turn.id,
          rate: turn.cacheRate.toFixed(1),
          read: fmtNum(turn.cacheReadTokens),
        });
      insp.textContent = formatInsp(latest);

      const barSlot = innerW / n;
      const barW = Math.max(8, Math.min(20, barSlot - 5));

      wrap.innerHTML = `
        <svg viewBox="0 0 ${W} ${H}">
          <line x1="${padL}" y1="${padT}" x2="${W - padR}" y2="${padT}" stroke="var(--v-card-border)" stroke-dasharray="2 2" />
          <line x1="${padL}" y1="${padT + innerH / 2}" x2="${W - padR}" y2="${padT + innerH / 2}" stroke="var(--v-card-border)" stroke-dasharray="2 2" />
          <line x1="${padL}" y1="${padT + innerH}" x2="${W - padR}" y2="${padT + innerH}" stroke="var(--v-border)" />
          <text x="${padL - 4}" y="${padT + 4}" text-anchor="end" fill="var(--v-muted)" font-size="9" font-family="monospace">100%</text>
          <text x="${padL - 4}" y="${padT + innerH}" text-anchor="end" fill="var(--v-muted)" font-size="9" font-family="monospace">0%</text>
          ${recent
            .map((turn, idx) => {
              const cx = padL + idx * barSlot + barSlot / 2;
              const bh = Math.max(4, (turn.cacheRate / 100) * innerH);
              const color = cacheToneColor(turn.cacheRate);
              return `
                <g class="chart-bar" data-idx="${idx}" style="cursor:pointer;">
                  <rect x="${(cx - barSlot / 2).toFixed(1)}" y="${padT}" width="${barSlot.toFixed(1)}" height="${innerH}" fill="transparent" />
                  <rect x="${(cx - barW / 2).toFixed(1)}" y="${(padT + innerH - bh).toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="3" fill="${color}" opacity="0.88" />
                  ${
                    idx === 0 || idx === n - 1 || idx % 3 === 0
                      ? `<text x="${cx.toFixed(1)}" y="${H - 3}" text-anchor="middle" fill="var(--v-muted)" font-size="9" font-family="monospace">#${turn.id}</text>`
                      : ''
                  }
                </g>
              `;
            })
            .join('')}
        </svg>
      `;

      wrap.querySelectorAll('.chart-bar').forEach((el) => {
        el.addEventListener('mouseenter', () => {
          const item = recent[Number(el.dataset.idx)];
          if (item) insp.textContent = formatInsp(item);
        });
      });
    }
  }

  function renderTurnsList(turns, mode) {
    const container = $('turnsList');
    const filtered = [...turns].reverse().filter((turn) => {
      if (state.turnFilter === 'cold') return turn.cacheRate < 40;
      if (state.turnFilter === 'tool') return turn.kind === 'tool';
      return true;
    });

    if (!filtered.length) {
      container.innerHTML = `<div class="card empty-filter">${esc(t('turnsEmptyFilter'))}</div>`;
      return;
    }

    container.innerHTML = filtered
      .map((turn) => {
        const isOpen = state.expandedTurnId === turn.id;
        const isShortInDecode = mode === 'decode' && turn.isShortSample;
        const shownTps = mode === 'decode' ? turn.decodeTps : turn.e2eTps;
        const color = cacheToneColor(turn.cacheRate);

        const kindBadge =
          turn.kind === 'tool'
            ? `<span class="turn-badge mono">Tool×${turn.tools}</span>`
            : `<span class="turn-badge reply mono">Reply</span>`;
        const shortTip = t('badgeShortSampleTip', {
          sec: fmtSec(turn.decodeSec),
          tok: turn.totalOutput,
        });
        const shortBadge = isShortInDecode
          ? `<span class="turn-badge burst mono" title="${esc(shortTip)}">${esc(t('badgeShortSample'))}</span>`
          : '';

        return `
          <div class="turn-card">
            <button type="button" class="turn-row" data-turn-id="${turn.id}" aria-expanded="${isOpen}">
              <div class="turn-row-top">
                <div class="turn-meta">
                  <span class="turn-id mono">#${turn.id}</span>
                  ${kindBadge}
                  ${shortBadge}
                  <span class="muted mono">${esc(fmtClock(turn.timestampMs))}</span>
                </div>
                <div class="turn-nums mono">
                  <span class="${isShortInDecode ? 'muted' : 'strong'}">${
                    isShortInDecode ? `${fmtTps(turn.e2eTps)} e2e` : `${fmtTps(shownTps)} t/s`
                  }</span>
                  <span style="color: ${color};">${turn.cacheRate.toFixed(0)}%</span>
                </div>
              </div>
              <div class="turn-bar">
                <div class="turn-bar-fill" style="width: ${Math.max(3, turn.cacheRate)}%; background: ${color};"></div>
              </div>
            </button>
            ${
              isOpen
                ? `
                <div class="turn-details mono">
                  <div class="detail-kv"><span class="muted">${esc(t('detailDecodeTps'))}</span><span>${
                    turn.isShortSample
                      ? esc(t('detailShortSampleVal', { tps: fmtTps(turn.rawDecodeTps) }))
                      : `${fmtTps(turn.decodeTps)} t/s`
                  }</span></div>
                  <div class="detail-kv"><span class="muted">${esc(t('detailE2eTps'))}</span><span>${fmtTps(turn.e2eTps)} t/s</span></div>
                  <div class="detail-kv"><span class="muted">${esc(t('detailTtft'))}</span><span>${fmtSec(turn.ttftSec)}</span></div>
                  <div class="detail-kv"><span class="muted">${esc(t('detailDecodeDur'))}</span><span>${fmtSec(turn.decodeSec)}</span></div>
                  <div class="detail-kv"><span class="muted">${esc(t('detailCacheRead'))}</span><span>${fmtNum(turn.cacheReadTokens)}</span></div>
                  <div class="detail-kv"><span class="muted">${esc(t('detailUncachedIn'))}</span><span>${fmtNum(turn.inputTokens)}</span></div>
                  ${
                    turn.cacheCreationTokens > 0
                      ? `<div class="detail-kv"><span class="muted">${esc(t('detailCacheWrite'))}</span><span>${fmtNum(turn.cacheCreationTokens)}</span></div><div class="detail-kv"><span class="muted">${esc(t('detailContextTotal'))}</span><span>${fmtNum(turn.contextUsed)}</span></div>`
                      : ''
                  }
                  <div class="detail-kv"><span class="muted">${esc(t('detailThinking'))}</span><span>${fmtNum(turn.thinkingTokens)}</span></div>
                  <div class="detail-kv"><span class="muted">${esc(t('detailReplyTool'))}</span><span>${fmtNum(turn.responseTokens)}</span></div>
                </div>
              `
                : ''
            }
          </div>
        `;
      })
      .join('');

    container.querySelectorAll('.turn-row').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.turnId);
        state.expandedTurnId = state.expandedTurnId === id ? null : id;
        render();
      });
    });
  }

  function renderBreakdown(data, limit) {
    const bd = data.breakdown;
    const s = data.summary;
    const cats = (bd?.categories || []).map((c) => ({ ...c, ...localizeCategory(c) }));

    $('breakdownModeTag').textContent = bd?.mode === 'exact_snapshot' ? t('modeExact') : t('modeFallback');

    const cells = [];
    for (const c of cats) {
      const pct = limit > 0 ? (c.tokens / limit) * 100 : 0;
      const count = c.tokens > 0 ? Math.max(1, Math.round(pct)) : 0;
      for (let i = 0; i < count && cells.length < 100; i++) {
        cells.push({
          color: c.colorVar,
          label: `${c.label}: ${fmtNum(c.tokens)} (${pct.toFixed(1)}%)`,
        });
      }
    }
    const usedCells = Math.min(100, cells.length);
    const freeTokens = Math.max(0, limit - s.latestContextUsed);
    while (cells.length < 100) {
      cells.push({
        color: 'var(--v-secondary)',
        label: t('gridFreeLabel', { tok: fmtNum(freeTokens), pct: 100 - usedCells }),
      });
    }

    const grid = $('ctxGrid');
    grid.innerHTML = cells
      .map(
        (c, i) =>
          `<div class="ctx-cell" data-cell="${i}" style="background: ${c.color};" title="${esc(c.label)}"></div>`
      )
      .join('');

    $('gridUsedPct').textContent = `${usedCells}%`;
    $('gridFreePct').textContent = `${100 - usedCells}%`;
    $('gridHoverText').textContent = t('gridHoverHint');

    grid.querySelectorAll('.ctx-cell').forEach((el) => {
      el.addEventListener('mouseenter', () => {
        const cell = cells[Number(el.dataset.cell)];
        if (cell) $('gridHoverText').textContent = cell.label;
      });
    });

    $('categoryRows').innerHTML = cats
      .map((c) => {
        const pct = limit > 0 ? (c.tokens / limit) * 100 : 0;
        return `
          <div class="cat-item">
            <div class="cat-head">
              <span class="cat-name truncate">
                <span class="swatch" style="background: ${c.colorVar};"></span>
                <span>${esc(c.label)}</span>
                <span class="cat-sub">${esc(c.detail)}</span>
              </span>
              <span class="mono muted">
                <strong class="strong">${fmtNum(c.tokens)}</strong> (${pct.toFixed(1)}%)
              </span>
            </div>
            <div class="bar-track">
              <div class="bar-fill" style="width: ${Math.min(100, pct).toFixed(1)}%; background: ${c.colorVar};"></div>
            </div>
          </div>
        `;
      })
      .join('');

    $('warmCountLabel').textContent = `(${s.warmCount})`;
    $('coldCountLabel').textContent = `(${s.coldCount})`;
    $('warmTtftVal').textContent = fmtSec(s.avgWarmTtft);
    $('coldTtftVal').textContent = fmtSec(s.avgColdTtft);

    const badge = $('speedupBadge');
    if (s.ttftSpeedup != null) {
      if (s.ttftSpeedup >= 1) {
        badge.textContent = t('speedupFast', { x: s.ttftSpeedup.toFixed(1) });
        badge.style.color = 'var(--v-success)';
      } else {
        badge.textContent = t('speedupRatio', { x: s.ttftSpeedup.toFixed(2) });
        badge.style.color = 'var(--v-muted)';
      }
    } else if (s.warmCount > 0 && s.coldCount === 0) {
      badge.textContent = t('speedupAllWarm');
      badge.style.color = 'var(--v-success)';
    } else if (s.coldCount > 0 && s.warmCount === 0) {
      badge.textContent = t('speedupAllCold');
      badge.style.color = 'var(--v-warning)';
    } else {
      badge.textContent = t('speedupNone');
      badge.style.color = 'var(--v-muted)';
    }

    const maxBar = Math.max(s.avgWarmTtft || 0, s.avgColdTtft || 0, 0.5);
    $('warmTtftBar').style.width =
      s.avgWarmTtft != null ? `${Math.max(6, (s.avgWarmTtft / maxBar) * 100).toFixed(1)}%` : '0%';
    $('coldTtftBar').style.width =
      s.avgColdTtft != null ? `${Math.max(6, (s.avgColdTtft / maxBar) * 100).toFixed(1)}%` : '0%';
  }

  // ---------- Tab & Control Events ----------
  function selectTab(tab) {
    state.activeTab = tab;
    document.querySelectorAll('.tab').forEach((btn) => {
      const on = btn.dataset.tab === tab;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('hidden', panel.id !== `panel-${tab}`);
    });
  }

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => selectTab(btn.dataset.tab));
  });

  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    const order = ['overview', 'turns', 'breakdown'];
    const i = order.indexOf(state.activeTab);
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      selectTab(order[(i + 1) % order.length]);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      selectTab(order[(i - 1 + order.length) % order.length]);
    }
  });

  $('alertCloseBtn').addEventListener('click', () => {
    if (state.currentAlertKey) {
      state.dismissedAlerts.add(state.currentAlertKey);
    }
    $('alertBanner').className = 'alert-banner hidden';
  });

  $('langToggleBtn').addEventListener('click', () => {
    if (!i18n) return;
    const next = i18n.getLocale() === 'zh' ? 'en' : 'zh';
    i18n.setLocale(next, true);
    i18n.applyStaticI18n(document);
    render();
  });

  $('tpsModeBtn').addEventListener('click', () => {
    if (state.data?.tpsPrecision !== 'decode') return;
    state.tpsMode = state.tpsMode === 'decode' ? 'e2e' : 'decode';
    state.tpsModeUserPinned = true;
    render();
  });

  $('limitCycleBtn').addEventListener('click', () => {
    state.limitPresetIdx = (state.limitPresetIdx + 1) % LIMIT_PRESETS.length;
    render();
  });

  document.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.chartMode = btn.dataset.chart;
      document.querySelectorAll('.seg-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.chart === state.chartMode);
      });
      render();
    });
  });

  document.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.turnFilter = btn.dataset.filter;
      document.querySelectorAll('.filter-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.filter === state.turnFilter);
      });
      render();
    });
  });

  $('jumpTurnsBtn').addEventListener('click', () => {
    const turns = state.data?.turns || [];
    if (turns.length) state.expandedTurnId = turns[turns.length - 1].id;
    selectTab('turns');
    render();
  });

  // ---------- Polling Loop (auto-pauses when hidden) ----------
  async function poll() {
    if (!state.visible || state.pollInFlight) return;
    state.pollInFlight = true;
    let delay = IDLE_POLL_MS;
    try {
      const conv = currentConv();
      if (conv !== state.conv) {
        state.conv = conv;
        state.etag = '';
        state.data = null;
        state.renderedHistoryRev = '';
        state.renderedToolsRev = '';
        state.expandedTurnId = null;
        state.limitPresetIdx = 0;
      }

      const q = new URLSearchParams();
      if (conv) q.set('conversationId', conv);
      if (state.etag) q.set('etag', state.etag);

      const res = await fetchJson(`/api/vitals?${q.toString()}`);
      const wasStale = state.stale;
      state.lastOk = Date.now();
      state.stale = false;

      if (res.serverNowMs) {
        state.clockOffsetMs = res.serverNowMs - Date.now();
      }

      if (!res.unchanged) {
        state.etag = res.etag || '';
        const canPatchLive =
          Boolean(res.hasData) &&
          Boolean(state.data?.hasData) &&
          Boolean(res.historyRev) &&
          res.historyRev === state.renderedHistoryRev &&
          !wasStale;

        state.data = res;
        if (!state.tpsModeUserPinned && res.tpsPrecision === 'decode') {
          state.tpsMode = 'decode';
        }

        if (canPatchLive) {
          renderLivePatch(res);
        } else {
          render();
        }
      } else if (wasStale) {
        render();
      }

      const act = state.data?.activity;
      if (!state.data?.hasData && !isActiveState(act)) delay = EMPTY_POLL_MS;
      else if (isActiveState(act)) delay = ACTIVE_POLL_MS;
      else delay = IDLE_POLL_MS;
    } catch (err) {
      console.warn('[vitals] poll failed:', err);
      state.stale = Date.now() - state.lastOk > IDLE_POLL_MS * 4;
      render();
      delay = EMPTY_POLL_MS;
    } finally {
      state.pollInFlight = false;
      syncLiveClock();
      schedulePoll(delay);
    }
  }

  if (i18n) i18n.applyStaticI18n(document);
  state.visible = isPaneVisible();
  render();
  if (state.visible) {
    poll();
  }
})();
