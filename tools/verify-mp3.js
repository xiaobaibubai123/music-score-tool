/**
 * 验证「导出 MP3」功能 —— 工作台 / 演奏台 两个页面都测。
 *   1. 能产出文件，体积合理
 *   2. 字节头是合法 MP3
 *   3. 浏览器能真实解码（decodeAudioData）：时长/声道正确
 *   4. 解出的波形不是静音（峰值、RMS 都要有）
 *
 *   node verify-mp3.js            # 两个页面都测
 *   node verify-mp3.js editor     # 只测工作台
 *   node verify-mp3.js player     # 只测演奏台
 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const CHROME = require('./chrome.js');
const BASE = (process.env.BASE_URL || 'http://localhost:8081').replace(/\/+$/, '');
// 用仓库自带的短测试曲（自制，无版权问题，约 9.6 秒），而不是任何真实歌曲
const SONG_JSON = path.join(__dirname, 'fixtures', 'mp3-test.midi.json');
const SONG_TXT = path.join(__dirname, 'fixtures', 'mp3-test.txt');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const PAGES = {
  editor: {
    label: '工作台 /editor.html',
    url: BASE + '/editor.html',
    async load(page) {
      await page.evaluate(() => { window.confirm = () => true; });
      const [chooser] = await Promise.all([
        page.waitForFileChooser({ timeout: 8000 }),
        page.click('#btnOpen'),
      ]);
      await chooser.accept([SONG_TXT]);
      await page.waitForFunction(() => /已载入/.test(document.getElementById('status').textContent),
        { timeout: 20000 });
    },
    expectedSeconds: 9.6,
  },
  player: {
    label: '演奏台 /',
    url: BASE + '/',
    async load(page) {
      const input = await page.$('#file');
      await input.uploadFile(SONG_JSON);
      await page.waitForFunction(() => /已解析/.test(document.getElementById('status').textContent),
        { timeout: 25000 });
    },
    expectedSeconds: 9.6,
  },
};

async function runOne(browser, key) {
  const cfg = PAGES[key];
  console.log('\n──────── ' + cfg.label + ' ────────');
  const DL = path.join(__dirname, 'dl-mp3-' + key);
  fs.rmSync(DL, { recursive: true, force: true });
  fs.mkdirSync(DL, { recursive: true });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errs = [], consoleErrs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error') consoleErrs.push(m.text()); });

  const cdp = await page.target().createCDPSession();
  await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

  await page.goto(cfg.url, { waitUntil: 'networkidle2', timeout: 30000 });

  const hasLame = await page.evaluate(() => typeof lamejs !== 'undefined' && !!lamejs.Mp3Encoder);
  check('lamejs MP3 编码器已加载', hasLame);
  const hasBtn = await page.$('#btnExportMp3');
  check('页面上存在「导出 .mp3」按钮', !!hasBtn);

  await cfg.load(page);
  const info = await page.$eval(key === 'player' ? '#fileInfo' : '#info', el => el.textContent);
  console.log('        乐谱：' + info.trim());

  const t0 = Date.now();
  await page.click('#btnExportMp3');

  let mp3 = null;
  for (let i = 0; i < 300 && !mp3; i++) {           // 最多等 150 秒
    await sleep(500);
    const f = fs.readdirSync(DL).filter(x => /\.mp3$/i.test(x));
    if (f.length) {
      const p = path.join(DL, f[0]);
      const s1 = fs.statSync(p).size;
      await sleep(400);
      if (fs.statSync(p).size === s1) mp3 = p;
    }
  }
  check('导出 .mp3 文件', !!mp3,
        mp3 ? path.basename(mp3) + '（耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's）' : '未生成');
  console.log('        页面状态：' + (await page.$eval('#status', el => el.textContent)));

  if (mp3) {
    const bytes = fs.readFileSync(mp3);
    const sizeMB = bytes.length / 1048576;
    check('体积合理（0.2–20 MB）', sizeMB > 0.2 && sizeMB < 20, sizeMB.toFixed(2) + ' MB');
    const isID3 = bytes.toString('ascii', 0, 3) === 'ID3';
    const isSync = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
    check('字节头是合法 MP3', isID3 || isSync,
          isID3 ? 'ID3' : '0x' + bytes[0].toString(16) + bytes[1].toString(16));

    await page.evaluate(() => {
      const i = document.createElement('input');
      i.type = 'file'; i.id = '__mp3check';
      document.body.appendChild(i);
    });
    await (await page.$('#__mp3check')).uploadFile(mp3);
    const dec = await page.evaluate(async () => {
      const f = document.getElementById('__mp3check').files[0];
      const ab = await f.arrayBuffer();
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const buf = await ctx.decodeAudioData(ab);
      const ch = buf.getChannelData(0);
      let peak = 0, sum = 0, n = 0;
      for (let i = 0; i < ch.length; i += 7) {
        const v = ch[i];
        if (Math.abs(v) > peak) peak = Math.abs(v);
        sum += v * v; n++;
      }
      return { duration: buf.duration, sampleRate: buf.sampleRate,
               channels: buf.numberOfChannels, peak, rms: Math.sqrt(sum / n) };
    });
    check('浏览器能解码这个 MP3', dec.duration > 0,
          `${dec.duration.toFixed(1)}s / ${dec.sampleRate}Hz / ${dec.channels}声道`);
    check('时长与乐谱一致（±3s）', Math.abs(dec.duration - cfg.expectedSeconds) < 3.0,
          '解码 ' + dec.duration.toFixed(1) + 's vs 乐谱 ' + cfg.expectedSeconds + 's');
    check('是立体声', dec.channels === 2, dec.channels + ' 声道');
    check('不是静音（峰值 > 0.05）', dec.peak > 0.05, 'peak=' + dec.peak.toFixed(3));
    check('响度正常（RMS 0.01–0.5）', dec.rms > 0.01 && dec.rms < 0.5, 'rms=' + dec.rms.toFixed(4));
  }

  check('无未捕获 JS 异常', errs.length === 0, JSON.stringify(errs.slice(0, 3)));
  check('无控制台错误', consoleErrs.filter(t => !/favicon/i.test(t)).length === 0,
        JSON.stringify(consoleErrs.filter(t => !/favicon/i.test(t)).slice(0, 3)));
  await page.close();
}

(async () => {
  const only = process.argv[2];
  const list = only ? [only] : Object.keys(PAGES);
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'shell',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  for (const k of list) await runOne(browser, k);
  await browser.close();

  const failed = results.filter(r => !r.ok);
  console.log('\n===== ' + (results.length - failed.length) + ' / ' + results.length + ' 通过 =====');
  failed.forEach(f => console.log('  ✗ ' + f.name + ' :: ' + f.detail));
  if (failed.length) process.exitCode = 1;
})().catch(e => { console.error('HARNESS ERROR:', e); process.exitCode = 2; });
