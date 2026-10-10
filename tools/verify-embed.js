/**
 * 验证「嵌入个人网站」这条路真的可行 —— 重点是页面在 iframe 里能不能正常工作。
 */
const puppeteer = require('puppeteer-core');
const path = require('path');

const CHROME = require('./chrome.js');
const BASE = (process.env.BASE_URL || 'http://localhost:8081').replace(/\/+$/, '');
const URL = BASE + '/embed.html';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 2400, deviceScaleFactor: 1 });

  const consoleErrors = [], pageErrors = [], badReqs = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('response', r => { if (r.status() >= 400) badReqs.push('HTTP ' + r.status() + ' ' + r.url()); });

  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });

  /* ---------- 1. 嵌入说明页本身 ---------- */
  const snip = await page.$eval('#snippet', el => el.textContent);
  check('代码片段包含 allow="midi"', /allow="midi"/.test(snip));
  check('代码片段用的是 iframe', /^<iframe/.test(snip.trim()), snip.split('\n')[0]);
  check('代码片段指向 editor.html', /editor\.html/.test(snip), snip.split('\n')[1].trim());
  check('预览 iframe 也带 allow="midi"',
        (await page.$eval('#preview', el => el.getAttribute('allow'))) === 'midi');

  await page.evaluate(() => { document.getElementById('h').value = '640';
                              document.getElementById('h').dispatchEvent(new Event('input')); });
  const snip2 = await page.$eval('#snippet', el => el.textContent);
  check('拖动高度会更新代码片段', /height:640px/.test(snip2), (snip2.match(/height:\d+px/) || [])[0]);
  check('预览 iframe 高度同步', (await page.$eval('#preview', el => el.style.height)) === '640px');

  await page.click('#btnPlayer');
  const snip3 = await page.$eval('#snippet', el => el.textContent);
  check('切到演奏台后代码片段跟着变', /index\.html/.test(snip3), snip3.split('\n')[1].trim());
  await page.click('#btnEditor');

  await page.click('#btnCopy');
  await sleep(400);
  check('复制按钮有反馈', /已复制|Ctrl\+C/.test(await page.$eval('#btnCopy', el => el.textContent)),
        await page.$eval('#btnCopy', el => el.textContent));

  /* ---------- 2. iframe 内部：工作台真的能用 ---------- */
  await sleep(1200);
  const frame = page.frames().find(f => /editor\.html$/.test(f.url()));
  check('找到了 iframe 里的工作台', !!frame, frame ? frame.url() : '未找到');
  if (!frame) { await browser.close(); process.exit(1); }

  const insideEnv = await frame.evaluate(() => ({
    tone: window.Tone ? window.Tone.version : null,
    midi: !!window.Midi,
    srcLen: document.getElementById('src').value.length,
    info: document.getElementById('info').textContent,
  }));
  check('iframe 内 Tone.js 正常加载', !!insideEnv.tone, insideEnv.tone);
  check('iframe 内 @tonejs/midi 正常加载', insideEnv.midi);
  check('iframe 内乐谱解析正常', /2 条轨道/.test(insideEnv.info) && /21 个音符/.test(insideEnv.info),
        insideEnv.info);

  // 在 iframe 里点一下激活音频 + 试听
  await frame.click('#btnPlay');
  await sleep(1600);
  const insidePlay = await frame.evaluate(() => ({
    sec: window.Tone.Transport.seconds,
    state: window.Tone.context.state,
    status: document.getElementById('status').textContent,
  }));
  check('iframe 内音频上下文可运行', insidePlay.state === 'running', insidePlay.state);
  check('iframe 内能试听（Transport 走时）', insidePlay.sec > 0.3,
        `sec=${insidePlay.sec.toFixed(2)} status=${insidePlay.status}`);
  await frame.click('#btnStop');

  // iframe 内编辑乐谱
  await frame.evaluate(() => {
    const s = document.getElementById('src');
    s.value = 'title iframe内改写\nt:\n C4 E4 G4 C5';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(700);
  check('iframe 内可以改谱并重新解析',
        /4 个音符/.test(await frame.$eval('#info', el => el.textContent)),
        await frame.$eval('#info', el => el.textContent));

  /* ---------- 3. iframe 内部：演奏台能用 + 窄 iframe 下键盘不裁切 ---------- */
  // 故意把 iframe 收窄到 520px，模拟嵌在个人网站侧栏/窄栏里的情况
  await page.evaluate(() => {
    const p = document.getElementById('preview');
    p.style.width = '520px';
    p.src = 'index.html';
  });
  await sleep(1800);
  const pf = page.frames().find(f => /index\.html$/.test(f.url()));
  check('找到 iframe 里的演奏台', !!pf, pf ? pf.url() : '未找到');
  if (pf) {
    const st = await pf.evaluate(() => {
      const w = document.querySelector('.piano-wrap');
      return {
        tone: !!window.Tone,
        keys: document.querySelectorAll('#piano [data-midi]').length,
        overflowX: getComputedStyle(w).overflowX,
        scrollable: w.scrollWidth > w.clientWidth + 1,
        wrapClientW: w.clientWidth,
        pianoW: document.querySelector('#piano').clientWidth,
      };
    });
    check('iframe 内演奏台加载正常', st.tone && st.keys === 36, `${st.keys} 个琴键`);
    check('键盘容器 overflow-x:auto', st.overflowX === 'auto', st.overflowX);
    check('窄 iframe 下键盘可横向滚动而非被裁掉',
          st.scrollable && st.pianoW > st.wrapClientW,
          `键盘 ${st.pianoW}px > 可视 ${st.wrapClientW}px`);

    // 在 iframe 里激活音频并弹奏（用 #btnPanic 解锁，它不受横向滚动影响）
    await pf.click('#btnPanic');
    await sleep(1600);
    const ctxState = await pf.evaluate(() => window.Tone.context.state);
    check('iframe 内音频上下文可运行', ctxState === 'running', ctxState);

    // 用真实浏览器键盘输入（不是合成事件）：先把焦点放进 iframe，再按键
    await page.keyboard.down('a');
    await sleep(280);
    const note = await pf.$eval('#noteBig', el => el.textContent);
    await page.keyboard.up('a');
    check('iframe 内真实键盘输入能弹奏（A → C4）', note === 'C4', 'got=' + note);
  }

  await page.screenshot({ path: path.join(__dirname, 'shot-embed.png'), fullPage: true });

  /* ---------- 4. 跳转不会套娃 ---------- */
  await page.evaluate(() => {
    const p = document.getElementById('preview');
    p.style.width = '';
    p.src = 'index.html';
  });
  await sleep(1500);
  const pf2 = page.frames().find(f => /index\.html$/.test(f.url()));
  const linkInfo = await pf2.$eval('.sub a', a => ({ href: a.getAttribute('href'), target: a.getAttribute('target') }));
  check('演奏页→工作台的链接带 target="_top"', linkInfo.target === '_top', JSON.stringify(linkInfo));

  await pf2.click('.sub a');
  await sleep(1800);
  check('点 iframe 内链接会跳出到顶层页面（不套娃）',
        /editor\.html$/.test(page.url()), page.url());
  check('顶层页面确实变成了工作台',
        await page.evaluate(() => !!document.getElementById('src')));

  /* ---------- 5. 无错误 ---------- */
  check('无未捕获 JS 异常', pageErrors.length === 0, JSON.stringify(pageErrors));
  const ce = consoleErrors.filter(t => !/favicon/i.test(t));
  check('无控制台错误', ce.length === 0, JSON.stringify(ce));
  const br = badReqs.filter(u => !/favicon/i.test(u));
  check('无资源加载失败', br.length === 0, JSON.stringify(br));

  await browser.close();

  const failed = results.filter(r => !r.ok);
  console.log('\n===== ' + (results.length - failed.length) + ' / ' + results.length + ' 通过 =====');
  failed.forEach(f => console.log('  ✗ ' + f.name + ' :: ' + f.detail));
  if (failed.length) process.exitCode = 1;
})().catch(e => { console.error('HARNESS ERROR:', e); process.exitCode = 2; });
