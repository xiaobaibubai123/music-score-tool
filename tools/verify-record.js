/**
 * 演奏录音页（record.html）端到端测试。
 *
 * 单元测试只证明"给定一串按键时间，能算出正确乐谱"。
 * 这里要证明的是另一半：真的用键盘/鼠标弹，页面确实把音收下来了，
 * 而且【暂停的那段时间不会被算进乐谱】—— 这是暂停/继续最容易出错、
 * 又最难靠肉眼看出来的地方（差几秒听着都像"没对齐"，说不上来哪里不对）。
 *
 *   node verify-record.js            （默认 http://localhost:8081）
 *   BASE_URL=http://localhost:8085 node verify-record.js
 */
const puppeteer = require('puppeteer-core');

const CHROME = require('./chrome.js');
const BASE = (process.env.BASE_URL || 'http://localhost:8081').replace(/\/+$/, '');
const PAGE = BASE + '/record.html';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail !== undefined ? '  :: ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'shell',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errs = [], badReqs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) badReqs.push('HTTP ' + r.status() + ' ' + r.url()); });

  await page.goto(PAGE, { waitUntil: 'networkidle2', timeout: 30000 });

  /* ---------- 1. 页面结构 ---------- */
  const shape = await page.evaluate(() => ({
    keys: document.querySelectorAll('.key').length,
    white: document.querySelectorAll('.key.white').length,
    black: document.querySelectorAll('.key.black').length,
    kb: document.querySelectorAll('.key.kb').length,
    grids: Array.prototype.map.call(document.getElementById('grid').options, (o) => o.value),
    btns: ['btnStart', 'btnPause', 'btnResume', 'btnEnd'].map((id) => document.getElementById(id).textContent.trim()),
    startEnabled: !document.getElementById('btnStart').disabled,
    pauseEnabled: !document.getElementById('btnPause').disabled,
  }));
  check('琴键都画出来了（C2–C7，36 白 25 黑）',
        shape.keys === 61 && shape.white === 36 && shape.black === 25,
        '共 ' + shape.keys + ' 键 / 白 ' + shape.white + ' / 黑 ' + shape.black);
  check('四个控制键都在（开始 / 暂停 / 继续 / 结束）',
        shape.btns.length === 4 && /开始/.test(shape.btns[0]) && /暂停/.test(shape.btns[1]) &&
        /继续/.test(shape.btns[2]) && /结束/.test(shape.btns[3]), shape.btns.join(' | '));
  check('待机时只有「开始」能按', shape.startEnabled && !shape.pauseEnabled);
  check('量化网格 1/4、1/8、1/16、1/32 都有',
        shape.grids.join(',') === '1/4,1/8,1/16,1/32', shape.grids.join(','));
  check('键盘音区高亮覆盖两个八度（29 个键）', shape.kb === 29, shape.kb + ' 个键有蓝线');

  /* ---------- 2. 和乐谱工作台共用同一份音源 ---------- */
  const shared = await page.evaluate(() => ({
    hasAudio: typeof window.ScoreAudio !== 'undefined',
    hasRec: typeof window.ScoreRecorder !== 'undefined',
    samePiano: window.ScoreAudio && typeof PIANO !== 'undefined' && window.ScoreAudio.PIANO === PIANO,
    samples: window.ScoreAudio ? Object.keys(window.ScoreAudio.PIANO.samples).length : 0,
  }));
  check('页面从 audio.js 拿音源（没有自己再复制一份）',
        shared.hasAudio && shared.hasRec && shared.samePiano && shared.samples >= 25,
        '采样 ' + shared.samples + ' 个 / 同一个 PIANO 对象 ' + shared.samePiano);

  /* ---------- 3. 先解锁音频 ---------- */
  await page.mouse.click(700, 8);
  await page.waitForFunction(() => typeof audioReady !== 'undefined' && audioReady === true,
    { timeout: 90000 }).catch(() => {});
  const kind = await page.evaluate(() => (typeof instrumentKind !== 'undefined' ? instrumentKind : '(未定义)'));
  check('钢琴音源就绪（真实采样）', kind === 'sampler', kind);

  /* ---------- 4. 键盘弹奏：按住要亮、松开要灭 ---------- */
  await page.keyboard.down('KeyZ');
  await sleep(120);
  const held = await page.evaluate(() => {
    const el = document.querySelector('.key[data-midi="48"]');
    return { on: el.classList.contains('on'), pressed: pressed.size };
  });
  await page.keyboard.up('KeyZ');
  await sleep(120);
  const released = await page.evaluate(() => ({
    on: document.querySelector('.key[data-midi="48"]').classList.contains('on'), pressed: pressed.size,
  }));
  check('敲 Z 键会按下 C3（琴键亮起）', held.on && held.pressed === 1, JSON.stringify(held));
  check('松手后琴键熄灭', !released.on && released.pressed === 0, JSON.stringify(released));

  const oct = await page.evaluate(() => ({ base: kbBase }));
  await page.keyboard.press('ArrowRight');
  const oct2 = await page.evaluate(() => ({ base: kbBase }));
  await page.keyboard.press('ArrowLeft');
  const oct3 = await page.evaluate(() => ({ base: kbBase }));
  check('← → 能换音区', oct.base === 48 && oct2.base === 60 && oct3.base === 48,
        oct.base + ' → ' + oct2.base + ' → ' + oct3.base);

  /* ---------- 5. 完整流程：开始 → 弹 → 暂停（弹了不算） → 继续 → 结束 ---------- */
  // bpm 120 → 1 拍 0.5 秒；量化 1/4 → 每格 1 拍
  await page.evaluate(() => {
    document.getElementById('bpm').value = '120';
    document.getElementById('grid').value = '1/4';
    document.getElementById('chkCountin').checked = false;   // 免掉预备拍，测试跑快点
  });
  await page.click('#btnStart');
  await page.waitForFunction(() => REC.state === 'rec', { timeout: 30000 });
  const wallStart = Date.now();

  await page.keyboard.down('KeyZ'); await sleep(600); await page.keyboard.up('KeyZ');   // C3
  await sleep(400);
  await page.click('#btnPause');
  const nAtPause = await page.evaluate(() => REC.events.length);
  check('暂停后进入 paused 状态', (await page.evaluate(() => REC.state)) === 'paused');

  await page.keyboard.down('KeyX'); await sleep(500); await page.keyboard.up('KeyX');   // 暂停期间弹，不该被录
  await sleep(1000);
  const nWhilePaused = await page.evaluate(() => REC.events.length);
  check('暂停期间弹的音不会被录进去', nAtPause === 1 && nWhilePaused === 1,
        '暂停前 ' + nAtPause + ' → 暂停期间 ' + nWhilePaused);

  await page.click('#btnResume');
  await sleep(900);
  await page.keyboard.down('KeyC'); await sleep(600); await page.keyboard.up('KeyC');   // E3
  await sleep(200);
  await page.click('#btnEnd');
  const wallEnd = Date.now();

  const rec = await page.evaluate(() => ({
    state: REC.state,
    events: REC.events.map((e) => ({ midi: e.midi, on: +e.on.toFixed(2), off: +e.off.toFixed(2) })),
    text: document.getElementById('out').value,
  }));
  check('结束进入 done 状态', rec.state === 'done', rec.state);
  check('录到两个音（暂停时弹的那个不算）', rec.events.length === 2, JSON.stringify(rec.events));
  check('音高是 C3(48) 和 E3(52)',
        rec.events.length === 2 && rec.events[0].midi === 48 && rec.events[1].midi === 52,
        rec.events.map((e) => e.midi).join(','));
  check('每个音都记下了长度（松手时间 > 按下时间）',
        rec.events.every((e) => e.off > e.on), JSON.stringify(rec.events));

  const gap = rec.events.length === 2 ? rec.events[1].on - rec.events[0].on : -1;
  // 暂停不算进乐谱：两音之间只应差「弹一下 + 停 0.4s + 继续后等 0.9s ≈ 2 秒」，
  // 若把暂停的 1.5 秒也算进去会变成 3.5 秒以上
  check('暂停的这段时间没有被算进乐谱', gap > 1.3 && gap < 2.7, '两音间隔 ' + gap.toFixed(2) + ' 秒');
  check('（对照）离屏计时确实长得多', (wallEnd - wallStart) / 1000 - gap > 1.5,
        '离屏 ' + ((wallEnd - wallStart) / 1000).toFixed(2) + ' 秒 vs 乐谱内 ' + gap.toFixed(2) + ' 秒');

  /* ---------- 6. 生成的脚本要干净 ---------- */
  const parsed = await page.evaluate(() => {
    const p = ScoreParser.parseScore(document.getElementById('out').value);
    return {
      errors: p.errors, warnings: p.warnings, bpm: p.bpm, timeSig: p.timeSig,
      tracks: p.tracks.map((t) => ({ name: t.name, n: t.notes.length,
        notes: t.notes.map((x) => x.name + '@' + x.beat + ':' + x.durBeats) })),
      totalBeats: p.totalBeats,
      bars: document.getElementById('out').value.split('\n').filter((l) => l.trim().endsWith('|')).length,
    };
  });
  check('生成的脚本没有语法错误', parsed.errors.length === 0, JSON.stringify(parsed.errors.slice(0, 2)));
  check('生成的脚本没有小节警告', parsed.warnings.length === 0, JSON.stringify(parsed.warnings.slice(0, 2)));
  check('速度/拍号写对了', parsed.bpm === 120 && parsed.timeSig === '4/4',
        parsed.bpm + ' / ' + parsed.timeSig);
  check('脚本里就是那两个音', parsed.tracks.length === 1 && parsed.tracks[0].n === 2,
        JSON.stringify(parsed.tracks));
  check('一小节一行（后面用休止符补满）', parsed.bars === 1, parsed.bars + ' 行以 | 结尾');
  check('自检通过后下载/工作台按钮可用',
        !(await page.evaluate(() => document.getElementById('btnDownload').disabled)) &&
        !(await page.evaluate(() => document.getElementById('btnOpenBench').disabled)));

  /* ---------- 7. 撤销 / 清空 ---------- */
  await page.click('#btnUndo');
  const afterUndo = await page.evaluate(() => ({
    n: REC.events.length, text: document.getElementById('out').value, state: REC.state,
  }));
  check('撤销会去掉最后一个音并重算脚本',
        afterUndo.n === 1 && /C3/.test(afterUndo.text) && !/E3/.test(afterUndo.text), afterUndo.n + ' 个音');

  await page.click('#btnClear');
  check('清空后回到待机、脚本清空',
        (await page.evaluate(() => REC.state)) === 'idle' &&
        (await page.evaluate(() => REC.events.length)) === 0 &&
        (await page.evaluate(() => document.getElementById('out').value)) === '');

  /* ---------- 8. 鼠标点琴键也能弹（手机上就是靠这个） ---------- */
  await page.click('#btnStart');
  await page.waitForFunction(() => REC.state === 'rec', { timeout: 30000 });
  const box = await page.evaluate(() => {
    const el = document.querySelector('.key[data-midi="60"]');   // 中央 C
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height - 12 };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await sleep(500);
  const mouseHeld = await page.evaluate(() => ({
    on: document.querySelector('.key[data-midi="60"]').classList.contains('on'),
    n: REC.events.length,
  }));
  await page.mouse.up();
  await sleep(100);
  await page.click('#btnEnd');
  const mouseRec = await page.evaluate(() => ({
    events: REC.events.map((e) => e.midi),
    text: document.getElementById('out').value,
  }));
  check('鼠标按琴键也能弹、也会被录下来',
        mouseHeld.on && mouseRec.events.length === 1 && mouseRec.events[0] === 60,
        JSON.stringify(mouseRec.events));
  check('鼠标弹的那次也能生成合法脚本',
        (await page.evaluate(() => ScoreParser.parseScore(document.getElementById('out').value).errors.length)) === 0 &&
        /C4/.test(mouseRec.text));

  /* ---------- 9. 和乐谱工作台的衔接 ---------- */
  const hand = await page.evaluate(() => {
    document.getElementById('out').value = 'title 交接测试\nbpm 100\ntime 4/4\n\n钢琴:\n  C4 D4 E4 F4 |\n';
    return { store: localStorage.getItem('musicmaker.score.dsl') };
  });
  await page.click('#btnOpenBench');
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  const bench = await page.evaluate(() => ({
    url: location.pathname,
    src: document.getElementById('src') ? document.getElementById('src').value : '',
  }));
  check('「在工作台里打开」能把刚录的脚本带过去',
        /index\.html$/.test(bench.url) && /title 交接测试/.test(bench.src),
        bench.url + ' :: ' + JSON.stringify(bench.src.slice(0, 24)));

  /* ---------- 10. 干净 ---------- */
  const br = badReqs.filter((u) => !/favicon/i.test(u));
  check('无资源加载失败（含 audio.js / recorder.js）', br.length === 0, JSON.stringify(br.slice(0, 3)));
  check('无未捕获 JS 异常', errs.length === 0, JSON.stringify(errs.slice(0, 3)));

  await browser.close();
  const failed = results.filter((x) => !x.ok);
  console.log('\n===== ' + (results.length - failed.length) + ' / ' + results.length + ' 通过 =====');
  failed.forEach((f) => console.log('  ✗ ' + f.name + ' :: ' + f.detail));
  if (failed.length) process.exitCode = 1;
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
