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
    tags: Array.prototype.map.call(document.querySelectorAll('.key.kb .tag'), (e) => e.textContent).join(''),
    grids: Array.prototype.map.call(document.getElementById('grid').options, (o) => o.value),
    btns: ['btnStart', 'btnPause', 'btnResume', 'btnEnd'].map((id) => document.getElementById(id).textContent.trim()),
    startEnabled: !document.getElementById('btnStart').disabled,
    pauseEnabled: !document.getElementById('btnPause').disabled,
    kmName: (typeof keymap !== 'undefined') ? keymap.name : '',
    kmCount: (typeof keymap !== 'undefined') ? Object.keys(keymap.keys).length : 0,
    keyToMidi: (typeof keyToMidi !== 'undefined') ? keyToMidi : {},
    presets: Array.prototype.map.call(document.getElementById('kmPreset').options, (o) => o.value),
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
  check('琴键上直接标出"按哪个键"（A S D F …）',
        shape.kb === 18 && /A/.test(shape.tags) && /S/.test(shape.tags) && /D/.test(shape.tags),
        shape.kb + ' 个键有标记：' + shape.tags);

  /* ---------- 1.5 默认键位 = 通用"键盘钢琴"主键区 ---------- */
  const D = await page.evaluate(() => ({
    A: keyToMidi.KeyA, S: keyToMidi.KeyS, D: keyToMidi.KeyD, F: keyToMidi.KeyF,
    H: keyToMidi.KeyH, J: keyToMidi.KeyJ, K: keyToMidi.KeyK,
    W: keyToMidi.KeyW, E: keyToMidi.KeyE, semicolon: keyToMidi.Semicolon,
    z: keyToMidi.KeyZ, x: keyToMidi.KeyX,
    up: keymap.octaveUp, down: keymap.octaveDown,
    presetCount: document.getElementById('kmPreset').options.length,
  }));
  check('默认是"键盘主键区"：A S D F G H J K L ; 就是 do re mi fa sol la si do re mi',
        D.A === 60 && D.S === 62 && D.D === 64 && D.F === 65 && D.H === 69 &&
        D.J === 71 && D.K === 72 && D.semicolon === 76,
        'A=' + D.A + ' S=' + D.S + ' D=' + D.D + ' F=' + D.F + ' H=' + D.H + ' J=' + D.J + ' K=' + D.K + ' ;=' + D.semicolon);
  check('白键上一排就是黑键（W E → C#4 D#4）', D.W === 61 && D.E === 63, 'W=' + D.W + ' E=' + D.E);
  check('Z / X 当换八度，不再占音符', D.z == null && D.x == null && D.up === 'KeyX' && D.down === 'KeyZ',
        'Z=' + D.z + ' X=' + D.x + ' up=' + D.up);
  check('内置了多个预设可选', D.presetCount >= 3, D.presetCount + ' 个预设');

  /* ---------- 2. 和乐谱工作台共用同一份音源 ---------- */
  const shared = await page.evaluate(() => ({
    hasAudio: typeof window.ScoreAudio !== 'undefined',
    hasRec: typeof window.ScoreRecorder !== 'undefined',
    hasKm: typeof window.ScoreKeymap !== 'undefined',
    samePiano: window.ScoreAudio && typeof PIANO !== 'undefined' && window.ScoreAudio.PIANO === PIANO,
    samples: window.ScoreAudio ? Object.keys(window.ScoreAudio.PIANO.samples).length : 0,
    kmFromFile: (typeof keymap !== 'undefined') && keymap.name === (window.ScoreKeymap.DEFAULT.name),
  }));
  check('页面从 audio.js 拿音源（没有自己再复制一份）',
        shared.hasAudio && shared.hasRec && shared.samePiano && shared.samples >= 25,
        '采样 ' + shared.samples + ' 个 / 同一个 PIANO 对象 ' + shared.samePiano);
  check('键位模块独立成 keymap.js，且 keymap.json 确实被读到',
        shared.hasKm && shared.kmFromFile, '有 ScoreKeymap=' + shared.hasKm + ' / 名字对得上=' + shared.kmFromFile);

  /* ---------- 3. 先解锁音频 ---------- */
  await page.mouse.click(700, 8);
  await page.waitForFunction(() => typeof audioReady !== 'undefined' && audioReady === true,
    { timeout: 90000 }).catch(() => {});
  const kind = await page.evaluate(() => (typeof instrumentKind !== 'undefined' ? instrumentKind : '(未定义)'));
  check('钢琴音源就绪（真实采样）', kind === 'sampler', kind);

  /* ---------- 3.5 预备拍：先倒数一小节，这期间弹的不算 ---------- */
  await page.evaluate(() => {
    document.getElementById('bpm').value = '120';       // 4/4 一小节 = 4 拍 = 2 秒
    document.getElementById('chkCountin').checked = true;
  });
  await page.click('#btnStart');
  // 倒数文字是 rAF 里画的，只等 REC.state 会撞上"状态已变但这一帧还没画"的竞态
  const inCountIn = await page.waitForFunction(
    () => REC.state === 'countin' && /预备/.test(document.getElementById('recInfo').textContent),
    { timeout: 10000 }).then(() => true).catch(() => false);
  const countText = await page.evaluate(() => document.getElementById('recInfo').textContent);
  // 预备拍里弹一下，结束之后不该出现在乐谱里
  await page.keyboard.down('KeyA'); await sleep(150); await page.keyboard.up('KeyA');
  const counted = await page.evaluate(() => REC.events.length);
  const toRec = await page.waitForFunction(() => REC.state === 'rec', { timeout: 15000 })
    .then(() => true).catch(() => false);
  await page.click('#btnEnd');
  check('勾上「预备 1 小节」后会先倒数再开始录',
        inCountIn && toRec && /预备/.test(countText), JSON.stringify(countText));
  check('预备拍期间弹的音不会被录进去', counted === 0, counted + ' 个音');
  await page.evaluate(() => { document.getElementById('chkCountin').checked = false; });

  /* ---------- 4. 键盘弹奏：按住要亮、松开要灭 ---------- */
  await page.keyboard.down('KeyA');
  await sleep(120);
  const held = await page.evaluate(() => {
    const el = document.querySelector('.key[data-midi="60"]');
    return { on: el.classList.contains('on'), pressed: pressed.size };
  });
  await page.keyboard.up('KeyA');
  await sleep(120);
  const released = await page.evaluate(() => ({
    on: document.querySelector('.key[data-midi="60"]').classList.contains('on'), pressed: pressed.size,
  }));
  check('敲 A 键会按下 C4（琴键亮起）', held.on && held.pressed === 1, JSON.stringify(held));
  check('松手后琴键熄灭', !released.on && released.pressed === 0, JSON.stringify(released));

  const oct = await page.evaluate(() => ({ shift: octaveShift }));
  await page.keyboard.down('KeyX'); await page.keyboard.up('KeyX');       // 键位表指定的升八度
  const oct2 = await page.evaluate(() => ({ shift: octaveShift }));
  await page.keyboard.down('KeyZ'); await page.keyboard.up('KeyZ');
  const oct3 = await page.evaluate(() => ({ shift: octaveShift }));
  check('Z / X 能换八度', oct.shift === 0 && oct2.shift === 12 && oct3.shift === 0,
        oct.shift + ' → ' + oct2.shift + ' → ' + oct3.shift);

  await page.keyboard.press('ArrowRight');
  const oct4 = await page.evaluate(() => ({ shift: octaveShift, a: keyToMidi.KeyA }));
  await page.keyboard.press('ArrowLeft');
  const oct5 = await page.evaluate(() => ({ shift: octaveShift, a: keyToMidi.KeyA }));
  check('← → 也能换八度（不管键位表怎么写）',
        oct4.shift === 12 && oct4.a === 72 && oct5.shift === 0 && oct5.a === 60,
        '升八度后 A=' + oct4.a + '，回来=' + oct5.a);

  const oct6 = await page.evaluate(() => {
    document.getElementById('octUp').click();
    const up = octaveShift;
    document.getElementById('octDown').click();
    return { up: up, back: octaveShift };
  });
  check('面板上的「音区升高 / 降低」按钮也管用', oct6.up === 12 && oct6.back === 0,
        oct6.up + ' → ' + oct6.back);

  /* ---------- 4.5 换键位：预设 + 导入 JSON ---------- */
  const presetSwitch = await page.evaluate(() => {
    const sel = document.getElementById('kmPreset');
    sel.value = '双排两个八度（DAW / 电钢风格）';
    sel.dispatchEvent(new Event('change'));
    return { name: keymap.name, z: keyToMidi.KeyZ, a: keyToMidi.KeyA, q: keyToMidi.KeyQ, up: keymap.octaveUp };
  });
  check('切到「双排两个八度」预设后，Z 变成 C3、A 不再绑音',
        /双排/.test(presetSwitch.name) && presetSwitch.z === 48 && presetSwitch.a == null &&
        presetSwitch.q === 60 && presetSwitch.up === 'ArrowRight',
        JSON.stringify(presetSwitch));

  // 页面上直接改键位 JSON 文本再导入
  await page.evaluate(() => {
    const sel = document.getElementById('kmPreset');
    sel.value = '键盘钢琴（通用主键区）';
    sel.dispatchEvent(new Event('change'));
  });
  await page.evaluate(() => {
    window.__KM = JSON.stringify({
      name: '我的键位',
      keys: { KeyU: 'C3', KeyI: 'C#3', KeyO: 'D3' },
      octaveUp: 'KeyM', octaveDown: 'KeyN'
    });
  });
  const imported = await page.evaluate(async () => {
    const m = window.ScoreKeymap.fromJSON(window.__KM);
    applyKeymap(m);
    return { name: keymap.name, u: keyToMidi.KeyU, o: keyToMidi.KeyO, a: keyToMidi.KeyA, up: keymap.octaveUp };
  });
  check('导入自定义键位 JSON 后立刻生效',
        imported.name === '我的键位' && imported.u === 48 && imported.o === 50 &&
        imported.a == null && imported.up === 'KeyM', JSON.stringify(imported));

  // 真的用文件选择框导一份进来
  const fs = require('fs');
  const path = require('path');
  const tmpKm = path.join(__dirname, 'fixtures', '键位-自定义.json');
  fs.writeFileSync(tmpKm, JSON.stringify({
    name: '文件导入的键位',
    keys: { KeyG: 'G3', KeyH: 'G#3', KeyJ: 'A3', KeyK: 'A#3', KeyL: 'B3' },
    octaveDown: 'ArrowLeft', octaveUp: 'ArrowRight'
  }, null, 2));
  const input = await page.$('#kmFile');
  await input.uploadFile(tmpKm);
  await page.waitForFunction(() => keymap && keymap.name === '文件导入的键位', { timeout: 8000 })
    .catch(() => {});
  const fromFile2 = await page.evaluate(() => ({
    name: keymap.name, g: keyToMidi.KeyG, l: keyToMidi.KeyL, a: keyToMidi.KeyA,
    saved: !!localStorage.getItem('musicmaker.keymap'),
  }));
  check('用「📂 导入键位 JSON」选文件也能改键位',
        fromFile2.name === '文件导入的键位' && fromFile2.g === 55 && fromFile2.l === 59 &&
        fromFile2.a == null, JSON.stringify(fromFile2));
  check('导入的键位会存到浏览器里（刷新不丢）', fromFile2.saved);

  const badKm = await page.evaluate(() => {
    const m = window.ScoreKeymap.fromJSON(JSON.stringify({
      name: '写坏的', keys: { keya: 'C4', KeyD: '不是音名', KeyE: 'E4' }, octaveUp: 'KeyX'
    }));
    return { warnings: m.warnings, kept: Object.keys(m.keys).length };
  });
  check('键位 JSON 写错会有明确提示，而不是静默失效',
        badKm.warnings.length === 2 && badKm.kept === 1,
        badKm.kept + ' 个可用 / ' + badKm.warnings.length + ' 条提示');

  const exported = await page.evaluate(() => {
    const m = window.ScoreKeymap.fromJSON(JSON.stringify({
      name: '导出测试', keys: { KeyA: 'C4', KeyB: 62 }, octaveUp: 'KeyX', octaveDown: 'KeyZ'
    }));
    return window.ScoreKeymap.toJSON(m);
  });
  check('导出的键位 JSON 能原样再导入回来（往返一致）', (() => {
    const back = require('../keymap.js').fromJSON(exported);
    return back.name === '导出测试' && back.keys.KeyA === 60 && back.keys.KeyB === 62;
  })(), exported.replace(/\s+/g, ' ').slice(0, 90));

  // 后面的录音测试要用回默认键位
  await page.evaluate(() => {
    localStorage.removeItem('musicmaker.keymap');
    const m = window.ScoreKeymap.materialize(window.ScoreKeymap.DEFAULT);
    m.custom = false;
    m.presetId = m.name;
    applyKeymap(m);
  });

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

  await page.keyboard.down('KeyA'); await sleep(600); await page.keyboard.up('KeyA');   // C4
  await sleep(400);
  await page.click('#btnPause');
  const nAtPause = await page.evaluate(() => REC.events.length);
  check('暂停后进入 paused 状态', (await page.evaluate(() => REC.state)) === 'paused');

  await page.keyboard.down('KeyD'); await sleep(500); await page.keyboard.up('KeyD');   // 暂停期间弹，不该被录
  await sleep(1000);
  const nWhilePaused = await page.evaluate(() => REC.events.length);
  check('暂停期间弹的音不会被录进去', nAtPause === 1 && nWhilePaused === 1,
        '暂停前 ' + nAtPause + ' → 暂停期间 ' + nWhilePaused);

  await page.click('#btnResume');
  await sleep(900);
  await page.keyboard.down('KeyF'); await sleep(600); await page.keyboard.up('KeyF');   // F4
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
  check('音高是 C4(60) 和 F4(65)',
        rec.events.length === 2 && rec.events[0].midi === 60 && rec.events[1].midi === 65,
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
    const text = document.getElementById('out').value;
    const p = ScoreParser.parseScore(text);
    // 音乐行 = 既不是 title/bpm/time，也不是以冒号结尾的轨道头
    const music = text.split('\n').map((l) => l.trim()).filter((l) =>
      l && !/^(title|bpm|time|barlines)\b/i.test(l) && !/:$/.test(l));
    return {
      errors: p.errors, warnings: p.warnings, bpm: p.bpm, timeSig: p.timeSig,
      tracks: p.tracks.map((t) => ({ name: t.name, n: t.notes.length,
        notes: t.notes.map((x) => x.name + '@' + x.beat + ':' + x.durBeats) })),
      totalBeats: p.totalBeats,
      musicLines: music.length,
      lastLineEndsWithBar: music.length > 0 && music[music.length - 1].endsWith('|'),
      bars: text.split('\n').filter((l) => l.trim().endsWith('|')).length,
    };
  });
  check('生成的脚本没有语法错误', parsed.errors.length === 0, JSON.stringify(parsed.errors.slice(0, 2)));
  check('生成的脚本没有小节警告', parsed.warnings.length === 0, JSON.stringify(parsed.warnings.slice(0, 2)));
  check('速度/拍号写对了', parsed.bpm === 120 && parsed.timeSig === '4/4',
        parsed.bpm + ' / ' + parsed.timeSig);
  check('脚本里就是那两个音', parsed.tracks.length === 1 && parsed.tracks[0].n === 2,
        JSON.stringify(parsed.tracks));
  // 断言"每个音乐行都是一整小节、行尾带 |"（末尾用休止符补满），
  // 而不是断言"只有 1 小节" —— 第二个音落哪一小节取决于真实计时，写死行数会变成脆弱断言
  check('每个音乐行都是一整小节、行尾带 |（末尾用休止符补满）',
        parsed.bars >= 1 && parsed.bars === parsed.musicLines && parsed.lastLineEndsWithBar,
        parsed.bars + ' 个带 | 的行 / ' + parsed.musicLines + ' 个音乐行');
  check('自检通过后下载/工作台按钮可用',
        !(await page.evaluate(() => document.getElementById('btnDownload').disabled)) &&
        !(await page.evaluate(() => document.getElementById('btnOpenBench').disabled)));

  /* ---------- 7. 撤销 / 清空 ---------- */
  await page.click('#btnUndo');
  const afterUndo = await page.evaluate(() => ({
    n: REC.events.length, text: document.getElementById('out').value, state: REC.state,
  }));
  check('撤销会去掉最后一个音并重算脚本',
        afterUndo.n === 1 && /C4/.test(afterUndo.text) && !/F4/.test(afterUndo.text), afterUndo.n + ' 个音');

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
  check('无资源加载失败（含 audio.js / recorder.js / keymap.js / keymap.json）',
        br.length === 0, JSON.stringify(br.slice(0, 3)));
  check('无未捕获 JS 异常', errs.length === 0, JSON.stringify(errs.slice(0, 3)));

  await browser.close();
  const failed = results.filter((x) => !x.ok);
  console.log('\n===== ' + (results.length - failed.length) + ' / ' + results.length + ' 通过 =====');
  failed.forEach((f) => console.log('  ✗ ' + f.name + ' :: ' + f.detail));
  if (failed.length) process.exitCode = 1;
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
