/*
 * Bilingual i18n (zh / en) for Antigravity Vitals.
 *
 * Auto-detects language from environment (`?lang=` -> saved preference ->
 * `window.sidecar.locale/language` -> `navigator.languages` -> `Intl` locale)
 * and supports instant live switching without reload.
 */
(function (root) {
  const STORAGE_KEY = 'vitals.lang';

  const MESSAGES = {
    zh: {
      // Header & Tabs
      waitingSessionShort: 'Vitals · 等待会话',
      waitingData: '等待会话数据…',
      navAria: '遥测视图',
      tabOverview: '总览',
      tabTurns: '轮次',
      tabBreakdown: '上下文拆解',
      sourceTitleSqlite: '方案 A：只读解析 conversations/<id>.db 的 gen_metadata 精确毫秒遥测',
      sourceTitleJsonl: '降级模式：读取 transcript.jsonl（Token 与缓存精确，TPS 为端到端估算）',
      tpsBtnTitleDecode: '点击切换纯解码 TPS (Decode) 与端到端 TPS (E2E)',
      tpsBtnTitleFallback: '当前处于 JSONL 降级模式，仅提供端到端 (E2E) 口径',
      dismissAlert: '关闭提示',

      // Empty State
      emptyTitleStreaming: '首轮模型正在生成中…',
      emptyTitleWaiting: '等待本会话首次模型调用',
      emptyTitleNoConv: '未检测到活跃会话',
      emptyDesc: '发起对话后将自动读取本地 SQLite gen_metadata，实时展示纯解码 TPS、TTFT、缓存命中率与上下文拆解。',
      emptyHintWatching: '监听中 ({id}…)',
      emptyHintSelect: '在左侧选择任意会话即可实时监测',

      // KPIs
      kpiDecodeTps: '纯解码 TPS',
      kpiE2eTps: '端到端 TPS',
      kpiAvgPrefix: '均',
      kpiCacheHit: '缓存命中率',
      kpiTurnCache: '本轮 {pct}%',
      kpiCacheSaved: '已命中',
      kpiColdCount: '冷启 {n}',
      kpiContext: '上下文利用',
      kpiLimitTitle: '点击切换上下文窗口上限（自动检测 / 200k / 256k / 512k / 1M）',
      kpiCtxUsed: '{n} 已用',
      kpiCtxLeft: '余 {n}',
      kpiSessionTokens: '会话 Tokens',
      kpiCallsCount: '{n} 次',
      kpiTokensIn: '入',
      kpiTokensOut: '出',

      // TPS State Tags
      stateWaitingTtft: '等待首字',
      stateStreamingLive: '流式实时',
      stateStreaming: '生成中',
      stateToolRunning: '工具中',
      statePrevSteady: '上轮稳态',
      stateColdPrefill: '冷预填充',
      stateWarmCache: '暖缓存',

      // Window Composition
      windowComposition: '当前窗口构成',
      thresholdTitle: '80% 建议压缩线',
      legCache: '缓存 Prompt',
      legUncached: '新增 Input',
      legThinking: 'Thinking',
      legReply: 'Reply & Tools',

      // Trend Chart
      chartTitleRecent: '最近 {n} 轮趋势',
      chartTabCache: '缓存命中',
      inspectorLabel: '单轮详情',
      inspShortSample: '#{id} · 短采样 {sec}/{tok}t · TTFT {ttft}',
      inspTps: '#{id} · {tps} t/s · TTFT {ttft}',
      inspCache: '#{id} · 命中 {rate}% · 读 {read}',

      // Tool Hotspots
      toolsTitle: '工具调用热点',
      toolsEmpty: '本会话尚未调用工具',
      toolsCallsUnit: '{n} 次',
      toolsErrorsUnit: '{n} 错',
      toolsRunning: '运行中',

      // Latest Turn Strip
      stripRequesting: '请求中',
      stripWaitingTtft: '等待首字 · 已耗时 {sec}s',
      stripGenerating: '生成中',
      stripStreamingMeta: '~{tok} tok · 解码 {sec}s',
      stripLatest: '最近调用',
      stripLatestMeta: '#{id} · 输出 {tok} tok · {dur}',
      stripDur: '耗时 {sec}s',
      stripNoDur: '无耗时',
      stripDetailsLink: '明细 →',

      // Turns Ledger
      filterAll: '全部',
      filterCold: '缓存异常',
      filterTool: '工具调用',
      turnsExpandHint: '点击展开明细',
      turnsEmptyFilter: '当前筛选条件下无匹配轮次',
      badgeShortSample: '短采样',
      badgeShortSampleTip: '流式解码仅 {sec}（{tok} tok），首包缓冲导致纯解码速率偏高，已过滤以免失真',
      detailDecodeTps: '纯解码 TPS',
      detailShortSampleVal: '短采样 ({tps})',
      detailE2eTps: '端到端 TPS',
      detailTtft: '首字 TTFT',
      detailDecodeDur: '解码耗时',
      detailCacheRead: '缓存读取',
      detailUncachedIn: '新增输入',
      detailCacheWrite: '缓存写入',
      detailContextTotal: '上下文合计',
      detailThinking: 'Thinking',
      detailReplyTool: 'Reply / Tool',

      // Breakdown Tab
      gridTitle: '100 格上下文占比图',
      gridLegend: '1 格 = 1%',
      gridHoverHint: '悬停格子查看成分',
      gridUsed: '已用',
      gridFree: '余',
      gridFreeLabel: '剩余可用空间: {tok} ({pct}%)',
      catSectionTitle: 'Token 成分明细',
      modeExact: 'SQLite 实测',
      modeFallback: 'JSONL 概算',
      cat_tool_outputs: '工具输出与文件读取',
      cat_system_prompt: '系统提示词 / Skills / Rules',
      cat_assistant: '历史回复与 Thinking',
      cat_tool_defs: '工具与 MCP 定义',
      cat_user: '用户输入消息',
      cat_cache_read: '缓存命中 Prompt',
      cat_uncached_input: '新增 Input Tokens',
      cat_output: '模型输出与工具调用',
      detail_tool_outputs: '{n} 条结果',
      detail_system_prompt: '{n} 个区块',
      detail_system_prompt_fallback: '系统指令',
      detail_assistant: '{n} 轮生成',
      detail_tool_defs: '{n} 个工具',
      detail_user: '{n} 条消息',
      detail_cache_read: '前缀复用',
      detail_uncached_input: '本轮增量',
      detail_output: '本轮输出',

      // TTFT Comparison
      ttftCompareTitle: '缓存对 TTFT 加速效果',
      ttftWarmLabel: '缓存命中均值',
      ttftColdLabel: '冷预填充均值',
      speedupFast: '{x}× 加速',
      speedupRatio: '{x}× 比率',
      speedupAllWarm: '全暖缓存',
      speedupAllCold: '仅冷预填充',
      speedupNone: '暂无 TTFT',

      // Alerts
      alertCacheDropTitle: 'Prompt 缓存失效（本轮命中率 {rate}%）',
      alertCacheDropDesc: '第 #{id} 轮触发冷预填充（{tokens} tokens）{ttftPart}。通常由模型切换、规则/MCP 变更或缓存过期引起。',
      alertCacheDropTtft: '，TTFT 升至 {cur}s（均 {warm}）',
      alertWarmDefault: '暖缓存',
      alertCtxHighTitle: '上下文窗口接近上限（{pct}%）',
      alertCtxHighDesc: '当前占用 {used} / {limit} tokens。建议使用 /compact 压缩历史上下文以保持响应速度。',

      // Footer
      syncInit: '初始化…',
      syncReconnecting: '重连中…',
      syncDisconnected: '连接中断 · 重试中…',
      syncWaitingData: '等待数据 · 1.5s',
      syncWaitingTtft: '等待首字 · 0.35s',
      syncStreaming: '流式采样 · 0.35s',
      syncToolRunning: '工具运行 · 0.35s',
      syncLiveIdle: '实时监测 · 0.9s',
      langLabel: '中文',
      langSwitchTitle: '点击切换界面语言（默认自动跟随系统环境）',
    },

    en: {
      // Header & Tabs
      waitingSessionShort: 'Vitals · Waiting',
      waitingData: 'Waiting for session…',
      navAria: 'Telemetry views',
      tabOverview: 'Overview',
      tabTurns: 'Turns',
      tabBreakdown: 'Breakdown',
      sourceTitleSqlite: 'Option A: read-only local conversations/<id>.db gen_metadata millisecond telemetry',
      sourceTitleJsonl: 'Fallback mode: reading transcript.jsonl (exact tokens & cache, E2E TPS)',
      tpsBtnTitleDecode: 'Toggle Pure Decode TPS vs. End-to-End (E2E) TPS',
      tpsBtnTitleFallback: 'JSONL fallback mode: E2E throughput only',
      dismissAlert: 'Dismiss alert',

      // Empty State
      emptyTitleStreaming: 'Generating first turn…',
      emptyTitleWaiting: 'Waiting for first model turn',
      emptyTitleNoConv: 'No active conversation',
      emptyDesc: 'Once a turn starts, Vitals reads local SQLite gen_metadata to show live Decode TPS, TTFT, cache hit rate, and context breakdown.',
      emptyHintWatching: 'Watching ({id}…)',
      emptyHintSelect: 'Select any conversation on the left to monitor live',

      // KPIs
      kpiDecodeTps: 'Decode TPS',
      kpiE2eTps: 'E2E TPS',
      kpiAvgPrefix: 'Avg',
      kpiCacheHit: 'Cache Hit',
      kpiTurnCache: 'Turn {pct}%',
      kpiCacheSaved: 'Hits',
      kpiColdCount: 'Cold {n}',
      kpiContext: 'Context Used',
      kpiLimitTitle: 'Click to cycle context limit (Auto / 200k / 256k / 512k / 1M)',
      kpiCtxUsed: '{n} used',
      kpiCtxLeft: '{n} free',
      kpiSessionTokens: 'Session Tokens',
      kpiCallsCount: '{n} calls',
      kpiTokensIn: 'In',
      kpiTokensOut: 'Out',

      // TPS State Tags
      stateWaitingTtft: 'Waiting',
      stateStreamingLive: 'Live Est',
      stateStreaming: 'Streaming',
      stateToolRunning: 'Tooling',
      statePrevSteady: 'Last Steady',
      stateColdPrefill: 'Cold Prefill',
      stateWarmCache: 'Warm Cache',

      // Window Composition
      windowComposition: 'Context Window',
      thresholdTitle: '80% compact threshold',
      legCache: 'Cached Prompt',
      legUncached: 'New Input',
      legThinking: 'Thinking',
      legReply: 'Reply & Tools',

      // Trend Chart
      chartTitleRecent: 'Last {n} Turns',
      chartTabCache: 'Cache Hit',
      inspectorLabel: 'Turn',
      inspShortSample: '#{id} · Short {sec}/{tok}t · TTFT {ttft}',
      inspTps: '#{id} · {tps} t/s · TTFT {ttft}',
      inspCache: '#{id} · Hit {rate}% · Read {read}',

      // Tool Hotspots
      toolsTitle: 'Tool Hotspots',
      toolsEmpty: 'No tool calls in this session yet',
      toolsCallsUnit: '{n} calls',
      toolsErrorsUnit: '{n} err',
      toolsRunning: 'Running',

      // Latest Turn Strip
      stripRequesting: 'Requesting',
      stripWaitingTtft: 'Waiting for first token · {sec}s',
      stripGenerating: 'Streaming',
      stripStreamingMeta: '~{tok} tok · decode {sec}s',
      stripLatest: 'Latest',
      stripLatestMeta: '#{id} · {tok} out · {dur}',
      stripDur: '{sec}s',
      stripNoDur: 'n/a',
      stripDetailsLink: 'Ledger →',

      // Turns Ledger
      filterAll: 'All',
      filterCold: 'Low Cache',
      filterTool: 'Tools',
      turnsExpandHint: 'Click to expand',
      turnsEmptyFilter: 'No turns match this filter',
      badgeShortSample: 'Short',
      badgeShortSampleTip: 'Stream lasted only {sec} ({tok} tok); initial buffering inflates decode TPS, filtered for accuracy',
      detailDecodeTps: 'Decode TPS',
      detailShortSampleVal: 'Short ({tps})',
      detailE2eTps: 'E2E TPS',
      detailTtft: 'TTFT',
      detailDecodeDur: 'Decode Time',
      detailCacheRead: 'Cache Read',
      detailUncachedIn: 'New Input',
      detailCacheWrite: 'Cache Write',
      detailContextTotal: 'Context Total',
      detailThinking: 'Thinking',
      detailReplyTool: 'Reply / Tool',

      // Breakdown Tab
      gridTitle: '100-Cell Context Grid',
      gridLegend: '1 cell = 1%',
      gridHoverHint: 'Hover a cell to inspect',
      gridUsed: 'Used',
      gridFree: 'Free',
      gridFreeLabel: 'Free space: {tok} ({pct}%)',
      catSectionTitle: 'Token Breakdown',
      modeExact: 'SQLite Exact',
      modeFallback: 'JSONL Est',
      cat_tool_outputs: 'Tool Outputs & File Reads',
      cat_system_prompt: 'System Prompt / Skills / Rules',
      cat_assistant: 'Assistant Replies & Thinking',
      cat_tool_defs: 'Tool & MCP Schemas',
      cat_user: 'User Messages',
      cat_cache_read: 'Cached Prompt',
      cat_uncached_input: 'Uncached Input',
      cat_output: 'Model Output & Tool Calls',
      detail_tool_outputs: '{n} results',
      detail_system_prompt: '{n} sections',
      detail_system_prompt_fallback: 'System instructions',
      detail_assistant: '{n} turns',
      detail_tool_defs: '{n} tools',
      detail_user: '{n} msgs',
      detail_cache_read: 'Prefix reuse',
      detail_uncached_input: 'Turn delta',
      detail_output: 'Turn output',

      // TTFT Comparison
      ttftCompareTitle: 'Cache TTFT Speedup',
      ttftWarmLabel: 'Warm Cache Avg',
      ttftColdLabel: 'Cold Prefill Avg',
      speedupFast: '{x}× faster',
      speedupRatio: '{x}× ratio',
      speedupAllWarm: 'All Warm',
      speedupAllCold: 'Cold Only',
      speedupNone: 'No TTFT',

      // Alerts
      alertCacheDropTitle: 'Prompt cache miss ({rate}% hit)',
      alertCacheDropDesc: 'Turn #{id} triggered a cold prefill ({tokens} tokens){ttftPart}. Usually caused by model switch, rules/MCP changes, or cache TTL expiry.',
      alertCacheDropTtft: ', TTFT rose to {cur}s (avg {warm})',
      alertWarmDefault: 'warm',
      alertCtxHighTitle: 'Context window nearly full ({pct}%)',
      alertCtxHighDesc: 'Using {used} / {limit} tokens. Run /compact to trim history and keep responses fast.',

      // Footer
      syncInit: 'Initializing…',
      syncReconnecting: 'Reconnecting…',
      syncDisconnected: 'Disconnected · retrying…',
      syncWaitingData: 'Waiting · 1.5s',
      syncWaitingTtft: 'Waiting TTFT · 0.35s',
      syncStreaming: 'Streaming · 0.35s',
      syncToolRunning: 'Tooling · 0.35s',
      syncLiveIdle: 'Live · 0.9s',
      langLabel: 'EN',
      langSwitchTitle: 'Switch UI language (auto-follows system locale by default)',
    },
  };

  function normalizeLocale(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const lower = raw.trim().toLowerCase();
    if (lower.startsWith('zh')) return 'zh';
    if (lower.startsWith('en')) return 'en';
    return null;
  }

  function detectLocale(env) {
    const opts = env || {};
    // 1. Explicit URL param (?lang=en or ?lang=zh)
    const search = opts.search !== undefined ? opts.search : (typeof location !== 'undefined' ? location.search : '');
    if (search) {
      const param = new URLSearchParams(search).get('lang');
      const norm = normalizeLocale(param);
      if (norm) return norm;
    }

    // 2. Saved manual override in localStorage
    if (opts.stored !== undefined) {
      const norm = normalizeLocale(opts.stored);
      if (norm) return norm;
    } else if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
      try {
        const saved = window.localStorage.getItem(STORAGE_KEY);
        const norm = normalizeLocale(saved);
        if (norm) return norm;
      } catch {
        // ignore storage restrictions
      }
    }

    // 3. Host sidecar locale or browser/OS locale
    const candidates = [];
    if (opts.hostLocale) candidates.push(opts.hostLocale);
    else if (typeof window !== 'undefined' && window.sidecar) {
      if (window.sidecar.locale) candidates.push(window.sidecar.locale);
      if (window.sidecar.language) candidates.push(window.sidecar.language);
    }

    if (Array.isArray(opts.languages)) {
      candidates.push(...opts.languages);
    } else if (typeof navigator !== 'undefined') {
      if (Array.isArray(navigator.languages)) candidates.push(...navigator.languages);
      if (navigator.language) candidates.push(navigator.language);
    }

    if (opts.intlLocale) {
      candidates.push(opts.intlLocale);
    } else {
      try {
        const intl = Intl.DateTimeFormat().resolvedOptions().locale;
        if (intl) candidates.push(intl);
      } catch {
        // ignore
      }
    }

    for (const loc of candidates) {
      if (!loc || typeof loc !== 'string') continue;
      if (loc.trim().toLowerCase().startsWith('zh')) return 'zh';
      return 'en';
    }
    return 'en';
  }

  let currentLocale = detectLocale();

  function getLocale() {
    return currentLocale;
  }

  function setLocale(lang, persist = true) {
    const next = normalizeLocale(lang) || detectLocale({ stored: '' });
    currentLocale = next;
    if (typeof document !== 'undefined') {
      document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
    }
    if (persist && typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // ignore
      }
    }
    return currentLocale;
  }

  function t(key, vars) {
    const dict = MESSAGES[currentLocale] || MESSAGES.en;
    let str = dict[key] !== undefined ? dict[key] : (MESSAGES.en[key] ?? key);
    if (vars) {
      str = str.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : ''));
    }
    return str;
  }

  function applyStaticI18n(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d) return;
    d.documentElement.lang = currentLocale === 'zh' ? 'zh-CN' : 'en';
    d.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (key) el.textContent = t(key);
    });
    d.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const key = el.getAttribute('data-i18n-title');
      if (key) el.title = t(key);
    });
    d.querySelectorAll('[data-i18n-aria]').forEach((el) => {
      const key = el.getAttribute('data-i18n-aria');
      if (key) el.setAttribute('aria-label', t(key));
    });
  }

  const api = { MESSAGES, detectLocale, getLocale, setLocale, t, applyStaticI18n };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.VitalsI18n = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
