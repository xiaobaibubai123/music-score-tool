/**
 * 验证「嵌进个人网站」这条路真的可行 —— 重点是工作台在 iframe 里能不能正常用。
 *
 * 仓库里不再单独放 embed.html，所以这里用 about:blank 建一个带 iframe 的外层页面，
 * 模拟「你的网站页面里嵌了一个 iframe」的场景。
 *
 *   node verify-embed.js
 */
const puppeteer = require('puppeteer-core');
const path = require('path');

const CHROME = require('./chrome.js');
const BASE = (process.env.BASE_URL || 'http://localhost:8081').replace(/\/+$/, '');
const APP = BASE + '/';

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
  await page.setViewport({ width: 1200, height: 1000, deviceScaleFactor: 1 });

  const consoleErrors = [], pageErrors = [], badReqs = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('response', r => { if (r.status() >= 400) badReqs.push('HTTP ' + r.status() + ' ' + r.url()); });

  /* ---------- 1. 搭一个「个人网站页面」，里面嵌 iframe ---------- */
  // 注意：不能用 about:blank + setContent 当父页面 —— 那种文档里 iframe 加载 http 会失败
  // （chrome-error://chromewebdata）。用真实的 http 页面当父页面，也更接近实际场景。
  await page.goto(APP, { waitUntil: 'networkidle2' });
  await page.evaluate(() => {
    document.body.innerHTML =
      '<h1>我的工具栏目</h1><p>下面嵌了一个在线乐谱工具：</p>';
    const f = document.createElement('iframe');
    f.id = 'app';
    f.src = location.href;                 // 指向工作台
    f.setAttribute('allow', 'midi');
    f.style.cssText = 'width:520px;height:900px;border:0';
    document.body.appendChild(f);
  });

  // 等 iframe 里的工作台加载完（轮询，比固定 sleep 稳）
  let frame = null;
  for (let i = 0; i < 40 && !frame; i++) {
    await sleep(500);
    frame = page.frames().find(
      f => f !== page.mainFrame() && f.url().replace(/\/+$/, '') === BASE);
  }
  check('找到 iframe 里的工作台', !!frame,
        frame ? frame.url() : '未找到；实际 frame: ' +
          page.frames().map(f => f.url()).join(' | '));
  if (!frame) { await browser.close(); process.exit(1); }

  /* ---------- 2. iframe 内部：工作台真的能用 ---------- */
  const inside = await frame.evaluate(() => ({
    tone: window.Tone ? window.Tone.version : null,
    midi: !!window.Midi,
    lame: typeof lamejs !== 'undefined' && !!lamejs.Mp3Encoder,
    srcLen: document.getElementById('src').value.length,
    info: document.getElementById('info').textContent,
    hasPiano: !!document.querySelector('#piano'),
  }));
  check('iframe 内 Tone.js 正常加载', !!inside.tone, inside.tone);
  check('iframe 内 @tonejs/midi 正常加载', inside.midi);
  check('iframe 内 MP3 编码器正常加载', inside.lame);
  check('iframe 内默认乐谱解析正常',
        /2 条轨道/.test(inside.info) && /21 个音符/.test(inside.info), inside.info);
  check('单页版工作台不含演奏台元素', inside.hasPiano === false);

  // 点试听（激活音频 + 播放）
  await frame.click('#btnPlay');
  await sleep(1600);
  const play = await frame.evaluate(() => ({
    sec: window.Tone.Transport.seconds,
    ctx: window.Tone.context.state,
  }));
  check('iframe 内音频上下文可运行', play.ctx === 'running', play.ctx);
  check('iframe 内能试听（Transport 走时）', play.sec > 0.3, `sec=${play.sec.toFixed(2)}`);
  await frame.click('#btnStop');

  // 改谱并重新解析
  await frame.evaluate(() => {
    const s = document.getElementById('src');
    s.value = 'title iframe内改写\nt:\n C4 E4 G4 C5';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(700);
  const edited = await frame.$eval('#info', el => el.textContent);
  check('iframe 内可以改谱并重新解析', /4 个音符/.test(edited), edited);

  // 窄 iframe 下布局不溢出
  const layout = await frame.evaluate(() => ({
    clientW: document.documentElement.clientWidth,
    bodyScrollW: document.body.scrollWidth,
    gridCols: getComputedStyle(document.querySelector('.grid'))
                .gridTemplateColumns.split(' ').length,
  }));
  check('窄 iframe 下没有横向溢出',
        layout.bodyScrollW <= layout.clientW + 2,
        `body ${layout.bodyScrollW}px vs 可视 ${layout.clientW}px`);
  check('窄 iframe 下双栏自动折叠成单栏', layout.gridCols === 1, layout.gridCols + ' 列');

  /* ---------- 3. 外层页面无错误 ---------- */
  check('无未捕获 JS 异常', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));
  const ce = consoleErrors.filter(t => !/favicon/i.test(t));
  check('无控制台错误', ce.length === 0, JSON.stringify(ce.slice(0, 3)));
  const br = badReqs.filter(u => !/favicon/i.test(u));
  check('无资源加载失败', br.length === 0, JSON.stringify(br.slice(0, 3)));

  await page.screenshot({ path: path.join(__dirname, 'shot-embed.png'), fullPage: false });
  await browser.close();

  const failed = results.filter(r => !r.ok);
  console.log('\n===== ' + (results.length - failed.length) + ' / ' + results.length + ' 通过 =====');
  failed.forEach(f => console.log('  ✗ ' + f.name + ' :: ' + f.detail));
  if (failed.length) process.exitCode = 1;
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
