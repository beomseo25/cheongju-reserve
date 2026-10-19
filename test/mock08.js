// 실전 가정 모의 사이트 (v0.8 검증용)
//  - 신청하기 → NetFUNNEL 흉내(순번대기 오버레이, 접수 시각 이후 초당 RATE명 입장, 경쟁자 BOTS명)
//  - 접수 전 달력 진입 → alert + history.back()
//  - 접수 직후 부하: 응답 지연(지수분포), 503 페이지, 연결 끊김(브라우저 오류 페이지), AJAX 500
//  - 경쟁자가 날짜별로 슬롯을 선점 (첫 날짜는 0.4초 만에 뺏김 → ❌가 정답)
//  - 달력→정보입력→완료 모두 POST (정보입력 페이지를 GET으로 열면 404)
// 사용: node mock08.js <script.user.js> [seed] [dry]
const http = require('http'), fs = require('fs');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const SEED = +(process.argv[3] || 1), DRY = process.argv[4] === 'dry';
let rs = SEED * 9301 + 49297; const rnd = () => (rs = (rs * 9301 + 49297) % 233280) / 233280;
const SERVER_AHEAD = 9280; // 실제 측정치처럼 서버가 PC보다 9.28초 빠름
const srvNow = () => Date.now() + SERVER_AHEAD;
const openMs = Math.ceil((srvNow() + 30000) / 1000) * 1000;
const kstFull = ms => new Date(ms + 9 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
const DATES = ['2026-12-06', '2026-12-13', '2026-12-20', '2026-12-27'];
const SLOTS = ['06:30 ~ 08:30', '08:30 ~ 10:30', '10:30 ~ 12:30'];
// 경쟁자 선점 시각 (open 기준 ms)
const takeAt = {};
// 첫 날짜 06:30은 0.4초 만에 뺏김(❌가 정답). 나머지는 빠른 경쟁자(매크로) 6~15초, 보통 사람 15~60초
DATES.forEach((d, i) => SLOTS.forEach((s, j) => { takeAt[d + '|' + s] = (i === 0 && j === 0) ? 400 : (rnd() < 0.5 ? 6000 + rnd() * 9000 : 15000 + rnd() * 45000); }));
const taken = {}; // d|s -> 'bot' | 'me'
const isFree = (d, s) => !taken[d + '|' + s] && !(srvNow() >= openMs + takeAt[d + '|' + s]);
const bookings = [], events = [];
const ev = m => { events.push(`${((srvNow() - openMs) / 1000).toFixed(2)}s ${m}`); };
// --- 부하 모델 ---
const loaded = () => srvNow() >= openMs && srvNow() < openMs + 40000;
const delay = () => loaded() ? Math.min(4000, 80 + -Math.log(1 - rnd()) * 600) : 15;
// --- NetFUNNEL 대기열 ---
const RATE = 6, BOTS = 30; let nextAdmit = 0; const botTimes = [...Array(BOTS)].map(() => openMs - 200 + rnd() * 1700).sort((a, b) => a - b);
let botIdx = 0;
function admitTime(arrival) {
  if (arrival < openMs) return arrival; // 접수 전엔 한산
  while (botIdx < BOTS && botTimes[botIdx] <= arrival) { nextAdmit = Math.max(nextAdmit, botTimes[botIdx], openMs) + 1000 / RATE; botIdx++; }
  const t = Math.max(arrival, nextAdmit, openMs); nextAdmit = t + 1000 / RATE; return t;
}
const form = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(new URLSearchParams(b))); });
const page = {
  detail: () => `<html><head><title>체육시설과 | 청주시 통합예약</title></head><body><h1>흥덕축구공원(축구1구장) - 12월 예약</h1>
<table><tr><th>접수기간</th><td>${kstFull(openMs).slice(0, 16)} ~ 2026-12-31 22:30</td></tr><tr><th>시설예약기간</th><td>2026-12-01 ~ 2026-12-31</td></tr></table>
<a href="#">로그아웃</a> <a class="anchorButton" href="./fcltyApplCalendarWebView.do?fcltyNo=2379" onclick="applStart(this.href); return false;">신청하기</a>
<script>
function applStart(url){ if(window.__nf) return; window.__nf=1;
  const ov=document.createElement('div'); ov.id='overlay-nf123'; ov.innerHTML='<div id="nf-vwr-live-message">접속 대기 중입니다</div>'; ov.style.cssText='position:fixed;inset:0;background:#0008;color:#fff;font-size:30px;padding-top:40vh;text-align:center';
  fetch('/nf/enter').then(r=>r.json()).then(j=>{ if(j.wait>200) document.body.appendChild(ov); setTimeout(()=>{ location.href=url; }, j.wait); }).catch(()=>{ location.href=url; });
}</script></body></html>`,
  notOpen: () => `<html><body><script>alert('접수기간이 아닙니다.'); history.back();</script></body></html>`,
  calendar: () => `<html><head><title>체육시설과 | 청주시 통합예약</title></head><body><div class="calendar"><div class="head"><button type="button" id="prev"><span>이전달 달력 보기</span></button><strong id="ym"></strong><button type="button" id="next"><span>다음달 달력 보기</span></button></div><ul id="days"></ul></div>
<ul class="timeList" id="slots"></ul>
<form id="fcltyApplVO" method="post" action="./addFcltyApplWebView.do" onsubmit="return chk(this)">
<input type="hidden" name="fcltyDe"><input type="hidden" name="applDtTm">
<div class="privacyAgreement"><label><input type="radio" id="all" name="all" value="on"> 모든 약관에 동의합니다.</label>
<div>개인정보 수집 및 이용 동의 <label><input type="radio" id="agree1-1" name="agree1" value="Y"> 동의함</label> <label><input type="radio" name="agree1" value="N"> 동의하지 않음</label></div>
<div>개인정보 제3자 제공 동의 <label><input type="radio" id="agree2-1" name="agree2" value="Y"> 동의함</label> <label><input type="radio" name="agree2" value="N"> 동의하지 않음</label></div></div>
<div class="btns"><button type="button"><span>이전</span></button><button type="submit"><span class="ico"></span></button></div></form>
<script>
let y=2026,m=10; const P=n=>String(n).padStart(2,'0');
document.getElementById('all').onclick=()=>{document.getElementById('agree1-1').checked=true;document.getElementById('agree2-1').checked=true;};
function chk(f){ if(!f.fcltyDe.value){alert('시설예약일자를 선택해주세요.');return false;} if(!document.querySelector('input[name=fcltySchdNoArr]:checked')){alert('이용하실 시간을 선택해주세요.');return false;} if(f.agree1.value!=='Y'){alert('개인정보 수집 및 이용에 동의해주세요.');return false;} if(f.agree2.value!=='Y'){alert('개인정보 제3자 제공에 동의해주세요.');return false;} return true; }
async function render(){ document.getElementById('ym').textContent=y+'년 '+m+'월'; const ul=document.getElementById('days'); ul.innerHTML='';
  let cnt; try{ const r=await fetch('./fcltyApplCalendarAjax.do?ym='+y+P(m)); if(!r.ok) throw 0; cnt=await r.json(); }catch(e){ alert('에러가 발생하였습니다.'); return; }
  const n=new Date(y,m,0).getDate(); for(let d=1;d<=n;d++){ const li=document.createElement('li'); const b=document.createElement('button'); b.type='button'; b.disabled=!(y==2026&&m==12); b.innerHTML='<span class="day">'+d+'</span><span>'+(cnt[d]||0)+'/3</span>'; b.onclick=()=>pick(y+'-'+P(m)+'-'+P(d)); li.appendChild(b); ul.appendChild(li);} }
document.getElementById('prev').onclick=()=>{m--;if(m<1){m=12;y--;}render();};
document.getElementById('next').onclick=()=>{m++;if(m>12){m=1;y++;}render();};
async function pick(date){ document.forms.fcltyApplVO.fcltyDe.value=date; const ul=document.getElementById('slots'); ul.innerHTML='';
  let r; try{ const res=await fetch('./fcltyApplTimeListAjax.do?date='+date); if(!res.ok) throw 0; r=await res.json(); }catch(e){ alert('에러가 발생하였습니다.'); return; }
  ul.innerHTML=''; r.forEach((s,i)=>{ const li=document.createElement('li'); li.innerHTML='<label><input type="checkbox" name="fcltySchdNoArr" value="'+i+'"><span>'+s.t+'</span></label><span>'+(s.free?'예약가능':'예약완료')+'</span>'; const cb=li.querySelector('input'); cb.disabled=!s.free; cb.onchange=()=>{document.forms.fcltyApplVO.applDtTm.value=cb.checked?s.t:'';}; ul.appendChild(li); }); }
render();
</script></body></html>`,
  info: q => `<html><head><title>체육시설과 | 청주시 통합예약</title></head><body><form method="post" action="./addFcltyAppl.do">
<input type="hidden" name="fcltyDe" value="${q.get('fcltyDe')}"><input type="hidden" name="applDtTm" value="${q.get('applDtTm')}">
<h3>시설예약 정보</h3><p>시설예약일자 ${q.get('fcltyDe')} / 예약시간 ${q.get('applDtTm')}</p>
<table><tr><th>이름</th><td>홍길동</td></tr><tr><th>단체명 *</th><td><input name="group" placeholder="단체명을 입력해주세요."></td></tr>
<tr><th>신청인원 *</th><td><input name="people"> 명</td></tr>
<tr><th>이메일</th><td><input type="text" name="m1"><span>@</span><input type="text" name="m2"><select><option>직접입력</option></select></td></tr>
<tr><th>결제방법 *</th><td><select><option>무통장입금</option></select></td></tr></table>
<div class="btns"><button type="button"><span>이전</span></button><button type="submit"><span>다음</span></button></div></form></body></html>`,
  done: no => `<html><body><h2>예약신청완료</h2><table><tr><th>예약번호</th><td>${no}</td></tr></table></body></html>`,
  taken: () => `<html><body><script>alert('이미 예약이 완료된 시간입니다.'); history.back();</script></body></html>`,
  e404: () => `<html><body><h1>웹 페이지를 찾을 수 없습니다!</h1><p>Sorry, the page you tried cannot be found.</p></body></html>`,
  e503: () => `<html><body><h1>Service Unavailable</h1><p>The server is temporarily unable to service your request.</p></body></html>`
};
let nCut = 0, n503 = 0, n500 = 0;
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname;
  const body = req.method === 'POST' ? await form(req) : null;
  const isHtml = /WebView\.do|addFcltyAppl\.do/.test(p), isAjax = /Ajax\.do/.test(p);
  if (p !== '/www/index.do' && p !== '/nf/enter') await new Promise(r => setTimeout(r, delay()));
  res.setHeader('Date', new Date(srvNow()).toUTCString());
  const html = (s, code = 200) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(s); };
  const json = o => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (loaded() && isHtml && p !== '/www/addFcltyAppl.do') {
    const x = rnd();
    if (x < (process.env.CHAOS ? 0.10 : 0.03)) { nCut++; ev('연결 끊김 ' + p); return req.socket.destroy(); }
    if (x < (process.env.CHAOS ? 0.30 : 0.10)) { n503++; ev('503 ' + p); return html(page.e503(), 503); }
  }
  if (loaded() && isAjax && rnd() < (process.env.CHAOS ? 0.15 : 0.04)) { n500++; ev('AJAX 500 ' + p); res.writeHead(500); return res.end(); }
  if (p === '/www/index.do') { await new Promise(r => setTimeout(r, 15)); res.writeHead(200); return res.end(); }
  if (p === '/nf/enter') { const a = srvNow(), t = admitTime(a); if (a >= openMs) ev(`NF 입장 요청 → 대기 ${Math.round(t - a)}ms`); return json({ wait: Math.max(0, Math.round(t - a)) }); }
  if (p === '/www/selectFcltyWebView.do') return html(page.detail());
  if (p === '/www/fcltyApplCalendarWebView.do') {
    if (srvNow() < openMs && process.env.PREOPEN !== 'disabled') { ev('접수 전 달력 진입 → 튕김'); return html(page.notOpen()); }
    if (srvNow() < openMs) ev('접수 전 달력 진입 → 날짜 비활성');
    return html(page.calendar().replace('b.disabled=!(y==2026&&m==12)', `b.disabled=!(y==2026&&m==12)||${srvNow() < openMs}`));
  }
  if (p === '/www/fcltyApplCalendarAjax.do') { const c = {}; for (let d = 1; d <= 31; d++) c[d] = 1; return json(c); }
  if (p === '/www/fcltyApplTimeListAjax.do') { const d = u.searchParams.get('date'); if (srvNow() >= openMs) ev(`시간표 조회 ${d} → 06:30 ${isFree(d, SLOTS[0]) ? '가능' : '마감'}`); return json(SLOTS.map(t => ({ t, free: isFree(d, t) }))); }
  if (p === '/www/addFcltyApplWebSuccess.do') ev('완료화면 GET ' + u.searchParams.get('no'));
  if (p === '/www/addFcltyApplWebSuccess.do') return html(page.done(u.searchParams.get('no')));
  if (p === '/www/addFcltyApplWebView.do') { if (req.method !== 'POST') { ev('GET 정보입력 → 404'); return html(page.e404(), 404); } return html(page.info(body)); }
  if (p === '/www/addFcltyAppl.do') {
    const d = body.get('fcltyDe'), s = body.get('applDtTm'); ev(`최종 POST ${d} ${s}`);
    const dup = bookings.filter(b => b.d === d).length;
    if (!isFree(d, s)) { ev(`최종 신청 실패(선점됨) ${d} ${s}`); return html(page.taken()); }
    taken[d + '|' + s] = 'me'; const no = `FCT02379-${d.replace(/-/g, '')}-${10001 + bookings.length}`;
    bookings.push({ d, s, no, at: srvNow() - openMs, group: body.get('group'), dup }); ev(`✅ 예약 ${d} ${s}`);
    res.writeHead(302, { location: '/www/addFcltyApplWebSuccess.do?no=' + no }); return res.end();
  }
  html(page.e404(), 404);
});
(async () => {
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  let src = fs.readFileSync(process.argv[2], 'utf8');
  src = src.replace(/OPEN_AT: '[^']*',/, `OPEN_AT: '${kstFull(openMs)}',`).replace("DRY_RUN: true,", `DRY_RUN: ${DRY},`).replace("GROUP: '단체명'", "GROUP: '테스트FC'");
  if (process.env.EARLY) src = src.replace('LEAD_MS: null', 'LEAD_MS: 1500'); // 일부러 1.5초 일찍 눌러 '접수 전 튕김' 경로 시험
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
  // Tampermonkey(document-end)처럼: DOMContentLoaded마다 1회 주입 (bfcache 복원 시에는 재실행 안 됨)
  // Tampermonkey(@run-at document-start)처럼 페이지 스크립트보다 먼저 실행
  if (process.env.OLD) await ctx.addInitScript({ content: `if(location.hostname==='localhost'){document.addEventListener('DOMContentLoaded',()=>{if(window.__cjmLoaded)return;window.__cjmLoaded=1;const s=document.createElement('script');s.textContent=${JSON.stringify(src)};document.documentElement.appendChild(s);});}` });
  else await ctx.addInitScript({ content: `if(location.hostname==='localhost'){${src}}` });
  const errs = []; let pages = 0, nDialog = 0;
  ctx.on('page', p => { pages++; const id = pages; p.on('pageerror', e => { errs.push(e.message); console.log('[ERR tab' + id + ']', e.message); });
    p.on('console', m => { const t = m.text(); if (process.env.V && /예약도우미/.test(t)) console.log(`[tab${id}]`, t.slice(0, 140)); });
    p.on('domcontentloaded', async () => { try { const has = await p.evaluate(() => !!window.__cjmLoaded); if (!has && /localhost/.test(p.url())) await p.addScriptTag({ content: src }); } catch (e) {} });
    p.on('requestfailed', r => { if (r.resourceType() === 'document') console.log(`[REQFAIL tab${id}]`, r.method(), r.url().replace(/^http:\/\/localhost:\d+/, ''), r.failure()?.errorText); });
    if (process.env.V) p.on('framenavigated', f => { if (f === p.mainFrame()) console.log(`[NAV tab${id}]`, f.url().replace(/^http:\/\/localhost:\d+/, '').slice(0, 80)); });
    p.on('dialog', d => { nDialog++; console.log('[DIALOG(실전이면 멈춤) tab' + id + ']', d.message()); d.dismiss(); }); });
  const main = await ctx.newPage();
  await main.goto(`http://localhost:${port}/www/selectFcltyWebView.do?fcltyNo=2379&key=15`);
  await main.waitForSelector('[data-cjm-panel]');
  console.log(`seed=${SEED} 접수 시각(서버) ${kstFull(openMs)} (약 ${Math.round((openMs - srvNow()) / 1000)}초 후), DRY=${DRY}`);
  await main.getByText('▶ 시작').click();
  const t0 = Date.now();
  let txt = '';
  while (Date.now() - t0 < 140000) {
    await new Promise(r => setTimeout(r, 1000));
    txt = await main.locator('[data-cjm-panel]').innerText({ timeout: 3000 }).catch(() => txt);
    if (process.env.DIAG && ((Date.now() - t0) / 1000 | 0) % 5 === 0) console.log(`[DIAG +${((srvNow() - openMs) / 1000).toFixed(0)}s]`, await main.evaluate(() => { const n = Date.now(), a = k => { const v = localStorage.getItem(k); return v ? Math.round((n - (v[0] === '{' ? JSON.parse(v).at : +v)) / 1000) : '-'; }; return 'ctrl ' + a('cjm_ctrl_hb') + ' | ' + ['2026-12-06', '2026-12-13', '2026-12-20', '2026-12-27'].map(d => d.slice(5) + ' hb' + a('cjm_hb_' + d) + ' res' + a('cjm_res_' + d)).join(' | '); }).catch(e => e.message.slice(0, 50)));
    const fin = txt.split('\n').filter(l => /^\d{2}-\d{2}\s/.test(l) && /✅|❌|DRY_RUN 정지|⚠/.test(l)).length;
    if (fin >= DATES.length && srvNow() > openMs) break;
  }
  console.log('--- 컨트롤러 패널 ---\n' + txt);
  console.log('컨트롤러 마지막 루프:', await main.evaluate(() => Math.round((Date.now() - +localStorage.getItem('cjm_ctrl_hb')) / 1000) + '초 전, hidden=' + document.hidden).catch(e => e.message));
  console.log('--- 서버 이벤트 ---'); events.forEach(e => console.log('  ' + e));
  console.log('--- 경쟁자 선점 시각(06:30) ---', DATES.map(d => d.slice(5) + ' +' + (takeAt[d + '|' + SLOTS[0]] / 1000).toFixed(1) + 's').join(', '));
  console.log('--- 예약 결과 ---'); bookings.forEach(b => console.log(`  ${b.d} ${b.s} ${b.no} @+${(b.at / 1000).toFixed(2)}s ${b.dup ? '‼중복' : ''}`));
  const expectWin = DATES.slice(1).length;
  console.log(`요약: 예약 ${bookings.length}건 (기대 ${DRY ? 0 : expectWin}), 중복 ${bookings.filter(b => b.dup).length}, 끊김 ${nCut}, 503 ${n503}, AJAX500 ${n500}, 창 ${pages}, 페이지에러 ${errs.length}, 차단알림창 ${nDialog}`);
  await browser.close(); server.close();
})();
