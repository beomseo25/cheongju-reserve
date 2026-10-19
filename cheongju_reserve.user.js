// ==UserScript==
// @name         청주 통합예약 - 흥덕축구공원 예약 도우미 (prototype)
// @namespace    local.cheongju.reserve
// @version      0.8
// @description  접수 시각(서버시간)에 맞춰 달의 모든 지정 요일을 날짜마다 창 1개씩 병렬로 자동 신청 (순번대기 대응)
// @match        https://ticket.cheongju.go.kr/www/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(() => {
  'use strict';
  if (window.__cjmLoaded) return; // 같은 페이지에서 두 번 실행되지 않게 (스크립트가 중복 설치된 경우 등)
  window.__cjmLoaded = true;

  /* ================= 설정 (여기만 고치세요) ================= */
  const CFG = {
    // 접수 시작 시각 (대상 사이트 서버시간 기준, 한국시간)
    //   'auto'                  = 상세 페이지의 "접수기간" 시작 시각을 읽어서 사용 (권장)
    //   ''                      = 시작 버튼 누르는 즉시 진행 (테스트용)
    //   '2026-11-19 09:00:00'   = 직접 지정
    OPEN_AT: 'auto',

    // 예약할 달: 'auto' = 상세 페이지의 "시설예약기간" 시작 달, '2026-12' 또는 '12' 처럼 직접 지정
    TARGET_MONTH: 'auto',
    WEEKDAY: 0,          // 예약할 요일: 0=일 1=월 2=화 3=수 4=목 5=금 6=토
    TARGET_DATES: [],    // 날짜를 직접 지정하려면 ['2026-12-06', '2026-12-13'] (있으면 위 월/요일 설정보다 우선)
    SKIP_DATES: [],      // 제외할 날짜 ['2026-12-27']

    // 시간대 우선순위 (앞에서부터 '예약가능'이면 선택, 최종 신청에서 뺏기면 다음 시간대로)
    SLOTS: ['06:30 ~ 08:30'],

    // 병렬 신청: 날짜마다 창 1개씩 동시에 신청 (false면 첫 날짜 하나만)
    PARALLEL: true,
    MAX_TABS: 6,         // 한 번에 열 수 있는 최대 창(=날짜) 수
    STAGGER_MS: 25,      // 창마다 이 간격(ms)씩 차례로 클릭

    // 신청자 정보
    GROUP: '단체명',
    PEOPLE: '1',
    EMAIL_ID: 'your_id',
    EMAIL_DOMAIN: 'gmail.com',

    // true: 마지막 "다음"(= 실제 예약 신청) 직전에 멈춤. 처음엔 반드시 true로 테스트하세요.
    DRY_RUN: true,

    // --- 실전 대응 ---
    CLICK_GAP_MS: 400,     // 신청하기를 다시 누를 때 최소 간격 (서버에 폭주하지 않게)
    MAX_CLICKS: 60,        // 접수 전 튕김 등으로 신청하기를 다시 누르는 최대 횟수
    QUEUE_MAX_MS: 600000,  // 순번대기(NetFUNNEL) 최대 대기 시간. 대기 중엔 절대 새로고침하지 않음
    AJAX_WAIT_MS: 15000,   // 달력/시간표 로딩 최대 대기 (서버가 느릴 때)
    WATCHDOG_MS: 15000,    // 창이 이 시간 동안 멈춰 있으면 컨트롤러가 처음부터 다시 시작 (브라우저 오류 화면은 즉시 감지)
    STALL_MS: 25000,       // 접수 후 이 시간 동안 진행이 없으면(요청이 걸려 멈춤) 다시 시작. 최종 신청 단계는 2배 기다리고 다시 신청은 안 함
    MAX_RECOVER: 6,        // 날짜별 자동 복구 최대 횟수

    // --- 서버시간 동기화 ---
    SYNC_URL: '/www/index.do',
    SYNC_MAX_MS: 12000,
    LEAD_MS: null          // null=자동(왕복시간의 절반만큼 일찍 클릭), 숫자=고정 ms
  };
  /* ========================================================= */

  const KEY = 'cjm_state';          // 창별 상태 (sessionStorage)
  const STOP_KEY = 'cjm_stop';      // 모든 창 공통 중지 신호
  const RES_PREFIX = 'cjm_res_';    // 날짜별 결과
  const HB_PREFIX = 'cjm_hb_';      // 날짜별 생존 신호
  const SYNC_KEY = 'cjm_sync';      // 서버시간 측정값 공유
  const norm = s => (s || '').replace(/\s+/g, '');
  const getState = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { return null; } };
  const setState = s => sessionStorage.setItem(KEY, JSON.stringify(s));
  const patch = o => setState({ ...(getState() || {}), ...o });
  const armed = () => {
    const s = getState();
    if (!s?.armed) return false;
    return !(Number(localStorage.getItem(STOP_KEY) || 0) > (s.startedAt || 0));
  };

  /* ---------- 문서 시작 시점: 페이지 스크립트보다 먼저 알림창/뒤로가기를 가로챔 ----------
     사이트가 alert()을 띄우면 사람이 누를 때까지 모든 게 멈추므로 기록만 하고 넘김.
     자동 신청 중인 창에서는 페이지의 history.back()도 막고 우리가 갈 곳을 직접 정함. */
  let lastAlert = null, backRequested = false, logFn = null;
  const early = [];
  window.alert = m => { lastAlert = { m: String(m), t: Date.now() }; if (logFn) logFn('알림: ' + m); else early.push('알림: ' + m); };
  window.confirm = m => { early.push('확인창: ' + m); return true; };

  // 자식 창: 주소 해시로 날짜/시각을 받아 상태 초기화 (해시는 지워서 새로고침 때 재초기화 방지)
  const initFromHash = () => {
    const hm = location.hash.match(/^#cjm=([\d-]+)&t=(\d+)&i=(\d+)&o=(\d+)(?:&r=(\d+))?/);
    if (!hm) return false;
    setState({ armed: true, role: 'child', date: hm[1], startedAt: +hm[2], idx: +hm[3], openAt: +hm[4], recover: +(hm[5] || 0),
      detailUrl: location.pathname + location.search, clicks: 0, lastClick: 0, failed: [], stage: '' });
    history.replaceState(null, '', location.pathname + location.search);
    return true;
  };
  initFromHash();
  if (armed() && getState()?.role === 'child') {
    const og = history.go.bind(history);
    history.back = () => { backRequested = true; };
    history.go = n => { if (n < 0) backRequested = true; else og(n); };
  }

  const boot = () => {
  const path = location.pathname;
  const ROLE = getState()?.role || 'main';
  const myDate = () => (getState()?.role === 'child' ? getState().date : '');
  // 페이지 글자 (우리 패널 글자는 빼야 함: 패널에 다른 날짜의 예약번호가 보여서 '완료'로 오인할 수 있음)
  const pageText = () => {
    if (!document.body) return '';
    const p = document.querySelector('[data-cjm-panel]');
    if (!p) return document.body.innerText;
    p.style.display = 'none'; const t = document.body.innerText; p.style.display = ''; return t;
  };

  /* ---------- 타이머 ----------
     주의: 시작 버튼으로 연 창들은 모두 같은 렌더러(같은 메인 스레드)를 공유한다.
     MessageChannel로 계속 도는 대기는 다른 창들의 타이머를 굶겨 전체가 멈추므로(모의 실험에서 확인),
     평소엔 setTimeout을 쓰고 정각 직전 아주 짧은 순간만 한 틱씩 양보하며 기다린다.
     (창들이 화면에 보여야 타이머가 느려지지 않음 → 창을 타일로 배치) */
  const tick = () => new Promise(r => { const mc = new MessageChannel(); mc.port1.onmessage = () => r(); mc.port2.postMessage(0); });
  const sleep = ms => ms <= 0 ? tick() : new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, ms = 4000, step = 15) => {
    const t0 = performance.now();
    for (;;) {
      let v; try { v = fn(); } catch { v = null; }
      if (v) return v;
      if (performance.now() - t0 > ms) return null;
      await sleep(step);
    }
  };

  // 이동 (이유를 콘솔에 남김). 이미 다른 이동이 진행 중이면 끼어들지 않음 → 진행 중인 신청을 끊지 않게
  const go = (why, url) => {
    console.log('[예약도우미] 이동', (getState()?.date || 'ctrl'), why, location.pathname, '→', url || 'reload');
    if (unloading) { console.log('[예약도우미] 이미 이동 중이라 생략'); return; }
    if (url) location.replace(url); else location.reload();
  };
  // 페이지 이동 감지 (이동이 시작되면 다시 누르거나 재제출하지 않음)
  let unloading = false, gen = 0;
  addEventListener('beforeunload', () => { unloading = true; });
  addEventListener('pagehide', () => { unloading = true; });

  /* ---------- 결과/생존 신호 ---------- */
  function report(s, extra = {}) {
    const d = myDate();
    if (!d) return;
    try { localStorage.setItem(RES_PREFIX + d, JSON.stringify({ s, at: Date.now(), ...extra })); } catch {}
  }
  const readRes = d => { try { return JSON.parse(localStorage.getItem(RES_PREFIX + d) || 'null'); } catch { return null; } };
  const finish = (s, extra = {}) => { report(s, { fin: true, ...extra }); patch({ armed: false }); beep(); };

  /* ---------- 패널 ---------- */
  const panel = document.createElement('div');
  panel.setAttribute('data-cjm-panel', '1');
  panel.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;background:#111d;color:#fff;font:12px/1.4 sans-serif;padding:7px 9px;border-radius:8px;max-width:330px;pointer-events:auto';
  const status = document.createElement('div');
  const note = document.createElement('div');
  note.style.cssText = 'color:#ffd54f;margin-top:4px';
  const resBox = document.createElement('div');
  resBox.style.cssText = 'margin-top:4px;white-space:pre-line;font-size:11px';
  const bar = document.createElement('div');
  bar.style.marginTop = '5px';
  panel.append(status, note, resBox, bar);
  document.body.appendChild(panel);
  function log(m) { status.textContent = `[예약도우미${myDate() ? ' ' + myDate().slice(5) : ''}] ` + m; console.log('[예약도우미]', (myDate() || 'ctrl'), m); }
  function addBtn(label, fn) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'margin:2px 6px 2px 0;padding:3px 8px;cursor:pointer';
    b.onclick = fn; bar.appendChild(b);
    return b;
  }
  const beep = () => { try { const c = new AudioContext(), o = c.createOscillator(); o.connect(c.destination); o.frequency.value = 880; o.start(); setTimeout(() => o.stop(), 500); } catch {} };
  early.forEach(m => console.log('[예약도우미]', m));
  logFn = log;
  const renderResults = () => {
    try {
      const rows = Object.keys(localStorage).filter(k => k.startsWith(RES_PREFIX)).sort()
        .map(k => `${k.slice(RES_PREFIX.length + 5)}  ${JSON.parse(localStorage.getItem(k)).s}`);
      resBox.textContent = rows.join('\n');
    } catch {}
  };
  renderResults(); setInterval(renderResults, 1000);

  /* ---------- 페이지에서 값 읽기 / 날짜 계산 ---------- */
  const parseOpenAt = () => {
    const m = pageText().match(/접수기간\s*(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
    return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+09:00`).getTime() : 0;
  };
  const normMonth = v => {
    v = String(v).trim();
    if (/^\d{4}-\d{1,2}$/.test(v)) { const [y, m] = v.split('-'); return `${y}-${String(+m).padStart(2, '0')}`; }
    if (/^\d{1,2}$/.test(v)) { const n = new Date(), y = n.getFullYear() + (+v < n.getMonth() + 1 ? 1 : 0); return `${y}-${String(+v).padStart(2, '0')}`; }
    return v;
  };
  const parseMonth = () => { const m = pageText().match(/시설예약기간\s*(\d{4})-(\d{2})-\d{2}/); return m ? `${m[1]}-${m[2]}` : ''; };
  const resolveOpenAt = () => CFG.OPEN_AT === 'auto' ? parseOpenAt() : (CFG.OPEN_AT ? new Date(CFG.OPEN_AT.trim().replace(' ', 'T') + '+09:00').getTime() : 0);
  function datesFor(month) {
    if (CFG.TARGET_DATES.length) return CFG.TARGET_DATES.filter(d => !CFG.SKIP_DATES.includes(d));
    const [y, m] = month.split('-').map(Number);
    const out = [], n = new Date(y, m, 0).getDate(), p = v => String(v).padStart(2, '0');
    for (let d = 1; d <= n; d++) if (new Date(y, m - 1, d).getDay() === CFG.WEEKDAY) out.push(`${y}-${p(m)}-${p(d)}`);
    return out.filter(d => !CFG.SKIP_DATES.includes(d));
  }

  /* ---------- 서버시간 동기화 (navyism 방식) ----------
     Date 헤더(초 단위)를 여러 번 받아 "서버시각 - PC시각"을 구간으로 좁히고,
     서버의 '초가 바뀌는 순간'에 맞춘 요청으로 이분탐색해 ms 단위로 만든다. */
  const now = () => performance.timeOrigin + performance.now();
  // <sync-core>
  async function syncCore({ now, fetchDateMs, sleep, maxMs, onProgress }) {
    const iv = [];
    let minRtt = Infinity;
    const t_start = now();
    const probe = async () => {
      const t0 = now();
      const S = await fetchDateMs();   // 서버 Date 헤더(ms, 초 단위로 잘림) 또는 null
      const t1 = now();
      if (S == null) return false;
      minRtt = Math.min(minRtt, t1 - t0);
      iv.push({ lo: S - t1, hi: S + 1000 - t0 });
      return true;
    };
    const best = () => {
      let bc = -1, bl = 0, bh = 0;
      for (const c of iv) {
        const x = c.lo;
        const cov = iv.filter(i => i.lo <= x && i.hi > x);
        if (cov.length > bc) { bc = cov.length; bl = x; bh = Math.min(...cov.map(i => i.hi)); }
      }
      return bc < 0 ? null : { lo: bl, hi: bh, n: bc };
    };
    // 1단계: 거칠게 10번
    for (let i = 0; i < 10 && now() - t_start < maxMs; i++) {
      await probe();
      await sleep(110 + Math.random() * 60);
    }
    // 2단계: 서버 초 경계에 맞춰 이분탐색
    let b = best();
    for (let k = 0; k < 14 && b && now() - t_start < maxMs; k++) {
      if (b.hi - b.lo < minRtt + 10) break;
      const o = (b.lo + b.hi) / 2;                  // 현재 추정 오프셋(서버 - PC)
      const half = minRtt / 2;
      const X = Math.ceil((now() + o + half + 30) / 1000) * 1000; // 다음 서버 '정각 초'
      await sleep(Math.max(0, X - o - half - now())); // 서버가 그 초를 넘기는 순간에 도착하도록 발송
      await probe();
      b = best();
      if (onProgress && b) onProgress(b, k);
    }
    if (!b) return null;
    return { offset: (b.lo + b.hi) / 2, err: (b.hi - b.lo) / 2, rtt: minRtt, n: iv.length, at: Date.now() };
  }
  // </sync-core>
  const loadSync = (since = 0) => { try { const s = JSON.parse(localStorage.getItem(SYNC_KEY) || 'null'); return s && s.at >= since && Date.now() - s.at < 10 * 60 * 1000 ? s : null; } catch { return null; } };
  let SYNC = loadSync();
  const serverNow = () => now() + (SYNC ? SYNC.offset : 0);
  const fmtT = ms => { const d = new Date(Math.floor(ms)); const p = (n, w = 2) => String(n).padStart(w, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`; };
  const fmtOfs = () => SYNC ? `PC보다 ${SYNC.offset >= 0 ? '+' : ''}${Math.round(SYNC.offset)}ms(±${Math.round(SYNC.err)})` : 'PC 시계 사용';
  const fetchDateMs = async () => {
    try {
      const u = CFG.SYNC_URL + (CFG.SYNC_URL.includes('?') ? '&' : '?') + '_=' + Math.random().toString(36).slice(2);
      const r = await fetch(u, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' });
      const d = r.headers.get('date');
      const t = d ? Date.parse(d) : NaN;
      return isNaN(t) ? null : t;
    } catch { return null; }
  };
  async function doSync(msg) {
    log(msg);
    const r = await syncCore({ now, fetchDateMs, sleep, maxMs: CFG.SYNC_MAX_MS, onProgress: b => log(`${msg} (±${Math.round((b.hi - b.lo) / 2)}ms)`) });
    if (r) {
      SYNC = r; localStorage.setItem(SYNC_KEY, JSON.stringify(r));
      log(`서버시간 동기화 완료: ${fmtOfs()}, 왕복 ${Math.round(r.rtt)}ms`);
    } else log('서버시간 측정 실패 — PC 시계로 진행');
    return r;
  }

  /* ---------- DOM 도구 ---------- */
  const setVal = (el, v) => {
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const visible = e => !!e && e.getClientRects().length > 0 && !e.closest('[data-cjm-panel]');
  const btnByText = re => [...document.querySelectorAll('a,button')].find(e => re.test((e.textContent || '').trim()) && visible(e));
  // "다음" 버튼 (달력의 "다음달 달력 보기" 화살표는 제외)
  const findNext = () => {
    const txt = e => ((e.value || e.textContent) || '').replace(/\s+/g, '');
    const ok = e => visible(e) && !e.closest('header,nav') && !/다음달|이전달|달력/.test(txt(e)) && !e.closest('[class*=calendar]');
    const c = [...document.querySelectorAll('button,a,input[type=submit],input[type=button]')].filter(ok);
    const subs = c.filter(e => e.getAttribute('type') === 'submit' || (e.tagName === 'BUTTON' && !e.getAttribute('type') && e.form));
    const subNext = subs.filter(e => /^다음/.test(txt(e)) || txt(e) === '');
    if (subNext.length) return subNext[subNext.length - 1];
    if (subs.length) return subs[subs.length - 1];
    return c.find(e => /^다음[>›»]?$/.test(txt(e))) || null;
  };
  // 순번대기(NetFUNNEL) 화면이 떠 있는지
  const queueEl = () => [...document.querySelectorAll('[id^="overlay-"],[id^="nf-vwr"],iframe[src*="wait.cheongju"],iframe[name*="netfunnel" i]')].find(visible);
  const queueInfo = () => {
    const a = document.getElementById('nf-vwr-metrics-ahead-count-value');
    return a && a.textContent.trim() ? `앞 ${a.textContent.trim()}명` : '';
  };
  const isErrorPage = () => /페이지를\s*찾을\s*수\s*없|cannot be found|Service Unavailable|Internal Server Error|Bad Gateway|Gateway Time-?out|일시적으로 서비스|접속자가 많/i.test(pageText().slice(0, 3000));
  const isDonePage = () => /addFcltyApplWebSuccess/.test(path) || (/FCT\d+-\d+-\d+/.test(pageText()) && /예약|신청/.test(pageText()));
  const alertSince = t => lastAlert && lastAlert.t >= t ? lastAlert.m : null;

  // 다음 버튼 클릭. allowResubmit=false면(최종 신청) 절대 다시 제출하지 않음
  async function clickNext(allowResubmit) {
    const n = await waitFor(findNext, 5000, 20);
    if (!n) return 'nobtn';
    const t = Date.now();
    n.scrollIntoView({ block: 'center' });
    n.click();
    const r = await waitFor(() => unloading ? 'nav' : alertSince(t) ? 'alert' : null, allowResubmit ? 4000 : 60000, 20);
    if (r) return r;
    if (allowResubmit && n.form && !unloading) {
      log('클릭이 안 먹혀 폼 제출 재시도');
      try { n.form.requestSubmit(n); } catch { n.form.submit(); }
      return (await waitFor(() => unloading ? 'nav' : alertSince(t) ? 'alert' : null, 60000, 20)) || 'stuck';
    }
    return 'stuck';
  }

  // 창 재시작 (상세 페이지로 돌아가 순번대기부터 다시)
  function restart(why) {
    const st = getState() || {};
    const n = (st.recover || 0) + 1;
    if (n > CFG.MAX_RECOVER) { finish(`❌ 복구 한도 초과 (${why})`); return; }
    patch({ recover: n, stage: '' });
    report(`재시도 ${n}/${CFG.MAX_RECOVER}: ${why}`);
    log(`${why} → 처음부터 다시 (${n}/${CFG.MAX_RECOVER})`);
    go('restart:' + why, st.detailUrl || '/www/index.do');
  }

  /* ---------- 창 열기 ---------- */
  // 화면 왼쪽 1/4은 컨트롤러(원래 창)가 보이도록 비워 두고 나머지에 창을 타일 배치
  // (완전히 가려진 창은 윈도우가 '숨김'으로 처리해 타이머가 느려짐)
  function winFeatures(i, n) {
    const cols = Math.min(3, n), rows = Math.ceil(n / cols);
    const L = Math.floor(screen.availWidth / 4), W = screen.availWidth - L, H = screen.availHeight;
    const w = Math.floor(W / cols), h = Math.floor(H / rows);
    return `popup=yes,width=${w},height=${h},left=${L + (i % cols) * w + (screen.availLeft || 0)},top=${Math.floor(i / cols) * h + (screen.availTop || 0)}`;
  }
  const wins = {};
  const openChild = (c, d, r = 0) => {
    const i = c.dates.indexOf(d);
    console.log('[예약도우미] 창 열기', d, 'r=' + r);
    return wins[d] = window.open(c.detailUrl + `#cjm=${d}&t=${c.startedAt}&i=${i}&o=${c.openAt}&r=${r}`, 'cjm_' + d, winFeatures(i, c.dates.length));
  };

  /* ---------- 버튼 ---------- */
  addBtn('중지(전체)', () => { patch({ armed: false }); localStorage.setItem(STOP_KEY, String(Date.now())); log('중지됨 (모든 창)'); });
  if (path.endsWith('selectFcltyWebView.do') && ROLE !== 'child') {
    addBtn('▶ 시작(대기)', () => {
      const month = CFG.TARGET_DATES.length ? '' : (CFG.TARGET_MONTH === 'auto' ? parseMonth() : normMonth(CFG.TARGET_MONTH));
      if (!CFG.TARGET_DATES.length && !month) { log('시설예약기간을 못 읽었어요 — CFG.TARGET_MONTH를 지정하세요'); return; }
      const openAt = resolveOpenAt();
      if (CFG.OPEN_AT === 'auto' && !openAt) { log('접수기간을 못 읽었어요 — CFG.OPEN_AT을 지정하세요'); return; }
      let dates = datesFor(month);
      if (!dates.length) { log('대상 날짜가 없어요 — CFG(월/요일/날짜)를 확인하세요'); return; }
      if (!CFG.PARALLEL) dates = dates.slice(0, 1);
      if (dates.length > CFG.MAX_TABS) { log(`날짜가 ${dates.length}개라 MAX_TABS(${CFG.MAX_TABS})를 넘어요`); return; }
      Object.keys(localStorage).filter(k => k.startsWith(RES_PREFIX) || k.startsWith(HB_PREFIX)).forEach(k => localStorage.removeItem(k));
      const c = { armed: true, role: 'ctrl', startedAt: Date.now(), openAt, dates, detailUrl: path + location.search, rec: {}, pending: [] };
      // 클릭 직후 동기적으로 창을 모두 연다 (팝업 허용 필요)
      dates.forEach(d => { if (!openChild(c, d)) c.pending.push(d); });
      setState(c);
      route();
    });
  }
  addBtn('⏱ 서버시간', () => doSync('서버시간 측정 중...'));

  /* ---------- 컨트롤러 (시작 버튼을 누른 창: 예약은 안 하고 시간 측정·감시·복구만) ---------- */
  async function stepCtrl(g) {
    const c = getState();
    document.title = '[컨트롤러] ' + document.title.replace(/^\[[^\]]*\]\s*/, '');
    c.dates.forEach(d => { if (!readRes(d)) localStorage.setItem(RES_PREFIX + d, JSON.stringify({ s: '창 여는 중', at: Date.now() })); });
    if (c.pending?.length) {
      note.textContent = '⚠ 팝업이 차단돼 일부 창을 못 열었어요. 아래 버튼을 누르고, 주소창의 팝업 차단 아이콘에서 이 사이트를 "허용"하세요.';
      c.pending.forEach(d => {
        const b = addBtn(`창 열기 ${d.slice(5)}`, () => {
          const s = getState();
          if (openChild(s, d)) { b.remove(); patch({ pending: (getState().pending || []).filter(x => x !== d) }); if (!getState().pending.length) note.textContent = ''; }
        });
      });
    }
    const openAt = c.openAt;
    if (!/로그아웃/.test(pageText())) note.textContent = '⚠ 로그인 안 된 것 같아요. 로그인 후 다시 시작하세요.';
    let lastPing = Date.now();
    if (openAt && openAt - serverNow() > 3000 && !loadSync(c.startedAt - 120000)) await doSync('서버시간 측정 중...');
    const seen = {}, badSince = {}; c.dates.forEach(d => { seen[d] = Date.now(); });
    for (;;) {
      if (g !== gen) return;
      if (!armed()) { log('중지됨'); return; }
      const left = openAt ? openAt - serverNow() : 0;
      // 오래 기다리는 동안 로그인 세션이 끊기지 않게 4분마다 가볍게 접속
      if (left > 30000 && Date.now() - lastPing > 240000) { lastPing = Date.now(); fetch(CFG.SYNC_URL, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' }).catch(() => {}); }
      const s = getState();
      let finCnt = 0;
      try {
      for (const d of s.dates) {
        const r = readRes(d) || {};
        if (r.fin) { finCnt++; continue; }
        const hb = Number(localStorage.getItem(HB_PREFIX + d) || 0);
        if (hb) seen[d] = Math.max(seen[d], hb);
        // 창이 브라우저 오류 화면(연결 끊김 등)이면 즉시 감지: 그 화면은 다른 출처라 주소를 읽을 수 없음
        let broken = false;
        const w = wins[d];
        if (w && !w.closed) {
          let bad = false; try { void w.location.href; } catch { bad = true; }
          if (bad) { badSince[d] ||= Date.now(); broken = Date.now() - badSince[d] > 1500; } else badSince[d] = 0;
        }
        const quiet = Date.now() - seen[d];
        // 진행 정체 감지: 서버가 요청을 붙잡고 응답을 안 주면 창은 살아 있어도 멈춘 상태가 됨
        const since = Math.max(r.at || 0, openAt ? openAt - (SYNC?.offset || 0) : s.startedAt);
        const stalled = Date.now() - since > (r.final ? CFG.STALL_MS * 2 : CFG.STALL_MS);
        if (!broken && !stalled && (quiet < CFG.WATCHDOG_MS || (s.pending || []).includes(d))) continue;
        if ((s.pending || []).includes(d)) continue;
        if (r.final) { // 최종 신청 도중 멈춤 → 예약됐을 수도 있으니 절대 다시 신청하지 않음
          localStorage.setItem(RES_PREFIX + d, JSON.stringify({ s: '⚠ 최종 신청 후 응답 없음 — 예약됐을 수 있으니 예약확인에서 직접 확인 (다시 신청 안 함)', at: Date.now(), fin: true }));
          continue;
        }
        const n = (s.rec?.[d] || 0) + 1;
        if (n > CFG.MAX_RECOVER) { localStorage.setItem(RES_PREFIX + d, JSON.stringify({ s: '❌ 창 응답 없음 (복구 한도 초과)', at: Date.now(), fin: true })); continue; }
        patch({ rec: { ...(s.rec || {}), [d]: n } });
        seen[d] = Date.now(); badSince[d] = 0;
        console.log('[예약도우미] ctrl watchdog', d, n, broken ? '(오류 화면)' : stalled ? '(진행 정체)' : '(응답 없음)');
        localStorage.setItem(RES_PREFIX + d, JSON.stringify({ s: `${broken ? '연결 오류 화면' : stalled ? '진행 멈춤' : '창 응답 없음'} → 다시 시작 (${n}/${CFG.MAX_RECOVER})`, at: Date.now() }));
        openChild(s, d, n);
      }
      } catch (e) { console.log('[예약도우미] ctrl error', e && e.message); }
      localStorage.setItem('cjm_ctrl_hb', String(Date.now()));
      if (finCnt === s.dates.length) { log('모든 날짜 처리 끝 — 결과를 확인하세요'); beep(); patch({ armed: false }); return; }
      log(left > 0 ? `컨트롤러: 접수까지 ${Math.ceil(left / 1000)}초 | 서버 ${fmtT(serverNow())} | ${fmtOfs()}` : `컨트롤러: 진행 중 (${finCnt}/${s.dates.length} 끝)`);
      await sleep(left > 3000 ? 250 : 500);
    }
  }

  /* ---------- 1단계: 상세 페이지 → 신청하기 → 순번대기 ---------- */
  async function stepDetail(g) {
    let st = getState();
    const openAt = st.openAt || 0, idx = st.idx || 0;
    if (openAt && openAt - serverNow() > 3000) {
      report('대기 (서버시간 공유 대기)');
      const got = await waitFor(() => { const s = loadSync(st.startedAt - 120000); if (s) SYNC = s; return s; }, 40000, 100);
      if (!got && armed()) await doSync('서버시간 측정 중(단독)...');
    }
    const lead = CFG.LEAD_MS == null ? Math.round((SYNC?.rtt || 0) / 2) : CFG.LEAD_MS;
    const target = openAt ? openAt - lead + CFG.STAGGER_MS * idx : 0;
    if (openAt && serverNow() < target) report('대기');
    // 오래 기다렸으면 첫 번째 창이 오픈 25초 전에 서버시간을 다시 재서 모든 창에 공유
    let resynced = !(idx === 0 && openAt && openAt - serverNow() > 60000);
    while (openAt && serverNow() < target - 20) {
      if (g !== gen || !armed()) return;
      if (!resynced && openAt - serverNow() < 25000) { resynced = true; await doSync('오픈 직전 재측정...'); continue; }
      const s = loadSync(); if (s) SYNC = s; // 컨트롤러의 재측정 값 반영
      log(`대기 ${Math.max(0, Math.round((openAt - serverNow()) / 100) / 10)}초 | 서버 ${fmtT(serverNow())} | ${fmtOfs()}`);
      await sleep(serverNow() < target - 2000 ? 100 : 5);
    }
    while (openAt && serverNow() < target) { await sleep(0); }
    for (;;) {
      if (g !== gen || !armed()) return;
      st = getState();
      if ((st.clicks || 0) >= CFG.MAX_CLICKS) { finish('❌ 신청 페이지 진입 실패 (재시도 한도)'); return; }
      const gap = CFG.CLICK_GAP_MS - (Date.now() - (st.lastClick || 0));
      if (gap > 0) await sleep(gap);
      const btn = await waitFor(() => btnByText(/^신청하기$/), 5000, 10);
      if (!btn) { restart('신청하기 버튼 없음'); return; }
      const t = Date.now();
      patch({ clicks: (st.clicks || 0) + 1, lastClick: t });
      btn.click();
      log(`신청하기 클릭 #${(st.clicks || 0) + 1} @서버 ${fmtT(serverNow())}`);
      report('신청하기 클릭 → 순번대기');
      // 결과 지켜보기: 이동 / 알림 / 순번대기 중(절대 새로고침 안 함) / 무반응
      let queued = false, last = 0, res = null;
      while (!res) {
        if (g !== gen) return;
        if (unloading) res = 'nav';
        else if (alertSince(t)) res = 'alert';
        else {
          const q = queueEl();
          if (q) {
            queued = true;
            if (Date.now() - last > 1000) { last = Date.now(); const qi = queueInfo(); log(`순번대기 중 ${qi} (${Math.round((Date.now() - t) / 1000)}초)`); report(`순번대기 중 ${qi}`); }
            if (Date.now() - t > CFG.QUEUE_MAX_MS) res = 'timeout';
          } else if (!queued && Date.now() - t > 10000) res = 'silent';
          else if (queued && Date.now() - t > 3000 && !q) res = Date.now() - t > 15000 ? 'silent' : null; // 대기 끝났는데 이동이 없음
        }
        if (!res) await sleep(30);
      }
      if (res === 'nav') return;
      if (res === 'alert') { log('알림 후 다시 클릭: ' + lastAlert.m); continue; }
      restart(res === 'timeout' ? '순번대기 시간 초과' : '신청하기 무반응'); return;
    }
  }

  /* ---------- 2단계: 달력에서 날짜/시간/동의 ---------- */
  async function stepCalendar(g) {
    const t0 = Date.now();
    let st = getState();
    patch({ calUrl: location.href });
    // 접수 전이라 튕겨낸 경우(알림 + 뒤로가기) → 상세 페이지로 가서 다시 클릭
    await sleep(30);
    if (backRequested || (alertSince(t0 - 5000) && /접수|기간|아닙니다|불가/.test(lastAlert.m) && !document.querySelector('.calendar,[class*=calendar]'))) {
      log('접수 전으로 튕김 → 다시 신청하기'); report('접수 전 튕김 → 재시도');
      go('bounce', st.detailUrl); return;
    }
    report('달력');
    const [Y, M, D] = myDate().split('-').map(Number);
    const ajaxErr = since => alertSince(since) && /에러|오류|error/i.test(lastAlert.m);
    // 월 맞추기 (달력은 AJAX로 그려지므로 느릴 수 있음)
    for (let i = 0; i < 14; i++) {
      if (g !== gen) return;
      const head = await waitFor(() => pageText().match(/(\d{4})년\s*(\d{1,2})월/), CFG.AJAX_WAIT_MS, 30);
      if (!head) { restart('달력이 안 그려짐'); return; }
      const cur = (+head[1]) * 12 + (+head[2]), want = Y * 12 + M;
      if (cur === want) break;
      const b = btnByText(cur < want ? /다음달/ : /이전달/);
      if (!b) { finish('❌ 월 이동 버튼 없음'); return; }
      b.click();
      await waitFor(() => { const h = pageText().match(/(\d{4})년\s*(\d{1,2})월/); return h && (+h[1]) * 12 + (+h[2]) !== cur; }, 3000, 15);
    }
    const findDay = () => [...document.querySelectorAll('button')].find(b => {
      if (b.disabled || !/\d+\s*\/\s*\d+/.test(b.innerText)) return false;
      const first = b.firstElementChild ? b.firstElementChild.textContent.trim() : (b.innerText.match(/^\d{1,2}/) || [''])[0];
      return +first === D;
    });
    // 같은 날짜 버튼이 있는데 비활성: 접수 시작 직전에 들어온 경우일 수 있음 → 잠깐 뒤 달력만 새로고침
    const findDayAny = () => [...document.querySelectorAll('button')].find(b => /\d+\s*\/\s*\d+/.test(b.innerText) && +((b.firstElementChild ? b.firstElementChild.textContent : b.innerText).trim().match(/^\d{1,2}/) || [0])[0] === D);
    let calStart = Date.now();
    const nearOpen = () => !st.openAt || serverNow() < st.openAt + 60000;
    const dayBtn = await waitFor(() => findDay() || (ajaxErr(calStart) ? 'err' : null) || (findDayAny() && Date.now() - calStart > 1200 && nearOpen() ? 'disabled' : null), CFG.AJAX_WAIT_MS);
    if (dayBtn === 'disabled') {
      const n = (st.calReload || 0) + 1;
      if (n <= 30) { patch({ calReload: n }); report(`날짜 아직 비활성 → 달력 새로고침 (${n})`); await sleep(CFG.CLICK_GAP_MS); go('dayDisabled'); return; }
    }
    if (!dayBtn || dayBtn === 'err' || dayBtn === 'disabled') {
      const n = (st.calReload || 0) + 1;
      if (n <= 3) { patch({ calReload: n }); log('달력 로딩 실패 → 새로고침'); await sleep(300); go('calReload'); return; }
      finish(`❌ ${myDate()} 날짜 버튼 없음/비활성`); return;
    }
    // 시간대: 목록이 늦게 오거나 에러면 날짜를 다시 눌러 재요청
    const wanted = CFG.SLOTS.filter(s => !(st.failed || []).includes(s));
    let picked = null, listed = false;
    for (let attempt = 0; attempt < 4 && !picked; attempt++) {
      if (g !== gen) return;
      const tPick = Date.now();
      findDay()?.click();
      log(`날짜 선택${attempt ? ` (재요청 ${attempt})` : ''}`);
      const r = await waitFor(() => {
        if (ajaxErr(tPick)) return 'err';
        const rows = [...document.querySelectorAll('li,tr')].filter(li => /예약가능|예약완료|마감|신청가능/.test(li.textContent) && /\d{2}:\d{2}/.test(li.textContent));
        if (!rows.length) return null;
        for (const slot of wanted) {
          const row = rows.find(li => norm(li.textContent).includes(norm(slot)) && /예약가능|신청가능/.test(li.textContent) && !li.querySelector('input:disabled'));
          if (row) return { slot, row };
        }
        return 'none';
      }, CFG.AJAX_WAIT_MS, 15);
      if (r && r !== 'err' && r !== 'none') picked = r;
      else if (r === 'none') { listed = true; if (attempt >= 1) break; await sleep(250); }
      else await sleep(300);
    }
    if (!picked) { finish(listed ? '❌ 마감 (원하는 시간대 없음)' : '❌ 시간표를 못 불러옴'); return; }
    const cb = picked.row.querySelector('input[type=checkbox],input[type=radio]');
    if (cb) { if (!cb.checked) (picked.row.querySelector('label') || cb).click(); if (!cb.checked) cb.click(); }
    else picked.row.click();
    patch({ slot: picked.slot });
    log('시간 선택: ' + picked.slot);
    // 약관 동의
    const agreeAll = [...document.querySelectorAll('input[type=radio],input[type=checkbox]')].find(r => r.id === 'all' || /모든\s*약관/.test((r.closest('label,li,div')?.textContent) || ''));
    if (agreeAll && !agreeAll.checked) agreeAll.click();
    await sleep(20);
    document.querySelectorAll('input[type=radio][value=Y]').forEach(r => { if (!r.checked) r.click(); });
    report('정보 입력으로 이동 (' + picked.slot + ')');
    const r = await clickNext(true);
    if (r === 'nav') return;
    if (r === 'alert') { log('다음 실패: ' + lastAlert.m); await sleep(200); go('calNextAlert'); return; }
    restart('달력 다음 버튼 실패(' + r + ')');
  }

  /* ---------- 3단계: 신청자 정보 입력 → 최종 신청 ---------- */
  const rowOf = label => [...document.querySelectorAll('tr,li,dl,div')].filter(e => {
    const h = e.querySelector('th,dt,label,strong,span');
    return h && norm(h.textContent).startsWith(label) && e.querySelector('input,select');
  }).sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0];

  async function stepInfo(g) {
    const st = getState();
    if (st.stage === 'final') { // 최종 신청 후 이 페이지로 되돌아옴(뒤로가기 복원 등) → 결과 불명
      finish('⚠ 최종 신청 결과 불명 — 예약확인에서 직접 확인'); return;
    }
    const ok = await waitFor(() => document.querySelector('input[type=text],input:not([type])'), 8000);
    if (!ok) { restart('정보 입력 화면이 비어 있음'); return; }
    // 안전장치: 이 화면에 표시된 예약일자가 내 날짜가 아니면 절대 신청하지 않음
    const shown = [...pageText().matchAll(/(20\d{2})[-.](\d{2})[-.](\d{2})/g)].map(m => `${m[1]}-${m[2]}-${m[3]}`);
    if (shown.length && !shown.includes(myDate())) { restart(`날짜 불일치(화면 ${shown[0]})`); return; }
    const gI = document.querySelector('input[placeholder*="단체명"]') || rowOf('단체명')?.querySelector('input');
    const pI = rowOf('신청인원')?.querySelector('input');
    const mails = rowOf('이메일')?.querySelectorAll('input[type=text],input:not([type])');
    if (!gI || !pI || !mails || mails.length < 2) { finish('⚠ 입력칸 못 찾음 — 직접 입력 필요'); return; }
    setVal(gI, CFG.GROUP); setVal(pI, CFG.PEOPLE);
    setVal(mails[0], CFG.EMAIL_ID); setVal(mails[1], CFG.EMAIL_DOMAIN);
    if (CFG.DRY_RUN) { log('DRY_RUN: 마지막 "다음" 직전에서 멈춤 (실제 신청 안 됨)'); finish(`DRY_RUN 정지 (신청 직전, ${st.slot || ''})`); return; }
    if (g !== gen || !armed()) return;
    patch({ stage: 'final' });
    report('최종 신청 중 (' + (st.slot || '') + ')', { final: true });
    log('최종 다음 → 신청');
    const r = await clickNext(false); // 최종 신청은 절대 재제출하지 않음 (중복 예약 방지)
    if (r === 'nav') return;
    if (r === 'alert') { patch({ stage: '' }); log('신청 전 확인 실패: ' + lastAlert.m); finish('⚠ 최종 신청 거부: ' + lastAlert.m.slice(0, 40)); return; }
    finish('⚠ 최종 신청 버튼 반응 없음 — 직접 확인 필요');
  }

  /* ---------- 최종 신청 응답이 '선점됨' 알림이었을 때 ---------- */
  function afterFinalAlert() {
    const st = getState();
    const m = lastAlert?.m || '';
    const failed = [...new Set([...(st.failed || []), st.slot].filter(Boolean))];
    const left = CFG.SLOTS.filter(s => !failed.includes(s));
    patch({ stage: '', failed, calReload: 0 });
    if (left.length && st.calUrl) { report(`선점됨(${st.slot}) → 다음 시간대 시도`); log('선점됨: ' + m); go('taken', st.calUrl); }
    else finish('❌ 선점됨: ' + m.slice(0, 40));
  }

  /* ---------- 4단계: 완료 ---------- */
  function stepDone() {
    const no = (pageText().match(/FCT\d+-\d+-\d+/) || [''])[0];
    log('✅ 예약 신청 완료 화면입니다. 예약번호/입금 확인하세요!');
    finish('✅ 완료 ' + no + ' (' + (getState()?.slot || '') + ')');
  }

  /* ---------- 라우팅 ---------- */
  let hbTimer = 0;
  async function route() {
    const g = ++gen;
    unloading = false;
    const st = getState();
    if (st?.role === 'ctrl') { if (st.armed) return stepCtrl(g); log('대기(시작 전)'); return; }
    if (!armed()) { log('대기(시작 전)' + (SYNC ? ' | 서버시간 ' + fmtOfs() : '')); return; }
    if (st.role === 'child') {
      if (!document.title.startsWith('[')) document.title = `[${st.date.slice(5)}] ` + document.title;
      if (!hbTimer) { const hb = () => { if (armed()) localStorage.setItem(HB_PREFIX + st.date, String(Date.now())); }; hb(); hbTimer = setInterval(hb, 1000); }
    }
    if (isDonePage()) return stepDone();
    if (/login|Login/.test(path) || (document.querySelector('input[type=password]') && /로그인/.test(pageText().slice(0, 2000)))) {
      finish('⚠ 로그인이 풀렸어요 — 로그인 후 다시 시작'); return;
    }
    if (st.stage === 'final') {
      if (lastAlert || backRequested) return afterFinalAlert();       // 선점/마감 알림
      if (isErrorPage()) { finish('⚠ 최종 신청 후 오류 화면 — 예약확인에서 직접 확인'); return; }
    }
    if (isErrorPage()) {
      // 서버 과부하 오류 화면: 대기열을 다시 서지 않도록 가능한 한 같은 단계에서 재시도
      const n = (st.errRetry || 0) + 1;
      patch({ errRetry: n });
      if (n <= 4 && /selectFcltyWebView|fcltyApplCalendarWebView/.test(path)) { report(`서버 오류 → 같은 화면 다시 열기 (${n})`); await sleep(300 + 200 * n); go('errReload'); return; }
      if (n <= 4 && /addFcltyApplWebView/.test(path) && st.calUrl) { report(`서버 오류 → 달력부터 다시 (${n})`); await sleep(300); go('errToCal', st.calUrl); return; }
      patch({ errRetry: 0 }); restart('오류 페이지'); return;
    }
    if (st.errRetry) patch({ errRetry: 0 });
    if (path.endsWith('selectFcltyWebView.do')) return stepDetail(g);
    if (path.endsWith('fcltyApplCalendarWebView.do')) return stepCalendar(g);
    if (path.endsWith('addFcltyApplWebView.do')) return stepInfo(g);
    if (backRequested) { restart('알 수 없는 화면에서 뒤로가기'); return; }
    log('알 수 없는 화면 — 대기');
  }
  // 뒤로가기 캐시(bfcache)로 복원된 경우 스크립트가 다시 실행되지 않으므로 직접 재시작
  addEventListener('pageshow', e => { if (e.persisted) route(); });
  // 컨트롤러가 같은 주소(해시만 다름)로 다시 시작시키면 새로고침이 안 되므로 직접 처리
  addEventListener('hashchange', () => { if (initFromHash()) { unloading = false; go('hashRestart'); } });
  route();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
