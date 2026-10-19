// ==UserScript==
// @name         청주 통합예약 - 흥덕축구공원 예약 도우미 (prototype)
// @namespace    local.cheongju.reserve
// @version      0.5
// @description  접수 시작 시각에 맞춰 신청하기 → 날짜/시간 선택 → 약관동의 → 정보입력 → 다음을 자동으로 진행
// @match        https://ticket.cheongju.go.kr/www/*
// @run-at       document-end
// @grant        none
// ==/UserScript==
(() => {
  'use strict';

  /* ================= 설정 (여기만 고치세요) ================= */
  const CFG = {
    // 접수 시작 시각 (PC 시계 기준). 빈 문자열('')이면 시작 버튼 누르는 즉시 진행(테스트용)
    OPEN_AT: '',//2026-11-19 09:00:00

    // 예약할 날짜, 그리고 우선순위 순서의 시간대 (앞에서부터 '예약가능'이면 선택)
    TARGET_DATE: '2026-11-09',
    SLOTS: ['14:30 ~ 16:30', '16:30 ~ 18:30'],

    // 신청자 정보 (영상에서 입력하던 값)
    GROUP: '단체명',
    PEOPLE: '1',
    EMAIL_ID: 'your_id',
    EMAIL_DOMAIN: 'gmail.com',

    // true: 마지막 "다음"(= 실제 예약 신청) 직전에 멈춤. 처음엔 반드시 true로 테스트하세요.
    DRY_RUN: true,

    MAX_RELOAD: 150,   // 오픈 직후 신청하기가 안 열릴 때 새로고침 최대 횟수
    RELOAD_GAP_MS: 350 // 새로고침 간격(너무 짧게 줄이지 마세요)
  };
  /* ========================================================= */

  const KEY = 'cjm_state';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => (s || '').replace(/\s+/g, '');
  const path = location.pathname;
  const getState = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { return null; } };
  const setState = s => sessionStorage.setItem(KEY, JSON.stringify(s));
  const armed = () => !!getState()?.armed;

  // 알림창이 뜨면 자동화가 멈추므로 무시하고 로그만 남김
  window.alert = m => { log('alert: ' + m); };
  window.confirm = m => { log('confirm: ' + m); return true; };

  const waitFor = (fn, ms = 4000, step = 15) => new Promise(res => {
    const t0 = performance.now();
    (function tick() {
      let v; try { v = fn(); } catch { v = null; }
      if (v) return res(v);
      if (performance.now() - t0 > ms) return res(null);
      setTimeout(tick, step);
    })();
  });
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
    const ok = e => e.getClientRects().length > 0 && !e.closest('header,nav') &&!/다음달|이전달|달력/.test(txt(e)) && !e.closest('[class*=calendar]');
    const c = [...document.querySelectorAll('button,a,input[type=submit],input[type=button]')].filter(ok);
    // 1순위: 폼을 제출하는 submit 버튼(실제 "다음" 버튼)
    const subs = c.filter(e => e.getAttribute('type') === 'submit' || (e.tagName === 'BUTTON' && !e.getAttribute('type') && e.form));
    const subNext = subs.filter(e => /^다음/.test(txt(e)) || txt(e) === '');
    if (subNext.length) return subNext[subNext.length - 1];
    if (subs.length) return subs[subs.length - 1];
    // 2순위: 글자가 정확히 "다음"(+화살표)인 버튼
    return c.find(e => /^다음[>›»]?$/.test(txt(e))) || null;
  };
  const clickNext = async () => {
    const n = await waitFor(findNext, 3000, 20);
    if (!n) { log('다음 버튼을 못 찾음'); beep(); return false; }
    const before = location.href;
    log('다음 버튼 클릭: <' + n.tagName.toLowerCase() + ' type=' + (n.getAttribute('type') || '-') + '>');
    n.scrollIntoView({ block: 'center' });
    n.click();
    await sleep(900);
    if (location.href === before && n.form) { log('클릭이 안 먹혀 폼 제출 재시도'); try { n.form.requestSubmit(n); } catch { n.form.submit(); } }
    return true;
  };

  /* ---------- 상태 표시 패널 ---------- */
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;background:#111c;color:#fff;font:13px/1.4 sans-serif;padding:8px 10px;border-radius:8px;max-width:320px';
  const status = document.createElement('div');
  const bar = document.createElement('div');
  bar.style.marginTop = '6px';
  panel.append(status, bar);
  document.body.appendChild(panel);
  function log(m) { status.textContent = '[예약도우미] ' + m; console.log('[예약도우미]', m); }
  function addBtn(label, fn) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'margin-right:6px;padding:3px 8px;cursor:pointer';
    b.onclick = fn; bar.appendChild(b);
  }
  const beep = () => { try { const c = new AudioContext(), o = c.createOscillator(); o.connect(c.destination); o.frequency.value = 880; o.start(); setTimeout(() => o.stop(), 600); } catch {} };

  addBtn('중지', () => { setState({ armed: false }); log('중지됨'); });
  if (path.endsWith('selectFcltyWebView.do')) {
    addBtn('▶ 시작(대기)', () => { setState({ armed: true, tries: 0 }); location.reload(); });
  }

  /* ---------- 1단계: 상세 페이지에서 신청하기 ---------- */
  async function stepDetail() {
    const st = getState();
    const openAt = CFG.OPEN_AT ? new Date(CFG.OPEN_AT.replace(' ', 'T') + '+09:00').getTime() : 0;
    while (Date.now() < openAt - 150) {
      if (!armed()) return;
      const s = Math.max(0, Math.round((openAt - Date.now()) / 1000));
      log(`대기 중... ${s}초 후 시작`);
      await sleep(openAt - Date.now() > 2000 ? 250 : 5);
    }
    if (!armed()) return;
    // 정확한 시각까지 짧게 busy-wait
    while (Date.now() < openAt) { await sleep(1); }
    const btn = await waitFor(() => btnByText(/^신청하기$/), 1500, 10);
    if (btn) { log('신청하기 클릭'); btn.click(); }
    await sleep(CFG.RELOAD_GAP_MS + 450);
    // 아직 이 페이지면(오픈 전이거나 막힘) 새로고침 후 재시도
    if (armed() && location.pathname.endsWith('selectFcltyWebView.do')) {
      const tries = (st?.tries || 0) + 1;
      if (tries > CFG.MAX_RELOAD) { setState({ armed: false }); log('재시도 한도 초과 — 중지'); return; }
      setState({ armed: true, tries });
      location.reload();
    }
  }

  /* ---------- 2단계: 달력에서 날짜/시간/동의 ---------- */
  async function stepCalendar() {
    const [Y, M, D] = CFG.TARGET_DATE.split('-').map(Number);
    // 월 맞추기
    for (let i = 0; i < 12; i++) {
      const head = document.body.innerText.match(/(\d{4})년\s*(\d{1,2})월/);
      if (!head) { await sleep(30); continue; }
      const cur = (+head[1]) * 12 + (+head[2]), want = Y * 12 + M;
      if (cur === want) break;
      const b = btnByText(cur < want ? /다음달/ : /이전달/);
      if (!b) { log('월 이동 버튼을 못 찾음'); return; }
      b.click(); await sleep(40);
    }
    // 날짜 클릭
    const dayBtn = await waitFor(() => [...document.querySelectorAll('button')].find(b => {
      if (b.disabled || !/\d+\/\d+/.test(b.innerText)) return false;
      const first = b.firstElementChild ? b.firstElementChild.textContent.trim() : (b.innerText.match(/^\d{1,2}/) || [''])[0];
      return +first === D;
    }), 4000);
    if (!dayBtn) { log(`${CFG.TARGET_DATE} 날짜 버튼 없음/비활성`); beep(); return; }
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
    if (!picked) { log('원하는 시간대가 모두 마감 — 중지'); setState({ armed: false }); beep(); return; }
    const cb = picked.row.querySelector('input[type=checkbox],input[type=radio]');
    if (cb) { if (!cb.checked) (picked.row.querySelector('label') || cb).click(); if (!cb.checked) cb.click(); }
    else picked.row.click();
    log('시간 선택: ' + picked.slot);

    // 약관 동의: "모두 동의" 라디오 → 그래도 안 된 필수 항목은 첫 번째(동의함) 선택
    const all = await waitFor(() => document.querySelector('input[type=radio]'), 3000);
    const agreeAll = [...document.querySelectorAll('input[type=radio]')].find(r => /모든\s*약관/.test((r.closest('label,li,div')?.textContent) || ''));
    (agreeAll || all)?.click();
    await sleep(30);
    // 필수 동의 항목은 value="Y"(동의함) 라디오를 직접 선택
    document.querySelectorAll('input[type=radio][value=Y]').forEach(r => { if (!r.checked) r.click(); });
    await sleep(30);
    const okAll = [...document.querySelectorAll('input[type=radio][value=Y]')].every(r => r.checked);
    log(okAll ? '약관 동의 완료 → 다음' : '약관 일부 체크 실패 → 그래도 다음 시도');

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
    if (!g || !p || !mails || mails.length < 2) { log('입력칸을 못 찾음 — 직접 입력하세요'); beep(); return; }
    setVal(g, CFG.GROUP); setVal(p, CFG.PEOPLE);
    setVal(mails[0], CFG.EMAIL_ID); setVal(mails[1], CFG.EMAIL_DOMAIN);
    log('정보 입력 완료');
    if (CFG.DRY_RUN) { log('DRY_RUN: 마지막 "다음" 직전에서 멈춤 (실제 신청 안 됨)'); setState({ armed: false }); beep(); return; }
    log('최종 다음 → 신청');
    await clickNext();
  }

  /* ---------- 4단계: 완료 ---------- */
  function stepDone() {
    setState({ armed: false });
    log('✅ 예약 신청 완료 화면입니다. 예약번호/입금 확인하세요!');
    beep();
  }

  /* ---------- 라우팅 ---------- */
  (async () => {
    if (!armed()) { log('대기(시작 전)'); return; }
    if (path.endsWith('selectFcltyWebView.do')) return stepDetail();
    if (path.endsWith('fcltyApplCalendarWebView.do')) return stepCalendar();
    if (path.endsWith('addFcltyApplWebView.do')) return stepInfo();
    if (path.endsWith('addFcltyApplWebSuccess.do')) return stepDone();
  })();
})();
