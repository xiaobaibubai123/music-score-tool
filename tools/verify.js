const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const CHROME = require('./chrome.js');
const BASE = (process.env.BASE_URL || 'http://localhost:8081').replace(/\/+$/, '');
const URL = BASE + '/';
const DL = path.join(__dirname, 'downloads');
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const getStatus = (page) => page.$eval('#status', el => el.textContent);
/**
 * 等到状态文本【匹配指定模式】再返回。
 * 注意：不能写成"文本一变就返回"——按钮处理器会先把状态设成中间态（如"正在载入…"），
 * 那样会在 fetch 完成前就返回，导致随机失败。
 */
async function waitStatus(page, pattern, ms = 20000) {
  await page.waitForFunction(
    (src) => new RegExp(src).test(document.getElementById('status').textContent),
    { timeout: ms }, pattern);
  return getStatus(page);
}
const notesOf = (s) => { const m = s.match(/音符\s*(\d+)/); return m ? +m[1] : null; };

(async () => {
  fs.rmSync(DL, { recursive: true, force: true });
  fs.mkdirSync(DL, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1500, deviceScaleFactor: 1 });

  const consoleErrors = [], pageErrors = [], failedReqs = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('requestfailed', r => failedReqs.push(r.url() + ' ' + (r.failure() || {}).errorText));
  page.on('response', r => { if (r.status() >= 400) failedReqs.push('HTTP ' + r.status() + ' ' + r.url()); });

  const cdp = await page.target().createCDPSession();
  await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });

  /* ---------- 依赖与 UI ---------- */
  const env = await page.evaluate(() => ({
    tone: window.Tone ? window.Tone.version : null,
    midi: !!window.Midi,
    pianoKeys: document.querySelectorAll('#piano [data-midi]').length,
    white: document.querySelectorAll('#piano .wkey').length,
    black: document.querySelectorAll('#piano .bkey').length,
  }));
  check('Tone.js 加载', !!env.tone, env.tone);
  check('@tonejs/midi 加载', env.midi);
  check('钢琴键盘 36 键（21 白 + 15 黑）',
        env.pianoKeys === 36 && env.white === 21 && env.black === 15,
        `${env.pianoKeys} 键 / 白 ${env.white} / 黑 ${env.black}`);

  /* ---------- 音频激活 ---------- */
  await page.click('#piano');
  await sleep(1000);
  const ctxState = await page.evaluate(() => window.Tone.context.state);
  check('音频上下文 running', ctxState === 'running', ctxState);

  /* ---------- 电脑键盘演奏 ---------- */
  for (const [key, expect] of [['a', 'C4'], ['e', 'D#4'], ['k', 'C5'], ['w', 'C#4']]) {
    await page.keyboard.down(key);
    await sleep(90);
    const got = await page.$eval('#noteBig', el => el.textContent);
    await page.keyboard.up(key);
    check(`键盘 ${key.toUpperCase()} → ${expect}`, got === expect, 'got=' + got);
  }
  await page.keyboard.press('x');
  await page.keyboard.down('a'); await sleep(90);
  const oct = await page.$eval('#noteBig', el => el.textContent);
  await page.keyboard.up('a');
  await page.keyboard.press('z');
  check('八度切换 X → A 键变为 C5', oct === 'C5', 'got=' + oct);

  /* ---------- 内置示例 MIDI ---------- */
  await page.click('#btnDemo');
  let st = await waitStatus(page, '已解析|失败');
  const info1 = await page.$eval('#fileInfo', el => el.textContent);
  const n1 = notesOf(info1);
  check('内置 test.mid 解析成功', /已解析/.test(st), st);
  check('解析出 2357 个音符', n1 === 2357, 'notes=' + n1);
  check('轨道列表 10 行', (await page.$$('#tracks .trackline')).length === 10);
  await page.screenshot({ path: path.join(__dirname, 'shot-loaded.png'), fullPage: true });

  /* ---------- 播放 / 暂停 / 停止 / 变速 ---------- */
  await page.click('#btnPlay');
  await sleep(2000);
  const p = await page.evaluate(() => ({
    sec: window.Tone.Transport.seconds, state: window.Tone.Transport.state,
    clock: document.getElementById('clock').textContent,
  }));
  check('播放：Transport 走时', p.sec > 0.3, `sec=${p.sec.toFixed(2)} state=${p.state} clock=${p.clock}`);
  await page.screenshot({ path: path.join(__dirname, 'shot-playing.png'), fullPage: true });

  await page.click('#btnPause');
  await sleep(200);
  const t1 = await page.evaluate(() => window.Tone.Transport.seconds);
  await sleep(600);
  const t2 = await page.evaluate(() => window.Tone.Transport.seconds);
  check('暂停后停在原地', Math.abs(t2 - t1) < 0.05, `${t1.toFixed(2)} → ${t2.toFixed(2)}`);

  await page.click('#btnPlay');          // 继续
  await sleep(800);
  const t3 = await page.evaluate(() => window.Tone.Transport.seconds);
  check('继续播放从暂停点前进', t3 > t2 + 0.3, `${t2.toFixed(2)} → ${t3.toFixed(2)}`);

  await page.click('#btnStop');
  await sleep(300);
  const s = await page.evaluate(() => window.Tone.Transport.seconds);
  check('停止归零', s < 0.01, 'sec=' + s);

  await page.evaluate(() => {
    const r = document.getElementById('rate'); r.value = '0.5'; r.dispatchEvent(new Event('input'));
  });
  check('变速滑块生效', await page.evaluate(() => Math.abs(window.Tone.Transport.playbackRate - 0.5) < 1e-6));

  /* ---------- 上传真实 .mid ---------- */
  const fileInput = await page.$('#file');
  await fileInput.uploadFile(path.join(__dirname, '..', 'assets', 'demo.mid'));
  st = await waitStatus(page, '已解析|失败');
  check('上传 .mid 文件解析成功', /已解析/.test(st), st);

  /* ---------- 上传"简化格式" JSON ---------- */
  const simplePath = path.join(__dirname, 'simple.json');
  fs.writeFileSync(simplePath, JSON.stringify({
    name: 'my-handwritten-score', ppq: 480,
    tracks: [{ name: 'Melody', notes: [
      { midi: 60, time: 0,   duration: 0.5, velocity: 0.8 },
      { midi: 62, time: 0.5, duration: 0.5, velocity: 0.8 },
      { midi: 64, time: 1.0, duration: 1.0, velocity: 0.8 },
    ] }]
  }, null, 2));
  await fileInput.uploadFile(simplePath);
  st = await waitStatus(page, '已解析|失败');
  const infoJ = await page.$eval('#fileInfo', el => el.textContent);
  check('上传简化格式 JSON 成功', /已解析/.test(st) && /my-handwritten-score/.test(infoJ), infoJ);
  check('简化 JSON 音符数 = 3', notesOf(infoJ) === 3, 'notes=' + notesOf(infoJ));

  await page.click('#btnPlay');
  await sleep(1500);
  check('简化 JSON 可播放', (await page.evaluate(() => window.Tone.Transport.seconds)) > 0.3);
  await page.click('#btnStop');

  /* ---------- 导出 → 再导入（往返一致性） ---------- */
  await page.click('#btnDemo');                       // 先回到 2357 音的大文件
  await waitStatus(page, '已解析|失败');
  await page.click('#btnExport');
  await waitStatus(page, '已导出');

  let exported = null;
  for (let i = 0; i < 60 && !exported; i++) {
    await sleep(250);
    const f = fs.readdirSync(DL).filter(x => x.endsWith('.midi.json'));
    if (f.length) exported = path.join(DL, f[0]);
  }
  check('导出按钮产出文件', !!exported, exported || '未生成');
  if (exported) {
    const j = JSON.parse(fs.readFileSync(exported, 'utf8'));
    check('导出内容是标准 MidiJSON', !!(j.header && Array.isArray(j.tracks)),
          'keys=' + Object.keys(j).join(','));
    await fileInput.uploadFile(exported);
    st = await waitStatus(page, '已解析|失败');
    const infoRT = await page.$eval('#fileInfo', el => el.textContent);
    check('导出文件可重新导入且音符数一致', notesOf(infoRT) === 2357,
          `原 2357 → 回读 ${notesOf(infoRT)}`);
  }

  /* ---------- 错误处理：坏文件 ---------- */
  const badPath = path.join(__dirname, 'broken.json');
  fs.writeFileSync(badPath, '{ this is not json');
  await fileInput.uploadFile(badPath);
  st = await waitStatus(page, '失败');
  check('坏 JSON 给出友好错误', /失败/.test(st), st.slice(0, 90));
  check('坏文件后页面仍存活', await page.evaluate(() => typeof window.Tone === 'object'));

  /* ---------- 无错误 ---------- */
  check('无未捕获 JS 异常', pageErrors.length === 0, JSON.stringify(pageErrors));
  check('无控制台错误', consoleErrors.filter(t => !/favicon/i.test(t)).length === 0,
        JSON.stringify(consoleErrors.filter(t => !/favicon/i.test(t))));
  check('无资源加载失败', failedReqs.filter(u => !/favicon/i.test(u)).length === 0,
        JSON.stringify(failedReqs.filter(u => !/favicon/i.test(u))));

  await page.screenshot({ path: path.join(__dirname, 'shot-final.png'), fullPage: true });
  await browser.close();

  const failed = results.filter(r => !r.ok);
  console.log('\n===== ' + (results.length - failed.length) + ' / ' + results.length + ' 通过 =====');
  failed.forEach(f => console.log('  ✗ ' + f.name + ' :: ' + f.detail));
  if (failed.length) process.exitCode = 1;
})().catch(e => { console.error('HARNESS ERROR:', e); process.exitCode = 2; });
