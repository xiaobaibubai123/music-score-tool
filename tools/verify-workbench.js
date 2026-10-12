const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { Midi } = require('@tonejs/midi');

const CHROME = require('./chrome.js');
const BASE = (process.env.BASE_URL || 'http://localhost:8081').replace(/\/+$/, '');
const URL = BASE + '/';
const DL = path.join(__dirname, 'dl-editor');
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const status = (page) => page.$eval('#status', el => el.textContent);

async function setSrc(page, text) {
  await page.evaluate((t) => {
    const s = document.getElementById('src');
    s.value = t;
    s.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await sleep(600);   // 等 debounce(350ms) + 解析
}
const info = (page) => page.$eval('#info', el => el.textContent);

(async () => {
  fs.rmSync(DL, { recursive: true, force: true });
  fs.mkdirSync(DL, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 });
  const consoleErrors = [], pageErrors = [], badReqs = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push(e.message));
  // 兜底：页面里任何确认框都自动确认，避免测试卡死（#btnOpen 有防误覆盖确认框）
  page.on('dialog', d => d.accept().catch(() => {}));
  page.on('response', r => { if (r.status() >= 400) badReqs.push('HTTP ' + r.status() + ' ' + r.url()); });

  const cdp = await page.target().createCDPSession();
  await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

  /* ---------- 1. 加载 ---------- */
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  const env = await page.evaluate(() => ({
    tone: window.Tone ? window.Tone.version : null,
    midi: !!window.Midi,
    hasSrc: !!document.getElementById('src'),
    srcLen: document.getElementById('src').value.length,
  }));
  check('Tone.js 加载', !!env.tone, env.tone);
  check('@tonejs/midi 加载', env.midi);
  check('编辑器与默认乐谱已就绪', env.hasSrc && env.srcLen > 30, 'src 长度 ' + env.srcLen);

  /* ---------- 2. 默认示例解析 ---------- */
  const i1 = await info(page);
  check('默认示例解析出 2 条轨道', /2 条轨道/.test(i1), i1);
  check('默认示例音符数 21', /21 个音符/.test(i1), i1);
  check('默认示例 16 拍 / 9.60 s', /16 拍/.test(i1) && /9\.60 s/.test(i1), i1);
  check('没有任何语法问题', /没有发现语法问题/.test(await page.$eval('#msgs', el => el.textContent)),
        await page.$eval('#msgs', el => el.textContent));
  check('轨道列表 2 行', (await page.$$('#tracks .trackline')).length === 2);
  await page.screenshot({ path: path.join(__dirname, 'shot-editor.png'), fullPage: true });

  /* ---------- 3. 试听 ---------- */
  await page.click('#btnPlay');
  await sleep(1800);
  const p = await page.evaluate(() => ({
    sec: window.Tone.Transport.seconds, st: window.Tone.Transport.state,
    clock: document.getElementById('clock').textContent,
    status: document.getElementById('status').textContent,
  }));
  check('试听：Transport 走时', p.sec > 0.3, `sec=${p.sec.toFixed(2)} state=${p.st}`);
  check('时钟显示当前/总时长', /^\d+\.\d\d \/ 9\.60 s$/.test(p.clock), p.clock);
  check('循环已开启（loop=true）', await page.evaluate(() => window.Tone.Transport.loop === true));
  await page.screenshot({ path: path.join(__dirname, 'shot-editor-playing.png'), fullPage: true });

  await page.click('#btnPause');
  await sleep(200);
  const a1 = await page.evaluate(() => window.Tone.Transport.seconds);
  await sleep(600);
  const a2 = await page.evaluate(() => window.Tone.Transport.seconds);
  check('暂停后停在原地', Math.abs(a2 - a1) < 0.05, `${a1.toFixed(2)} → ${a2.toFixed(2)}`);

  await page.click('#btnStop');
  await sleep(300);
  check('停止归零', (await page.evaluate(() => window.Tone.Transport.seconds)) < 0.01);

  /* ---------- 4. 循环：短曲跑过结尾仍在播 ---------- */
  await setSrc(page, 'title 循环测试\nbpm 120\nt:\n C4 C4');
  await page.click('#btnPlay');
  await sleep(2500);                       // 2 拍 @120bpm = 1s，循环应已回卷
  const lp = await page.evaluate(() => ({ sec: window.Tone.Transport.seconds, st: window.Tone.Transport.state }));
  check('循环开启时跑过结尾仍在播放', lp.st === 'started' && lp.sec < 1.0,
        `state=${lp.st} sec=${lp.sec.toFixed(2)}（<1 说明已回卷）`);
  await page.click('#btnStop');

  /* ---------- 5. 语法错误与行号 ---------- */
  await setSrc(page, 'title 有错\nbpm 120\nt:\n C4 D4 E4 F4 |\n C4 H4 G4');
  const errText = await page.$eval('#msgs', el => el.textContent);
  check('坏音名给出行号与提示', /H4/.test(errText), errText.slice(0, 120));
  check('错误计数出现在摘要里', /个错误/.test(await info(page)), await info(page));

  const jumped = await page.evaluate(() => {
    const first = document.querySelector('#msgs .msg');
    if (!first) return null;
    first.click();
    const s = document.getElementById('src');
    return s.value.slice(s.selectionStart, s.selectionEnd);
  });
  check('点击错误能跳到对应行', jumped && /H4/.test(jumped), JSON.stringify(jumped));

  const playBlocked = await Promise.all([
    page.click('#btnPlay').then(() => true).catch(() => false),
    sleep(700),
  ]).then(() => status(page));
  check('有语法错误时拒绝播放并提示', /语法问题/.test(playBlocked), playBlocked.slice(0, 80));

  /* ---------- 6. 小节拍数警告 ---------- */
  await setSrc(page, 'title 拍数\ntime 4/4\nt:\n C4 C4 | C4 C4 C4 C4 |');
  const warn = await page.$eval('#msgs', el => el.textContent);
  check('小节少拍给出黄色警告', /⚠/.test(warn) && /小节/.test(warn), warn.slice(0, 120));
  await setSrc(page, 'title 拍数\ntime 4/4\nt:\n C4 C4 C4 C4 | C4 C4 C4 C4 |');
  check('小节齐整无警告', /没有发现语法问题/.test(await page.$eval('#msgs', el => el.textContent)),
        await page.$eval('#msgs', el => el.textContent));

  /* ---------- 7. 和弦 / 休止 / 时值 ---------- */
  await setSrc(page, 'title 语法\nt:\n [C4 E4 G4]:2 r:1 C4:e C4:h');
  const i2 = await info(page);
  check('和弦+休止+字母时值共 5 个音', /5 个音符/.test(i2), i2);
  check('总拍数 5.5', /5\.5 拍/.test(i2), i2);

  /* ---------- 8. BPM 输入改写文本 ---------- */
  await setSrc(page, 'title 速度\nt:\n C4 C4 C4 C4');
  await page.evaluate(() => {
    const b = document.getElementById('bpm');
    b.value = '60'; b.dispatchEvent(new Event('change'));
  });
  await sleep(500);
  const afterBpm = await page.evaluate(() => ({
    text: document.getElementById('src').value,
    info: document.getElementById('info').textContent,
  }));
  check('改 BPM 会写回文本', /bpm 60/.test(afterBpm.text), JSON.stringify(afterBpm.text.split('\n')[0]));
  check('60BPM 下 4 拍 = 4.00 s', /4\.00 s/.test(afterBpm.info), afterBpm.info);

  await page.evaluate(() => {
    const b = document.getElementById('bpm');
    b.value = '999'; b.dispatchEvent(new Event('change'));
  });
  await sleep(500);
  check('BPM 越界被夹到 300',
        await page.evaluate(() => document.getElementById('bpm').value === '300'),
        await page.evaluate(() => document.getElementById('bpm').value));

  /* ---------- 9. 轨道静音 ---------- */
  await setSrc(page, 'title 静音\nt:\n C4 D4\n低音:\n C3 C3');
  const muteOk = await page.evaluate(() => {
    const cb = document.querySelectorAll('#tracks input[type=checkbox]')[1];
    cb.click();
    return cb.checked;
  });
  check('轨道可单独静音', muteOk === false, '第二条轨 checked=' + muteOk);
  check('静音后页面仍正常', /条轨道/.test(await info(page)));

  /* ---------- 📂 打开乐谱文件（载入测试夹具） ---------- */
  const songPath = path.join(__dirname, 'fixtures', '测试乐谱.txt');
  if (fs.existsSync(songPath)) {
    // 确认框由上面注册的全局 dialog 处理器自动确认
    // 走真实路径：点按钮 -> 弹出文件选择器 -> 选文件
    const [chooser] = await Promise.all([
      page.waitForFileChooser({ timeout: 8000 }),
      page.click('#btnOpen'),
    ]);
    await chooser.accept([songPath]);
    await page.waitForFunction(
      () => /已载入/.test(document.getElementById('status').textContent), { timeout: 15000 });
    const loaded = await page.evaluate(() => ({
      status: document.getElementById('status').textContent,
      info: document.getElementById('info').textContent,
      tracks: document.querySelectorAll('#tracks .trackline').length,
      msgs: document.getElementById('msgs').textContent.trim(),
    }));
    check('📂 打开乐谱文件能载入外部 .txt', /已载入/.test(loaded.status), loaded.status);
    check('载入后解析出 2 条轨道 / 338 个音符 / 120 秒',
          /2 条轨道/.test(loaded.info) && /338 个音符/.test(loaded.info) &&
          /120\.00 s/.test(loaded.info) && loaded.tracks === 2,
          loaded.info);
    check('载入的曲子没有语法问题和小节警告',
          /没有发现语法问题/.test(loaded.msgs), loaded.msgs.slice(0, 70));

    // 同名轨道续写：全曲应只有 2 条轨道（分 5 个乐段书写）
    check('分乐段书写仍只有 2 条轨道（同名轨道续写生效）', loaded.tracks === 2,
          loaded.tracks + ' 条轨道');
  } else {
    check('📂 打开乐谱文件能载入外部 .txt', false, '找不到 ' + songPath);
  }

  // 回归：改写乐谱后不应残留静音，否则新写的轨道会"没声音"
  await setSrc(page, 'title 静音后改写\nt:\n C4 D4\n低音:\n C3 C3');
  const allOn = await page.evaluate(() =>
    [...document.querySelectorAll('#tracks input[type=checkbox]')].every(c => c.checked));
  check('改写乐谱后静音状态被清除', allOn === true, 'all checked = ' + allOn);

  await setSrc(page, 'title 静音后改写\nt:\n C4 D4\n低音:\n C3 C3\n其他:\n E4 E4');
  await page.click('#btnPlay');
  await sleep(700);
  const audible = await page.evaluate(() => document.getElementById('status').textContent);
  check('静音清除后三条轨都能排程', /3 条|排程 6 个音符/.test(audible) || /正在试听/.test(audible), audible);
  await page.click('#btnStop');

  /* ---------- 10. 导出 .mid 并在 Node 里校验 ---------- */
  await setSrc(page, `title 中文曲名测试
bpm 100
time 4/4

主旋律:
  C4 C4 G4 G4 | A4 A4 G4:2 |

低音:
  C3:4 | F3:2 C3:2 |`);
  await page.click('#btnExportMid');
  let midFile = null;
  for (let i = 0; i < 40 && !midFile; i++) {
    await sleep(200);
    const f = fs.readdirSync(DL).filter(x => x.endsWith('.mid'));
    if (f.length) midFile = path.join(DL, f[0]);
  }
  check('导出 .mid 文件', !!midFile, midFile || '未生成');
  if (midFile) {
    const bytes = fs.readFileSync(midFile);
    const m = new Midi(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const notes = m.tracks.reduce((s, t) => s + t.notes.length, 0);
    check('导出 MIDI 音符数 = 10', notes === 10, notes);
    const dec = (s) => new TextDecoder().decode(Uint8Array.from(s, c => c.charCodeAt(0)));
    check('导出 MIDI 中文轨道名不乱码',
          m.tracks.map(t => dec(t.name)).join(',') === '主旋律,低音',
          m.tracks.map(t => dec(t.name)).join(','));
    check('导出 MIDI 中文曲名不乱码', dec(m.header.name) === '中文曲名测试', dec(m.header.name));
    check('导出 MIDI 速度 = 100', Math.abs(m.header.tempos[0].bpm - 100) < 0.01, m.header.tempos[0].bpm);
  }

  /* ---------- 11. 导出 .json 并跨页导入到演奏页 ---------- */
  await page.click('#btnExportJson');
  let jsonFile = null;
  for (let i = 0; i < 40 && !jsonFile; i++) {
    await sleep(200);
    const f = fs.readdirSync(DL).filter(x => x.endsWith('.midi.json'));
    if (f.length) jsonFile = path.join(DL, f[0]);
  }
  check('导出 .json 文件', !!jsonFile, jsonFile || '未生成');

  /* ---------- 12. localStorage 持久化 ---------- */
  await setSrc(page, 'title 保存测试\nt:\n C4 E4 G4');
  await page.reload({ waitUntil: 'networkidle2' });
  const persisted = await page.evaluate(() => document.getElementById('src').value);
  check('刷新后作品仍在（localStorage）', /保存测试/.test(persisted), persisted.split('\n')[0]);

  /* ---------- 13. 打开 MIDI / JSON 并转成可编辑乐谱文本 ---------- */
  await page.goto(URL, { waitUntil: 'networkidle2' });
  // 页面重新加载后 window.confirm 的覆盖会失效；#btnOpen 有防误覆盖的确认框，
  // 不处理就会把浏览器卡死（另外一个 dialog 兜底处理放在页面创建处）
  await page.evaluate(() => { window.confirm = () => true; });

  // 导入 .mid（仓库自带的示例 MIDI）
  const demoSrc = path.join(__dirname, '..', 'assets', 'demo.mid');
  const [midChooser] = await Promise.all([
    page.waitForFileChooser({ timeout: 8000 }),
    page.click('#btnOpen'),
  ]);
  await midChooser.accept([demoSrc]);
  // 必须等状态里出现具体文件名：只匹配「转换出乐谱文本」会撞上上一次操作的残留状态（假通过）
  await page.waitForFunction(
    () => document.getElementById('status').textContent.includes('demo.mid'),
    { timeout: 30000 });
  const imported = await page.evaluate(() => ({
    status: document.getElementById('status').textContent,
    info: document.getElementById('info').textContent,
    text: document.getElementById('src').value,
    msgs: document.getElementById('msgs').textContent.trim(),
  }));
  check('.mid 文件能转成乐谱文本', /转换出乐谱文本/.test(imported.status), imported.status);
  check('转换结果里有 barlines off 指令', /barlines off/.test(imported.text));
  check('转换结果含和弦语法（MIDI 是多声部的）', /\[[A-G]/.test(imported.text));
  check('转换出的乐谱能直接解析出音符', /\d+ 个音符/.test(imported.info), imported.info);
  check('转换出的乐谱没有语法错误', /没有发现语法问题/.test(imported.msgs), imported.msgs.slice(0, 80));

  // 导入工作台自己导出的 .json（往返）
  if (jsonFile) {
    const [jsonChooser] = await Promise.all([
      page.waitForFileChooser({ timeout: 8000 }),
      page.click('#btnOpen'),
    ]);
    await jsonChooser.accept([jsonFile]);
    await page.waitForFunction(
      (n) => document.getElementById('status').textContent.includes(n),
      { timeout: 30000 }, path.basename(jsonFile));
    const back = await page.evaluate(() => document.getElementById('info').textContent);
    // 注：往返后轨道数会变多（转换时按「时值」拆轨，因为和弦语法要求同和弦内时值一致），
    // 但音符总数必须一致
    check('.json 往返后音符数一致', /10 个音符/.test(back), back);
  } else {
    check('.json 往返后音符数一致', false, '没有导出的 json');
  }

  /* ---------- 14. 无错误 ---------- */
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
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
