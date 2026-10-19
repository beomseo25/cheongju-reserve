// ==UserScript==
// @name         청주 통합예약 - 흥덕축구공원 예약 도우미 (prototype)
// @namespace    local.cheongju.reserve
// @version      0.7
// @description  접수 시각(서버시간)에 맞춰 달의 모든 지정 요일을 날짜마다 탭 1개씩 병렬로 자동 신청
// @match        https://ticket.cheongju.go.kr/www/*
// @run-at       document-end
// @grant        none
// ==/UserScript==
(() => {
  'use strict';

  /* ================= 설정 (여기만 고치세요) ================= */
  const CFG = {
    // 접수 시작 시각 (대상 사이트 서버시간 기준, 한국시간)
    //   'auto'                  = 상세 페이지의 "접수기간" 시작 시각을 읽어서 사용 (권장)
    //   ''                      = 시작 버튼 누르는 즉시 진행 (테스트용)
    //   '2026-11-19 09:00:00'   = 직접 지정
    OPEN_AT: 'auto',

    // 예약할 달: 'auto' = 상세 페이지의 "시설예약기간" 시작 달, 또는 '2026-12' 처럼 직접 지정
    TARGET_MONTH: 'auto',
    WEEKDAY: 0,          // 예약할 요일: 0=일 1=월 2=화 3=수 4=목 5=금 6=토
    TARGET_DATES: [],    // 날짜를 직접 지정하려면 ['2026-12-06', '2026-12-13'] (있으면 위 월/요일 설정보다 우선)
    SKIP_DATES: [],      // 제외할 날짜 ['2026-12-27']

    // 시간대 우선순위 (앞에서부터 '예약가능'이면 선택)
    SLOTS: ['06:30 ~ 08:30'],

    // 병렬 신청: 날짜마다 탭 1개씩 동시에 신청 (false면 첫 날짜 하나만)
    PARALLEL: true,
    MAX_TABS: 6,         // 한 번에 열 수 있는 최대 탭(=날짜) 수
    STAGGER_MS: 25,      // 탭마다 이 간격(ms)씩 차례로 클릭 (서버에 한꺼번에 몰리지 않게)

    // 신청자 정보
    GROUP: '단체명',
    PEOPLE: '1',
    EMAIL_ID: 'your_id',
    EMAIL_DOMAIN: 'gmail.com',

    // true: 마지막 "다음"(= 실제 예약 신청) 직전에 멈춤. 처음엔 반드시 true로 테스트하세요.
    DRY_RUN: true,

    MAX_RELOAD: 150,   // 오픈 직후 신청하기가 안 열릴 때 새로고침 최대 횟수
    RELOAD_GAP_MS: 350, // 새로고침 간격(너무 짧게 줄이지 마세요)

    // --- 서버시간 동기화 ---
    SYNC_URL: '/www/index.do', // 서버시간(Date 헤더)을 재는 같은 사이트 주소
    SYNC_MAX_MS: 12000,        // 한 번 측정에 쓰는 최대 시간
    LEAD_MS: null              // null=자동(왕복시간의 절반만큼 일찍 클릭), 숫자=고정 ms
  };
  /* ========================================================= */

  /* ---------- 기본 도구 ---------- */
  const KEY = 'cjm_state';          // 탭별 상태 (sessionStorage)
  const STOP_KEY = 'cjm_stop';      // 모든 탭 공통 중지 신호 (localStorage)
  const RES_PREFIX = 'cjm_res_';    // 날짜별 결과 (localStorage)
  const SYNC_KEY = 'cjm_sync';      // 서버시간 측정값 공유 (localStorage)
  const norm = s => (s || '').replace(/\s+/g, '');
  const path = location.pathname;
  const pageText = () => (document.body ? document.body.innerText : '');
  const getState = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { return null; } };
  const setState = s => sessionStorage.setItem(KEY, JSON.stringify(s));
  const armed = () => {
    const s = getState();
    if (!s?.armed) return false;
    return !(Number(localStorage.getItem(STOP_KEY) || 0) > (s.startedAt || 0));
  };
  const myDate = () => getState()?.date || '';

  // 백그라운드 탭의 setTimeout은 1초 단위로 늦춰지므로, 타이머를 Worker에 맡겨 정확도를 유지
  const timerWorker = (() => {
    try {
      const src = 'onmessage=e=>{const [id,ms]=e.data;setTimeout(()=>postMessage(id),ms)}';
      return new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    } catch { return null; }
  })();
  const pend = new Map();
  let seq = 0, workerDead = !timerWorker;
  if (timerWorker) {
    timerWorker.onmessage = e => { const r = pend.get(e.data); if (r) { pend.delete(e.data); r(); } };
    timerWorker.onerror = () => { workerDead = true; pend.forEach(r => r()); pend.clear(); };
  }
  // Worker가 CSP로 막힌 사이트(청주시 통합예약)에서는 MessageChannel 스핀으로 대체:
  // 숨겨진 탭에서도 setTimeout처럼 1초 단위로 밀리지 않는다.
  const mcSleep = ms => new Promise(r => {
    const end = performance.now() + ms, mc = new MessageChannel();
    mc.port1.onmessage = () => { if (performance.now() >= end) r(); else mc.port2.postMessage(0); };
    mc.port2.postMessage(0);
  });
  const sleep = ms => workerDead
    ? ((document.hidden || ms < 60) ? mcSleep(ms) : new Promise(r => setTimeout(r, ms)))
    : new Promise(r => { const id = ++seq; pend.set(id, r); timerWorker.postMessage([id, ms]); });

  // 자식 탭: 주소 해시로 전달받은 날짜/시각으로 자기 상태를 초기화 (해시는 지워서 새로고침 때 재초기화 방지)
  const hm = location.hash.match(/^#cjm=([\d-]+)&t=(\d+)&i=(\d+)&o=(\d+)/);
  if (hm) {
    setState({ armed: true, tries: 0, role: 'child', idx: +hm[3], date: hm[1], startedAt: +hm[2], openAt: +hm[4] });
    history.replaceState(null, '', location.pathname + location.search);
  }
  const ROLE = getState()?.role || 'main';
  if (myDate() && !document.title.startsWith('[')) document.title = `[${myDate().slice(5)}] ` + document.title;

  // 결과 기록 (날짜별 키라서 여러 탭이 동시에 써도 서로 덮어쓰지 않음)
  function report(s) {
    const d = myDate();
    if (!d) return;
    try { localStorage.setItem(RES_PREFIX + d, JSON.stringify({ s, at: Date.now() })); } catch {}
  }

  // 알림창이 뜨면 자동화가 멈추므로 무시하고 로그/결과에만 남김
  window.alert = m => { log('alert: ' + m); if (armed()) report('알림: ' + String(m).slice(0, 40)); };
  window.confirm = m => { log('confirm: ' + m); return true; };

  const waitFor = async (fn, ms = 4000, step = 15) => {
    const t0 = performance.now();
    for (;;) {
      let v; try { v = fn(); } catch { v = null; }
      if (v) return v;
      if (performance.now() - t0 > ms) return null;
      await sleep(step);
    }
  };
  const setVal = (el, v) => {
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const btnByText = re => [...document.querySelectorAll('a,button')].find(e => re.test((e.textContent || '').trim()) && e.offsetParent !== null);
  // "다음" 버튼: 글자로 먼저 찾고, 글자가 없는 submit 버튼이면 그걸 사용
  const findNext = () => {
    // 주의: "다음달 달력 보기" 같은 달력 화살표도 '다음'으로 시작하므로 반드시 제외
    const txt = e => ((e.value || e.textContent) || '').replace(/\s+/g, '');
    const ok = e => e.getClientRects().length > 0 && !e.closest('header,nav') && !/다음달|이전달|달력/.test(txt(e)) && !e.closest('[class*=calendar]') && !e.closest('[data-cjm-panel]');
    const c = [...document.querySelectorAll('button,a,input[type=submit],input[type=button]')].filter(ok);
    // 1순위: 폼을 제출하는 submit 버튼(실제 "다음" 버튼)
    const subs = c.filter(e => e.getAttribute('type') === 'submit' || (e.tagName === 'BUTTON' && !e.getAttribute('type') && e.form));
    const subNext = subs.filter(e => /^다음/.test(txt(e)) || txt(e) === '');
    if (subNext.length) return subNext[subNext.length - 1];
    if (subs.length) return subs[subs.length - 1];
    // 2순위: 글자가 정확히 "다음"(+화살표)인 버튼
    return c.find(e => /^다음[>›»]?$/.test(txt(e))) || null;
  };
  let unloading = false;
  addEventListener('beforeunload', () => { unloading = true; });
  addEventListener('pagehide', () => { unloading = true; });
  const clickNext = async () => {
    const n = await waitFor(findNext, 3000, 20);
    if (!n) { log('다음 버튼을 못 찾음'); report('다음 버튼 못 찾음'); beep(); return false; }
    const before = location.href;
    log('다음 버튼 클릭: <' + n.tagName.toLowerCase() + ' type=' + (n.getAttribute('type') || '-') + '>');
    n.scrollIntoView({ block: 'center' });
    n.click();
    await sleep(2500); // 서버가 느려도 이미 이동 중이면 두 번 제출하지 않도록 넉넉히 기다림
    if (!unloading && location.href === before && n.form) { log('클릭이 안 먹혀 폼 제출 재시도'); try { n.form.requestSubmit(n); } catch { n.form.submit(); } }
    return true;
  };

  /* ---------- 상태 표시 패널 ---------- */
  const panel = document.createElement('div');
  panel.setAttribute('data-cjm-panel', '1');
  panel.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;background:#111c;color:#fff;font:13px/1.4 sans-serif;padding:8px 10px;border-radius:8px;max-width:340px';
  const status = document.createElement('div');
  const note = document.createElement('div');
  note.style.cssText = 'color:#ffd54f;margin-top:4px';
  const resBox = document.createElement('div');
  resBox.style.cssText = 'margin-top:4px;white-space:pre-line;font-size:12px';
  const bar = document.createElement('div');
  bar.style.marginTop = '6px';
  panel.append(status, note, resBox, bar);
  document.body.appendChild(panel);
  document.documentElement.setAttribute('data-cjm-worker', workerDead ? 'off' : 'on');
  if (workerDead) note.textContent = '⚠ 이 사이트에서는 Worker 타이머를 쓸 수 없어요. 백그라운드 탭의 타이머가 느려질 수 있으니 탭을 앞에 두세요.';
  function log(m) { status.textContent = `[예약도우미${myDate() ? ' ' + myDate().slice(5) : ''}] ` + m; console.log('[예약도우미]', m); }
  function addBtn(label, fn) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'margin:2px 6px 2px 0;padding:3px 8px;cursor:pointer';
    b.onclick = fn; bar.appendChild(b);
    return b;
  }
  const beep = () => { try { const c = new AudioContext(), o = c.createOscillator(); o.connect(c.destination); o.frequency.value = 880; o.start(); setTimeout(() => o.stop(), 600); } catch {} };

  // 모든 탭의 결과를 한 줄씩 표시
  const renderResults = () => {
    try {
      const rows = Object.keys(localStorage).filter(k => k.startsWith(RES_PREFIX)).sort()
        .map(k => `${k.slice(RES_PREFIX.length + 5)}  ${JSON.parse(localStorage.getItem(k)).s}`);
      resBox.textContent = rows.length ? rows.join('\n') : '';
    } catch {}
  };
  renderResults(); setInterval(renderResults, 1000);

  /* ---------- 날짜 계산 / 페이지에서 값 읽기 ---------- */
  const parseOpenAt = () => {
    const m = pageText().match(/접수기간\s*(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
    return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+09:00`).getTime() : 0;
  };
  const parseMonth = () => { const m = pageText().match(/시설예약기간\s*(\d{4})-(\d{2})-\d{2}/); return m ? `${m[1]}-${m[2]}` : ''; };
  const resolveOpenAt = () => CFG.OPEN_AT === 'auto' ? parseOpenAt() : (CFG.OPEN_AT ? new Date(CFG.OPEN_AT.replace(' ', 'T') + '+09:00').getTime() : 0);
  function datesFor(month) {
    if (CFG.TARGET_DATES.length) return CFG.TARGET_DATES.filter(d => !CFG.SKIP_DATES.includes(d));
    const [y, m] = month.split('-').map(Number);
    const out = [], n = new Date(y, m, 0).getDate(), p = v => String(v).padStart(2, '0');
    for (let d = 1; d <= n; d++) if (new Date(y, m - 1, d).getDay() === CFG.WEEKDAY) out.push(`${y}-${p(m)}-${p(d)}`);
    return out.filter(d => !CFG.SKIP_DATES.includes(d));
  }

  /* ---------- 탭 열기 (날짜 1개 = 탭 1개) ---------- */
  // 별도 팝업 창으로 타일 배치 → 모든 창이 화면에 보여 백그라운드 스로틀링을 피함
  const openChild = (d, i, startedAt, openAt) => {
    const W = screen.availWidth, H = screen.availHeight, cols = Math.min(3, CFG.MAX_TABS), rows = Math.ceil(CFG.MAX_TABS / cols);
    const w = Math.floor(W / cols), h = Math.floor(H / rows);
    const f = `popup=yes,width=${w},height=${h},left=${(i % cols) * w},top=${Math.floor(i / cols) * h}`;
    return !!window.open(location.origin + location.pathname + location.search + `#cjm=${d}&t=${startedAt}&i=${i}&o=${openAt}`, 'cjm_' + d, f);
  };

  addBtn('중지(전체)', () => { setState({ ...(getState() || {}), armed: false }); localStorage.setItem(STOP_KEY, String(Date.now())); log('중지됨 (모든 탭)'); });
  if (path.endsWith('selectFcltyWebView.do') && ROLE !== 'child') {
    addBtn('▶ 시작(대기)', () => {
      const month = CFG.TARGET_DATES.length ? '' : (CFG.TARGET_MONTH === 'auto' ? parseMonth() : CFG.TARGET_MONTH);
      if (!CFG.TARGET_DATES.length && !month) { log('시설예약기간을 못 읽었어요 — CFG.TARGET_MONTH를 직접 지정하세요'); return; }
      const openAt = resolveOpenAt();
      if (CFG.OPEN_AT === 'auto' && !openAt) { log('접수기간을 못 읽었어요 — CFG.OPEN_AT을 직접 지정하세요'); return; }
      let dates = datesFor(month);
      if (!dates.length) { log('대상 날짜가 없어요 — CFG(월/요일/날짜)를 확인하세요'); return; }
      if (!CFG.PARALLEL) dates = dates.slice(0, 1);
      if (dates.length > CFG.MAX_TABS) { log(`날짜가 ${dates.length}개라 MAX_TABS(${CFG.MAX_TABS})를 넘어요`); return; }
      const startedAt = Date.now();
      Object.keys(localStorage).filter(k => k.startsWith(RES_PREFIX)).forEach(k => localStorage.removeItem(k));
      const st = { armed: true, tries: 0, role: 'main', idx: 0, date: dates[0], startedAt, openAt, pending: [] };
      dates.slice(1).forEach((d, i) => { if (!openChild(d, i + 1, startedAt, openAt)) st.pending.push({ d, i: i + 1 }); });
      setState(st);
      location.reload();
    });
  }
  // 팝업이 막혀서 못 연 탭은 버튼으로 하나씩 열기 (버튼 클릭은 팝업이 허용됨)
  {
    const s0 = getState();
    if (s0?.pending?.length) {
      note.textContent = '⚠ 팝업이 차단돼 일부 탭을 못 열었어요. 아래 "탭 열기"를 누르세요 (주소창 오른쪽 팝업 차단 아이콘에서 이 사이트를 허용하면 다음부터 자동으로 열려요)';
      s0.pending.forEach(p => {
        const b = addBtn(`탭 열기 ${p.d.slice(5)}`, () => {
          const s = getState();
          if (openChild(p.d, p.i, s.startedAt, s.openAt)) {
            b.remove();
            setState({ ...s, pending: (s.pending || []).filter(x => x.d !== p.d) });
            if (!(getState().pending || []).length) note.textContent = '';
          } else log('팝업이 차단됐어요 — 주소창 오른쪽의 팝업 차단 아이콘에서 허용하세요');
        });
      });
    }
  }

  /* ---------- 서버시간 동기화 (navyism 방식) ----------
     대상 사이트가 응답에 실어 보내는 Date 헤더(초 단위로 잘린 서버 시각)를 여러 번 받아서
     "서버시각 - PC시각" 오프셋을 구한다.
       1) 요청 한 번마다 오프셋이 들어갈 구간 [S - 수신시각, S + 1초 - 송신시각] 을 얻고
       2) 구간이 가장 많이 겹치는 곳을 고르고
       3) 서버의 '초가 바뀌는 순간'에 맞춰 요청을 보내 구간을 이분탐색으로 좁힌다. */
  const now = () => performance.timeOrigin + performance.now(); // PC 시각(ms, 단조 증가)
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

  const loadSync = () => { try { const s = JSON.parse(localStorage.getItem(SYNC_KEY) || 'null'); return s && Date.now() - s.at < 10 * 60 * 1000 ? s : null; } catch { return null; } };
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
      SYNC = r; localStorage.setItem(SYNC_KEY, JSON.stringify(r)); // 다른 탭과 공유
      log(`서버시간 동기화 완료: ${fmtOfs()}, 왕복 ${Math.round(r.rtt)}ms, 샘플 ${r.n}개`);
    } else log('서버시간 측정 실패 — PC 시계로 진행');
    return r;
  }
  addBtn('⏱ 서버시간 측정', () => doSync('서버시간 측정 중...'));

  /* ---------- 1단계: 상세 페이지에서 신청하기 ---------- */
  async function stepDetail() {
    setState({ ...getState(), detailUrl: location.pathname + location.search });
    const st = getState();
    const openAt = st.openAt || 0;
    const idx = st.idx || 0;
    report('대기');
    if (openAt) {
      if (ROLE === 'main') {
        // 처음 한 번 측정, 오픈까지 1분 넘게 남았으면 오픈 25초 전에 한 번 더 측정
        if (!SYNC && openAt - serverNow() > 3000) await doSync('서버시간 측정 중...');
        if (openAt - serverNow() > 60000) {
          while (armed() && openAt - serverNow() > 25000) {
            log(`대기 ${Math.round((openAt - serverNow()) / 1000)}초 | 서버 ${fmtT(serverNow())} | ${fmtOfs()}`);
            await sleep(250);
          }
          if (!armed()) return;
          await doSync('오픈 직전 재측정...');
        }
      } else if (openAt - serverNow() > 3000) {
        // 자식 탭: 메인 탭이 잰 서버시간을 공유받음 (없으면 직접 측정)
        log('메인 탭의 서버시간 측정 대기...');
        const got = await waitFor(() => { const s = loadSync(); if (s) SYNC = s; return s; }, 40000, 100);
        if (!got && armed()) await doSync('서버시간 측정 중(단독)...');
      }
    }
    // 왕복시간의 절반만큼 일찍 보내면 서버에는 정각에 도착. 탭마다 STAGGER_MS씩 간격을 둠
    const lead = CFG.LEAD_MS == null ? Math.round((SYNC?.rtt || 0) / 2) : CFG.LEAD_MS;
    const target = openAt ? openAt - lead + CFG.STAGGER_MS * idx : 0;
    while (openAt && serverNow() < target - 150) {
      if (!armed()) return;
      const s = loadSync(); if (s) SYNC = s; // 메인 탭의 재측정 값 반영
      log(`대기 ${Math.max(0, Math.round((openAt - serverNow()) / 100) / 10)}초 | 서버 ${fmtT(serverNow())} | ${fmtOfs()}`);
      await sleep(serverNow() < target - 2000 ? 100 : 5);
    }
    if (!armed()) return;
    // 정확한 시각까지 짧게 busy-wait
    while (openAt && serverNow() < target) { await sleep(0); }
    const clickedAt = serverNow();
    const btn = await waitFor(() => btnByText(/^신청하기$/), 1500, 10);
    if (btn) { btn.click(); report('신청 중'); log(`신청하기 클릭 @서버 ${fmtT(clickedAt)}`); console.log('[예약도우미] 클릭 시각(서버)', fmtT(clickedAt), '목표', openAt ? fmtT(openAt) : '-'); }
    await sleep(CFG.RELOAD_GAP_MS + 450);
    // 아직 이 페이지면(오픈 전이거나 막힘) 새로고침 후 재시도
    if (armed() && location.pathname.endsWith('selectFcltyWebView.do')) {
      const tries = (getState()?.tries || 0) + 1;
      if (tries > CFG.MAX_RELOAD) { setState({ ...getState(), armed: false }); report('신청 페이지가 안 열림 — 재시도 한도 초과'); log('재시도 한도 초과 — 중지'); return; }
      setState({ ...getState(), armed: true, tries });
      location.reload();
    }
  }

  /* ---------- 2단계: 달력에서 날짜/시간/동의 ---------- */
  async function stepCalendar() {
    const [Y, M, D] = myDate().split('-').map(Number);
    // 월 맞추기
    for (let i = 0; i < 12; i++) {
      const head = document.body.innerText.match(/(\d{4})년\s*(\d{1,2})월/);
      if (!head) { await sleep(30); continue; }
      const cur = (+head[1]) * 12 + (+head[2]), want = Y * 12 + M;
      if (cur === want) break;
      const b = btnByText(cur < want ? /다음달/ : /이전달/);
      if (!b) { log('월 이동 버튼을 못 찾음'); report('월 이동 실패'); return; }
      b.click(); await sleep(40);
    }
    // 날짜 클릭
    const dayBtn = await waitFor(() => [...document.querySelectorAll('button')].find(b => {
      if (b.disabled || !/\d+\/\d+/.test(b.innerText)) return false;
      const first = b.firstElementChild ? b.firstElementChild.textContent.trim() : (b.innerText.match(/^\d{1,2}/) || [''])[0];
      return +first === D;
    }), 4000);
    if (!dayBtn) { log(`${myDate()} 날짜 버튼 없음/비활성`); report('날짜 버튼 없음/비활성'); beep(); return; }
    dayBtn.click(); log('날짜 선택');

    // 시간대 선택 (우선순위대로)
    let picked = null;
    const t0 = performance.now();
    while (!picked && performance.now() - t0 < 4000) {
      for (const slot of CFG.SLOTS) {
        const row = [...document.querySelectorAll('li')].find(li => norm(li.textContent).includes(norm(slot)) && li.textContent.includes('예약가능'));
        if (row) { picked = { slot, row }; break; }
      }
      if (!picked) await sleep(20);
    }
    if (!picked) { log('원하는 시간대가 모두 마감 — 중지'); report('❌ 마감 (원하는 시간대 없음)'); setState({ ...getState(), armed: false }); beep(); return; }
    const cb = picked.row.querySelector('input[type=checkbox],input[type=radio]');
    if (cb) { if (!cb.checked) (picked.row.querySelector('label') || cb).click(); if (!cb.checked) cb.click(); }
    else picked.row.click();
    log('시간 선택: ' + picked.slot);

    // 약관 동의: "모두 동의" 라디오 → 필수 항목은 value="Y"(동의함) 라디오를 직접 선택
    const all = await waitFor(() => document.querySelector('input[type=radio]'), 3000);
    const agreeAll = [...document.querySelectorAll('input[type=radio]')].find(r => /모든\s*약관/.test((r.closest('label,li,div')?.textContent) || ''));
    (agreeAll || all)?.click();
    await sleep(30);
    document.querySelectorAll('input[type=radio][value=Y]').forEach(r => { if (!r.checked) r.click(); });
    await sleep(30);
    const okAll = [...document.querySelectorAll('input[type=radio][value=Y]')].every(r => r.checked);
    log(okAll ? '약관 동의 완료 → 다음' : '약관 일부 체크 실패 → 그래도 다음 시도');
    report('정보 입력 단계로 이동 중 (' + picked.slot + ')');

    await clickNext();
  }

  /* ---------- 3단계: 신청자 정보 입력 ---------- */
  const rowOf = label => [...document.querySelectorAll('tr,li,dl,div')].filter(e => {
    const h = e.querySelector('th,dt,label,strong,span');
    return h && norm(h.textContent).startsWith(label) && e.querySelector('input,select');
  }).sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0];

  async function stepInfo() {
    await waitFor(() => document.querySelector('input[type=text],input:not([type])'), 4000);
    const g = document.querySelector('input[placeholder*="단체명"]') || rowOf('단체명')?.querySelector('input');
    const p = rowOf('신청인원')?.querySelector('input');
    const mails = rowOf('이메일')?.querySelectorAll('input[type=text],input:not([type])');
    if (!g || !p || !mails || mails.length < 2) { log('입력칸을 못 찾음 — 직접 입력하세요'); report('입력칸 못 찾음 — 직접 입력 필요'); beep(); return; }
    setVal(g, CFG.GROUP); setVal(p, CFG.PEOPLE);
    setVal(mails[0], CFG.EMAIL_ID); setVal(mails[1], CFG.EMAIL_DOMAIN);
    log('정보 입력 완료');
    if (CFG.DRY_RUN) { log('DRY_RUN: 마지막 "다음" 직전에서 멈춤 (실제 신청 안 됨)'); report('DRY_RUN 정지 (신청 직전)'); setState({ ...getState(), armed: false }); beep(); return; }
    log('최종 다음 → 신청'); report('최종 신청 중');
    await clickNext();
  }

  /* ---------- 4단계: 완료 ---------- */
  function stepDone() {
    setState({ ...getState(), armed: false });
    const no = (pageText().match(/FCT\d+-\d+-\d+/) || [''])[0];
    report('✅ 완료 ' + no);
    log('✅ 예약 신청 완료 화면입니다. 예약번호/입금 확인하세요!');
    beep();
  }

  /* ---------- 라우팅 ---------- */
  (async () => {
    if (armed() && /페이지를\s*찾을\s*수\s*없|Sorry, the page you tried cannot be found/.test(pageText())) {
      // 신청 도중 오류 페이지(404)로 빠진 경우: 상세 페이지로 돌아가 이 날짜를 처음부터 다시 시도
      const st = getState() || {}, n = (st.recover || 0) + 1, url = st.detailUrl;
      if (url && n <= 5) { setState({ ...st, recover: n, tries: 0 }); log(`오류 페이지 감지 — 처음부터 재시도 (${n}/5)`); await sleep(300 + 250 * n); location.replace(url); return; }
      report('오류 페이지 — 복구 실패, 직접 확인 필요'); beep(); return;
    }
    if (!armed()) { log('대기(시작 전)' + (SYNC ? ' | 서버시간 ' + fmtOfs() : '')); return; }
    if (path.endsWith('selectFcltyWebView.do')) return stepDetail();
    if (path.endsWith('fcltyApplCalendarWebView.do')) return stepCalendar();
    if (path.endsWith('addFcltyApplWebView.do')) return stepInfo();
    if (path.endsWith('addFcltyApplWebSuccess.do')) return stepDone();
  })();
})();
