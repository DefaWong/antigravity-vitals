/*
 * Antigravity Vitals — Auxiliary Pane Frontend.
 *
 * Follows the active conversation via `window.sidecar.conversationId` (or
 * `?conversationId=` in standalone preview), polls `/api/vitals` with ETag
 * short-circuiting, and mirrors host light/dark theme tokens injected by
 * `/preload.js`.
 */
(() => {
  const ACTIVE_POLL_MS = 1200;
  const IDLE_POLL_MS = 2000;
  const EMPTY_POLL_MS = 2500;
  const LIMIT_PRESETS = [0, 200000, 256000, 512000, 1000000]; // 0 = auto-detected

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  const state = {
    conv: null,
    etag: '',
    data: null,
    lastOk: 0,
    stale: false,
    activeTab: 'overview',
    chartMode: 'tps', // 'tps' | 'cache'
    tpsMode: 'decode', // 'decode' | 'e2e'
    tpsModeUserPinned: false,
    limitPresetIdx: 0, // 0 => auto detected
    turnFilter: 'all',
    expandedTurnId: null,
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

  // ---------- Formatting Helpers ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

  // ---------- Rendering ----------
  function render() {
    const data = state.data;
    const conv = state.conv || data?.conversationId || '';
    $('footerConv').textContent = conv ? `conv: ${conv.slice(0, 8)}…` : 'conv: --';

    if (!data || !data.hasData || !data.summary) {
      $('emptyState').classList.remove('hidden');
      $('content').classList.add('hidden');
      $('modelLabel').textContent = 'Vitals · 等待会话';
      $('turnsCountBadge').textContent = '0';
      $('sourceBadge').textContent = data?.source === 'transcript' ? 'JSONL' : 'SQLite';
      $('liveDot').className = `live-dot ${state.stale ? 'dot-warn' : 'dot-live'}`;
      $('emptyTitle').textContent = conv ? '等待本会话首次模型调用' : '未检测到活跃会话';
      $('emptyHintText').textContent = conv ? `监听中 (${conv.slice(0, 8)}…)` : '在左侧选择任意会话即可实时监测';
      $('footerSync').textContent = state.stale ? '重连中…' : '等待数据 · 2.5s';
      return;
    }

    $('emptyState').classList.add('hidden');
    $('content').classList.remove('hidden');

    const s = data.summary;
    const turns = data.turns || [];
    const last = turns[turns.length - 1];
    const limit = activeContextLimit(data);
    const mode = effectiveTpsMode(data);
    const isActive = data.activity === 'streaming' || data.activity === 'tool_running';

    // Header
    $('modelLabel').textContent = data.model?.display || data.model?.id || 'Unknown Model';
    $('modelLabel').title = `${data.model?.display || ''} (${data.model?.id || ''})`;
    $('turnsCountBadge').textContent = String(turns.length);

    const srcBadge = $('sourceBadge');
    srcBadge.textContent = data.source === 'sqlite' ? 'SQLite' : 'JSONL';
    srcBadge.title =
      data.source === 'sqlite'
        ? '方案 A：只读解析 conversations/<id>.db 的 gen_metadata 精确毫秒遥测'
        : '降级模式：读取 transcript.jsonl（Token 与缓存精确，TPS 为端到端估算）';

    const tpsBtn = $('tpsModeBtn');
    tpsBtn.textContent = mode === 'decode' ? 'Decode' : 'E2E';
    tpsBtn.disabled = data.tpsPrecision !== 'decode';
    tpsBtn.title =
      data.tpsPrecision === 'decode'
        ? '点击切换纯解码 TPS (Decode) 与端到端 TPS (E2E)'
        : '当前处于 JSONL 降级模式，仅提供端到端 (E2E) 口径';

    // Live dot + footer sync
    const liveDot = $('liveDot');
    if (state.stale) {
      liveDot.className = 'live-dot dot-warn';
      $('footerSync').textContent = '连接中断 · 重试中…';
    } else if (data.activity === 'streaming') {
      liveDot.className = 'live-dot dot-live';
      $('footerSync').textContent = '模型生成中 · 1.2s';
    } else if (data.activity === 'tool_running') {
      liveDot.className = 'live-dot dot-live';
      $('footerSync').textContent = '工具执行中 · 1.2s';
    } else if (data.alert?.level === 'error') {
      liveDot.className = 'live-dot dot-err';
      $('footerSync').textContent = '同步正常 · 2.0s';
    } else if (data.alert?.level === 'warning') {
      liveDot.className = 'live-dot dot-warn';
      $('footerSync').textContent = '同步正常 · 2.0s';
    } else {
      liveDot.className = 'live-dot dot-ok';
      $('footerSync').textContent = '同步正常 · 2.0s';
    }

    // Re-evaluate context alert if user overrode limit manually
    const ctxPct = limit > 0 ? (s.latestContextUsed / limit) * 100 : 0;
    let alertObj = data.alert;
    if (!alertObj && ctxPct >= 80) {
      alertObj = {
        level: ctxPct >= 92 ? 'error' : 'warning',
        title: `上下文窗口接近上限（${ctxPct.toFixed(1)}%）`,
        desc: `当前占用 ${s.latestContextUsed.toLocaleString()} / ${limit.toLocaleString()} tokens。建议使用 /compact 压缩历史上下文。`,
      };
    }

    const alertEl = $('alertBanner');
    if (alertObj) {
      alertEl.className = `alert-banner level-${alertObj.level === 'error' ? 'error' : 'warning'}`;
      $('alertTitle').textContent = alertObj.title;
      $('alertDesc').textContent = alertObj.desc;
    } else {
      alertEl.className = 'alert-banner hidden';
    }

    // KPI 1: TPS & TTFT
    $('tpsTitle').textContent = mode === 'decode' ? '纯解码 TPS' : '端到端 TPS';
    const mainTps = mode === 'decode' ? s.headlineDecodeTps : s.latestE2eTps;
    const avgTps = mode === 'decode' ? s.avgDecodeTps : s.avgE2eTps;
    $('kpiTps').textContent = fmtTps(mainTps);
    $('kpiTtft').textContent = fmtSec(s.latestTtftSec);
    $('kpiAvgTps').textContent = fmtTps(avgTps);

    const tpsTag = $('tpsStateTag');
    if (isActive) {
      tpsTag.textContent = data.activity === 'streaming' ? '生成中' : '工具中';
      tpsTag.className = 'mono tag-live';
    } else if (mode === 'decode' && s.headlineDecodeIsFallback) {
      tpsTag.textContent = '上轮稳态';
      tpsTag.className = 'mono muted';
    } else if (last.cacheRate < 20) {
      tpsTag.textContent = '冷预填充';
      tpsTag.className = 'mono tag-warn';
    } else {
      tpsTag.textContent = '暖缓存';
      tpsTag.className = 'mono tag-ok';
    }

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
    cacheTrend.textContent = `本轮 ${s.latestCacheRate.toFixed(1)}%`;
    cacheTrend.style.color = cacheToneColor(s.latestCacheRate);
    $('kpiCacheSaved').textContent = fmtNum(s.totalCacheRead);
    $('kpiCacheCold').textContent = `冷启 ${s.coldCount}`;

    // KPI 3: Context Utilization
    const limitBtn = $('limitCycleBtn');
    const isAutoLimit = state.limitPresetIdx === 0;
    limitBtn.textContent = isAutoLimit ? fmtLimit(limit) : `${fmtLimit(limit)}*`;

    const kpiCtxPct = $('kpiCtxPct');
    kpiCtxPct.textContent = `${Math.min(100, ctxPct).toFixed(1)}%`;
    kpiCtxPct.style.color =
      ctxPct >= 80 ? 'var(--v-error)' : ctxPct >= 65 ? 'var(--v-warning)' : 'var(--v-fg)';
    $('kpiCtxUsed').textContent = `${fmtNum(s.latestContextUsed)} 已用`;
    $('kpiCtxLeft').textContent = `余 ${fmtNum(Math.max(0, limit - s.latestContextUsed))}`;

    // KPI 4: Session Tokens
    $('kpiCalls').textContent = `${s.turnCount} 次`;
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

    // Latest Turn Strip
    const durStr = last.e2eSec != null ? `耗时 ${last.e2eSec.toFixed(1)}s` : '无耗时';
    $('lastTurnMeta').textContent = `#${last.id} · 输出 ${fmtNum(last.totalOutput)} tok · ${durStr}`;

    renderTrendChart(turns, mode);
    renderTurnsList(turns, mode);
    renderBreakdown(data, limit);
  }

  function renderTrendChart(turns, mode) {
    const wrap = $('svgChartWrap');
    const recent = turns.slice(-12);
    $('chartTitle').textContent = recent.length < 12 ? `最近 ${recent.length} 轮趋势` : '最近 12 轮趋势';
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
      const getVal = (t) => {
        if (mode === 'decode') {
          if (t.isBufferedBurst) return t.e2eTps || 0;
          return t.decodeTps || 0;
        }
        return t.e2eTps || 0;
      };
      const vals = recent.map(getVal);
      const maxTps = Math.max(80, ...vals) * 1.12;
      const maxTtft = Math.max(4, ...recent.map((t) => t.ttftSec || 0));
      const stepX = n > 1 ? innerW / (n - 1) : 0;

      const formatInsp = (t) => {
        const v = getVal(t);
        const burstNote = mode === 'decode' && t.isBufferedBurst ? ' (E2E)' : '';
        return `#${t.id} · ${v > 0 ? v.toFixed(1) : '--'} t/s${burstNote} · TTFT ${fmtSec(t.ttftSec)}`;
      };
      insp.textContent = formatInsp(latest);

      const points = recent.map((t, i) => {
        const cx = n > 1 ? padL + i * stepX : padL + innerW / 2;
        const v = getVal(t);
        const cy = padT + innerH - (v / maxTps) * innerH;
        const barH = t.ttftSec != null ? Math.max(3, (t.ttftSec / maxTtft) * (innerH * 0.65)) : 0;
        return { cx, cy, barH, t };
      });

      const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.cx.toFixed(1)},${p.cy.toFixed(1)}`).join(' ');
      const areaD =
        n > 1
          ? `${pathD} L${points[n - 1].cx.toFixed(1)},${padT + innerH} L${points[0].cx.toFixed(1)},${padT + innerH} Z`
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
                    (p.t.ttftSec || 0) > 6 ? 'var(--v-warning)' : 'var(--v-chart-3)'
                  }" opacity="0.28" />`
                : ''
            )
            .join('')}
          ${areaD ? `<path d="${areaD}" fill="var(--v-chart-1)" opacity="0.11" />` : ''}
          ${n > 1 ? `<path d="${pathD}" fill="none" stroke="var(--v-chart-1)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />` : ''}
          ${points
            .map(
              (p, idx) => `
              <g class="chart-pt" data-idx="${idx}" style="cursor:pointer;">
                <circle cx="${p.cx.toFixed(1)}" cy="${p.cy.toFixed(1)}" r="10" fill="transparent" />
                <circle cx="${p.cx.toFixed(1)}" cy="${p.cy.toFixed(1)}" r="3.2" fill="var(--v-card)" stroke="${
                  p.t.isBufferedBurst && mode === 'decode' ? 'var(--v-warning)' : 'var(--v-chart-1)'
                }" stroke-width="2" />
                ${
                  idx === 0 || idx === n - 1 || idx % 3 === 0
                    ? `<text x="${p.cx.toFixed(1)}" y="${H - 3}" text-anchor="middle" fill="var(--v-muted)" font-size="9" font-family="monospace">#${p.t.id}</text>`
                    : ''
                }
              </g>
            `
            )
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
      const formatInsp = (t) => `#${t.id} · 命中 ${t.cacheRate.toFixed(1)}% · 读 ${fmtNum(t.cacheReadTokens)}`;
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
            .map((t, idx) => {
              const cx = padL + idx * barSlot + barSlot / 2;
              const bh = Math.max(4, (t.cacheRate / 100) * innerH);
              const color = cacheToneColor(t.cacheRate);
              return `
                <g class="chart-bar" data-idx="${idx}" style="cursor:pointer;">
                  <rect x="${(cx - barSlot / 2).toFixed(1)}" y="${padT}" width="${barSlot.toFixed(1)}" height="${innerH}" fill="transparent" />
                  <rect x="${(cx - barW / 2).toFixed(1)}" y="${(padT + innerH - bh).toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="3" fill="${color}" opacity="0.88" />
                  ${
                    idx === 0 || idx === n - 1 || idx % 3 === 0
                      ? `<text x="${cx.toFixed(1)}" y="${H - 3}" text-anchor="middle" fill="var(--v-muted)" font-size="9" font-family="monospace">#${t.id}</text>`
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
    const filtered = [...turns].reverse().filter((t) => {
      if (state.turnFilter === 'cold') return t.cacheRate < 40;
      if (state.turnFilter === 'tool') return t.kind === 'tool';
      return true;
    });

    if (!filtered.length) {
      container.innerHTML = `<div class="card empty-filter">当前筛选条件下无匹配轮次</div>`;
      return;
    }

    container.innerHTML = filtered
      .map((t) => {
        const isOpen = state.expandedTurnId === t.id;
        const shownTps = mode === 'decode' ? (t.isBufferedBurst ? t.e2eTps : t.decodeTps) : t.e2eTps;
        const color = cacheToneColor(t.cacheRate);

        const kindBadge =
          t.kind === 'tool'
            ? `<span class="turn-badge mono">Tool×${t.tools}</span>`
            : `<span class="turn-badge reply mono">Reply</span>`;
        const burstBadge =
          mode === 'decode' && t.isBufferedBurst
            ? `<span class="turn-badge burst mono" title="单包缓冲工具调用（${fmtSec(t.decodeSec)}），此处显示端到端 TPS">短包</span>`
            : '';

        return `
          <div class="turn-card">
            <button type="button" class="turn-row" data-turn-id="${t.id}" aria-expanded="${isOpen}">
              <div class="turn-row-top">
                <div class="turn-meta">
                  <span class="turn-id mono">#${t.id}</span>
                  ${kindBadge}
                  ${burstBadge}
                  <span class="muted mono">${esc(fmtClock(t.timestampMs))}</span>
                </div>
                <div class="turn-nums mono">
                  <span class="strong">${fmtTps(shownTps)} t/s</span>
                  <span style="color: ${color};">${t.cacheRate.toFixed(0)}%</span>
                </div>
              </div>
              <div class="turn-bar">
                <div class="turn-bar-fill" style="width: ${Math.max(3, t.cacheRate)}%; background: ${color};"></div>
              </div>
            </button>
            ${
              isOpen
                ? `
                <div class="turn-details mono">
                  <div class="detail-kv"><span class="muted">纯解码 TPS</span><span>${t.isBufferedBurst ? `${fmtTps(t.decodeTps)} (短包)` : `${fmtTps(t.decodeTps)} t/s`}</span></div>
                  <div class="detail-kv"><span class="muted">端到端 TPS</span><span>${fmtTps(t.e2eTps)} t/s</span></div>
                  <div class="detail-kv"><span class="muted">首字 TTFT</span><span>${fmtSec(t.ttftSec)}</span></div>
                  <div class="detail-kv"><span class="muted">解码耗时</span><span>${fmtSec(t.decodeSec)}</span></div>
                  <div class="detail-kv"><span class="muted">缓存读取</span><span>${fmtNum(t.cacheReadTokens)}</span></div>
                  <div class="detail-kv"><span class="muted">新增输入</span><span>${fmtNum(t.inputTokens)}</span></div>
                  ${
                    t.cacheCreationTokens > 0
                      ? `<div class="detail-kv"><span class="muted">缓存写入</span><span>${fmtNum(t.cacheCreationTokens)}</span></div><div class="detail-kv"><span class="muted">上下文合计</span><span>${fmtNum(t.contextUsed)}</span></div>`
                      : ''
                  }
                  <div class="detail-kv"><span class="muted">Thinking</span><span>${fmtNum(t.thinkingTokens)}</span></div>
                  <div class="detail-kv"><span class="muted">Reply / Tool</span><span>${fmtNum(t.responseTokens)}</span></div>
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
    const cats = bd?.categories || [];

    $('breakdownModeTag').textContent = bd?.mode === 'exact_snapshot' ? 'SQLite 实测' : 'JSONL 概算';

    // Build 100-cell matrix (1 cell = 1% of window)
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
        label: `剩余可用空间: ${fmtNum(freeTokens)} (${(100 - usedCells)}%)`,
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
    $('gridHoverText').textContent = '悬停格子查看成分';

    grid.querySelectorAll('.ctx-cell').forEach((el) => {
      el.addEventListener('mouseenter', () => {
        const cell = cells[Number(el.dataset.cell)];
        if (cell) $('gridHoverText').textContent = cell.label;
      });
    });

    // Category rows
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

    // Warm vs Cold TTFT Comparison
    $('warmCountLabel').textContent = `(${s.warmCount})`;
    $('coldCountLabel').textContent = `(${s.coldCount})`;
    $('warmTtftVal').textContent = fmtSec(s.avgWarmTtft);
    $('coldTtftVal').textContent = fmtSec(s.avgColdTtft);

    const badge = $('speedupBadge');
    if (s.ttftSpeedup != null) {
      if (s.ttftSpeedup >= 1) {
        badge.textContent = `${s.ttftSpeedup.toFixed(1)}× 加速`;
        badge.style.color = 'var(--v-success)';
      } else {
        badge.textContent = `${s.ttftSpeedup.toFixed(2)}× 比率`;
        badge.style.color = 'var(--v-muted)';
      }
    } else if (s.warmCount > 0 && s.coldCount === 0) {
      badge.textContent = '全暖缓存';
      badge.style.color = 'var(--v-success)';
    } else if (s.coldCount > 0 && s.warmCount === 0) {
      badge.textContent = '仅冷预填充';
      badge.style.color = 'var(--v-warning)';
    } else {
      badge.textContent = '暂无 TTFT';
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

  // ---------- Polling Loop ----------
  async function poll() {
    let delay = IDLE_POLL_MS;
    try {
      const conv = currentConv();
      if (conv !== state.conv) {
        state.conv = conv;
        state.etag = '';
        state.data = null;
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

      if (!res.unchanged) {
        state.etag = res.etag || '';
        state.data = res;
        if (!state.tpsModeUserPinned && res.tpsPrecision === 'decode') {
          state.tpsMode = 'decode';
        }
        render();
      } else if (wasStale) {
        render();
      }

      const act = state.data?.activity;
      if (!state.data?.hasData) delay = EMPTY_POLL_MS;
      else if (act === 'streaming' || act === 'tool_running') delay = ACTIVE_POLL_MS;
      else delay = IDLE_POLL_MS;
    } catch (err) {
      console.warn('[vitals] poll failed:', err);
      state.stale = Date.now() - state.lastOk > IDLE_POLL_MS * 3;
      render();
      delay = EMPTY_POLL_MS;
    } finally {
      setTimeout(poll, delay);
    }
  }

  render();
  poll();
})();
