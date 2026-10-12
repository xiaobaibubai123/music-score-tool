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
  const shape = await page.evaluate(() => {
    const p = document.getElementById('piano');
    const midis = Array.prototype.map.call(p.querySelectorAll('.key'), (e) => +e.dataset.midi);
    const w = document.querySelector('.key.white');
    return {
      keys: midis.length,
      white: p.querySelectorAll('.key.white').length,
      black: p.querySelectorAll('.key.black').length,
      firstMidi: Math.min.apply(null, midis),
      lastMidi: Math.max.apply(null, midis),
      keyW: w ? Math.round(w.getBoundingClientRect().width) : 0,
      kb: p.querySelectorAll('.key.kb').length,
      tags: Array.prototype.map.call(p.querySelectorAll('.key.kb .tag'), (e) => e.textContent).join(''),
      reg: document.getElementById('kbRange').textContent,
      hasOctBtns: !!document.getElementById('octUp') && !!document.getElementById('octDown'),
      grids: Array.prototype.map.call(document.getElementById('grid').options, (o) => o.value),
      btns: ['btnStart', 'btnPause', 'btnResume', 'btnEnd'].map((id) => document.getElementById(id).textContent.trim()),
      startEnabled: !document.getElementById('btnStart').disabled,
      pauseEnabled: !document.getElementById('btnPause').disabled,
      kmName: (typeof keymap !== 'undefined') ? keymap.name : '',
      kmCount: (typeof keymap !== 'undefined') ? keymap.binds.length : -1,
      keyToMidi: (typeof keyToMidi !== 'undefined') ? keyToMidi : {},
      rows: document.querySelectorAll('#kmTable tbody tr').length,
      presets: document.getElementById('kmPreset').options.length,
    };
  });
  check('钢琴只显示一组（C4–C5，13 键 / 8 白 / 5 黑），不是整台 88 键',
        shape.keys === 13 && shape.white === 8 && shape.black === 5 &&
        shape.firstMidi === 60 && shape.lastMidi === 72,
        '共 ' + shape.keys + ' 键 / 白 ' + shape.white + ' / 黑 ' + shape.black +
        ' / ' + shape.firstMidi + '–' + shape.lastMidi);
  check('一组琴键够宽，点得准（每根白键 ≥ 44px）', shape.keyW >= 44, shape.keyW + 'px');
  check('有 ◀ 降一组 / 升一组 ▶ 两个按钮', shape.hasOctBtns);
  check('明确标出当前是哪个音区', /当前音区/.test(shape.reg) && /C4 组/.test(shape.reg) &&
        /小字一组/.test(shape.reg), JSON.stringify(shape.reg));
  check('四个控制键都在（开始 / 暂停 / 继续 / 结束）',
        shape.btns.length === 4 && /开始/.test(shape.btns[0]) && /暂停/.test(shape.btns[1]) &&
        /继续/.test(shape.btns[2]) && /结束/.test(shape.btns[3]), shape.btns.join(' | '));
  check('待机时只有「开始」能按', shape.startEnabled && !shape.pauseEnabled);
  check('量化网格 1/4、1/8、1/16、1/32 都有',
        shape.grids.join(',') === '1/4,1/8,1/16,1/32', shape.grids.join(','));
  check('琴键上直接标出"按哪个键"（A S D F …）',
        shape.kb === 13 && /A/.test(shape.tags) && /S/.test(shape.tags) && /D/.test(shape.tags),
        shape.kb + ' 个键有标记：' + shape.tags);
  check('键位表在页面上是可编辑的（13 行）', shape.rows === 13, shape.rows + ' 行');

  /* ---------- 1.5 默认键位 = 通用"键盘钢琴"主键区 ---------- */
  const D = await page.evaluate(() => ({
    A: keyToMidi.KeyA, S: keyToMidi.KeyS, D: keyToMidi.KeyD, F: keyToMidi.KeyF,
    H: keyToMidi.KeyH, J: keyToMidi.KeyJ, K: keyToMidi.KeyK,
    W: keyToMidi.KeyW, E: keyToMidi.KeyE, U: keyToMidi.KeyU,
    z: keyToMidi.KeyZ, l: keyToMidi.KeyL,
    binds: keymap.binds.length,
    presetCount: document.getElementById('kmPreset').options.length,
  }));
  check('默认是"键盘主键区"：A S D F G H J K 就是 do re mi fa sol la si do',
        D.A === 60 && D.S === 62 && D.D === 64 && D.F === 65 && D.H === 69 &&
        D.J === 71 && D.K === 72,
        'A=' + D.A + ' S=' + D.S + ' D=' + D.D + ' F=' + D.F + ' H=' + D.H + ' J=' + D.J + ' K=' + D.K);
  check('白键上一排就是黑键（W E U → C#4 D#4 A#4）',
        D.W === 61 && D.E === 63 && D.U === 70, 'W=' + D.W + ' E=' + D.E + ' U=' + D.U);
  check('默认就是"一组 13 个键"，不越界到下一组',
        D.binds === 13 && D.l == null && D.z == null, '共 ' + D.binds + ' 键');
  check('内置了多个预设可选', D.presetCount >= 4, D.presetCount + ' 个选项');

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

  /* ---------- 4.5 在页面上直接改键位 ---------- */
  // 换组：◀ ▶ 把整张键位表整体移调一个八度，琴键和标签一起走
  const octUp = await page.evaluate(() => {
    document.getElementById('octUp').click();
    return { lo: +document.querySelector('.key').dataset.midi,
             keys: document.querySelectorAll('.key').length,
             a: keyToMidi.KeyA, reg: document.getElementById('kbRange').textContent };
  });
  check('点「升一组 ▶」：琴键、发声、音区标签一起升一个八度',
        octUp.a === 72 && octUp.lo === 72 && octUp.keys === 13 &&
        /C5 组/.test(octUp.reg) && /小字二组/.test(octUp.reg),
        JSON.stringify(octUp));
  const octDown = await page.evaluate(() => {
    document.getElementById('octDown').click();
    return { a: keyToMidi.KeyA, reg: document.getElementById('kbRange').textContent };
  });
  check('点「◀ 降一组」能回到原音区', octDown.a === 60 && /C4 组/.test(octDown.reg),
        JSON.stringify(octDown));

  // 钢琴不会被"重画成另一个样子"：按琴键前后 DOM 不变
  const before = await page.evaluate(() => document.getElementById('piano').innerHTML.length);
  await page.keyboard.down('KeyD'); await page.keyboard.up('KeyD');
  const after = await page.evaluate(() => document.getElementById('piano').innerHTML.length);
  check('按键不会让钢琴重画/位移', before === after, before + ' → ' + after);

  // Z / X 换音区（快捷键，和按钮等效）
  await page.keyboard.press('KeyX');
  const zxUp = await page.evaluate(() => ({ a: keyToMidi.KeyA, lo: +document.querySelector('.key').dataset.midi,
                                            reg: document.getElementById('kbRange').textContent }));
  await page.keyboard.press('KeyZ');
  const zxDown = await page.evaluate(() => ({ a: keyToMidi.KeyA, lo: +document.querySelector('.key').dataset.midi }));
  check('按 X 升一组、按 Z 降一组（和按钮等效）',
        zxUp.a === 72 && zxUp.lo === 72 && /C5 组/.test(zxUp.reg) &&
        zxDown.a === 60 && zxDown.lo === 60,
        JSON.stringify({ zxUp, zxDown }));

  // 点表格里 C4 那一行的按键，再按 Q —— 应该改绑到 Q，A 随之空出来
  await page.evaluate(() => {
    const rows = document.querySelectorAll('#kmTable tbody tr');
    const row = Array.prototype.filter.call(rows, (r) => r.cells[0].textContent === 'C4')[0];
    row.cells[1].querySelector('button').click();          // 进入"请按一个键…"
  });
  const edited = await page.evaluate(() => {
    const rows = document.querySelectorAll('#kmTable tbody tr');
    const row = Array.prototype.filter.call(rows, (r) => r.cells[0].textContent === 'C4')[0];
    return { capturing: !!capturing, label: row ? row.cells[1].textContent.trim() : '(没这行)' };
  });
  await page.keyboard.press('KeyQ');
  await sleep(60);
  const afterEdit = await page.evaluate(() => ({
    c4: keyToMidi.KeyQ, a: keyToMidi.KeyA, csharp4: keyToMidi.KeyW,
    binds: keymap.binds.length, conflicts: window.ScoreKeymap.conflicts(keymap).length,
    saved: !!localStorage.getItem('musicmaker.keymap'),
    // 录键位的时候按下的那个键不该顺便弹出个音来
    pressed: pressed.size,
  }));
  check('点行里的按键 → 按一个键 → 立刻改绑',
        edited.capturing && /请按一个键/.test(edited.label) &&
        afterEdit.c4 === 60 && afterEdit.a == null && afterEdit.csharp4 === 61 &&
        afterEdit.binds === 13 && afterEdit.conflicts === 0,
        JSON.stringify({ edited, afterEdit }));
  check('录键位时按下的键不会顺便弹出一个音', afterEdit.pressed === 0, '按住的音数 ' + afterEdit.pressed);
  check('页面上改的键位也会存下来', afterEdit.saved);

  // 抢一个已经被别的音占着的键 → 从旧主人身上摘掉，不留下冲突
  await page.evaluate(() => {
    const rows = document.querySelectorAll('#kmTable tbody tr');
    const row = Array.prototype.filter.call(rows, (r) => r.cells[0].textContent === 'C4')[0];
    row.cells[1].querySelector('button').click();
  });
  await page.keyboard.press('KeyW');                        // W 本来是 C#4
  const steal = await page.evaluate(() => ({
    c4: keyToMidi.KeyW, hasCsharp: keymap.binds.some((b) => b.midi === 61),
    binds: keymap.binds.length, rows: document.querySelectorAll('#kmTable tbody tr').length,
    conflicts: window.ScoreKeymap.conflicts(keymap).length,
  }));
  check('抢一个已被占用的键，会把它从旧主人身上摘掉（不留下冲突）',
        steal.c4 === 60 && !steal.hasCsharp && steal.binds === 12 && steal.conflicts === 0,
        JSON.stringify(steal));

  // 删掉一条
  const del = await page.evaluate(() => {
    const rows = document.querySelectorAll('#kmTable tbody tr');
    const row = Array.prototype.filter.call(rows, (r) => r.cells[0].textContent === 'C4')[0];
    row.cells[2].querySelector('button').click();
    return { binds: keymap.binds.length, hasC4: keymap.binds.some((b) => b.midi === 60),
             rows: document.querySelectorAll('#kmTable tbody tr').length };
  });
  check('点 ✕ 能删掉一条绑定', del.binds === 11 && !del.hasC4 && del.rows === 11, JSON.stringify(del));

  /* ---------- 4.6 冲突要标红 ---------- */
  const conflictUI = await page.evaluate(() => {
    applyKeymap(window.ScoreKeymap.fromJSON(JSON.stringify({
      name: '有冲突的键位', notes: { C4: 'KeyA', D4: 'KeyA', E4: 'KeyD' }
    })));
    const bad = document.querySelectorAll('#kmTable tbody tr.bad').length;
    const msgs = document.querySelectorAll('#kmWarn .msg').length;
    const first = document.querySelector('#kmWarn .msg');
    return { bad, msgs, text: first ? first.textContent : '', cls: first ? first.className : '',
             hasFix: !!(first && first.querySelector('button')),
             conflicts: window.ScoreKeymap.conflicts(keymap).length };
  });
  check('同一个键绑给两个音 → 两行都标红',
        conflictUI.conflicts === 1 && conflictUI.bad === 2 && conflictUI.msgs >= 1,
        JSON.stringify(conflictUI));
  check('红色的冲突提示写清了是哪个键、哪两个音',
        /冲突/.test(conflictUI.text) && /KeyA|A/.test(conflictUI.text) &&
        /C4/.test(conflictUI.text) && /D4/.test(conflictUI.text) && /red|msg/.test(conflictUI.cls),
        conflictUI.text.slice(0, 60));

  const fixed = await page.evaluate(() => {
    document.querySelector('#kmWarn .msg button').click();     // 「只保留 C4」
    return { conflicts: window.ScoreKeymap.conflicts(keymap).length,
             bad: document.querySelectorAll('#kmTable tbody tr.bad').length,
             c4: keyToMidi.KeyA, d4: keyToMidi.KeyA };
  });
  check('冲突提示上的一键修复能消掉红色', fixed.conflicts === 0 && fixed.bad === 0, JSON.stringify(fixed));

  /* ---------- 4.7 预设 / 导入 / 导出 ---------- */
  const presetSwitch = await page.evaluate(() => {
    const sel = document.getElementById('kmPreset');
    sel.value = '双排两个八度（DAW / 电钢风格）';
    sel.dispatchEvent(new Event('change'));
    return { name: keymap.name, z: keyToMidi.KeyZ, a: keyToMidi.KeyA, q: keyToMidi.KeyQ,
             conflicts: window.ScoreKeymap.conflicts(keymap).length };
  });
  check('切到「双排两个八度」预设后，Z 变成 C3、A 不再绑音',
        /双排/.test(presetSwitch.name) && presetSwitch.z === 48 && presetSwitch.a == null &&
        presetSwitch.q === 60 && presetSwitch.conflicts === 0, JSON.stringify(presetSwitch));

  // 音符当 key、按键当 value —— 就是用户要的那种写法
  const imported = await page.evaluate(async () => {
    applyKeymap(window.ScoreKeymap.fromJSON(JSON.stringify({
      name: '我的键位', notes: { 'C3': 'KeyU', 'C#3': 'KeyI', 'D3': 'KeyO' }
    })));
    return { name: keymap.name, u: keyToMidi.KeyU, o: keyToMidi.KeyO, a: keyToMidi.KeyA };
  });
  check('导入 {"音符": "按键"} 形式的 JSON 后立刻生效',
        imported.name === '我的键位' && imported.u === 48 && imported.o === 50 &&
        imported.a == null, JSON.stringify(imported));

  // 真的用文件选择框导一份进来
  const fs = require('fs');
  const path = require('path');
  const tmpKm = path.join(__dirname, 'fixtures', '键位-自定义.json');
  fs.writeFileSync(tmpKm, JSON.stringify({
    name: '文件导入的键位',
    notes: { 'G3': 'KeyG', 'G#3': 'KeyH', 'A3': 'KeyJ', 'A#3': 'KeyK', 'B3': 'KeyL' }
  }, null, 2));
  const input = await page.$('#kmFile');
  await input.uploadFile(tmpKm);
  await page.waitForFunction(() => keymap && keymap.name === '文件导入的键位', { timeout: 8000 })
    .catch(() => {});
  const fromFile2 = await page.evaluate(() => ({
    name: keymap.name, g: keyToMidi.KeyG, l: keyToMidi.KeyL, a: keyToMidi.KeyA,
    saved: !!localStorage.getItem('musicmaker.keymap'),
    rows: document.querySelectorAll('#kmTable tbody tr').length,
  }));
  check('用「📂 导入键位 JSON」选文件也能改键位',
        fromFile2.name === '文件导入的键位' && fromFile2.g === 55 && fromFile2.l === 59 &&
        fromFile2.a == null && fromFile2.rows === 5, JSON.stringify(fromFile2));
  check('导入的键位会存到浏览器里（刷新不丢）', fromFile2.saved);

  const badKm = await page.evaluate(() => {
    const m = window.ScoreKeymap.fromJSON(JSON.stringify({
      name: '写坏的', notes: { 'keya': 'KeyX', 'D4': '不是键', 'E4': 'KeyE' }
    }));
    return { warnings: m.warnings, kept: m.binds.length };
  });
  check('键位 JSON 写错会有明确提示，而不是静默失效',
        badKm.warnings.length === 2 && badKm.kept === 1,
        badKm.kept + ' 个可用 / ' + badKm.warnings.length + ' 条提示');

  const exported = await page.evaluate(() => {
    const m = window.ScoreKeymap.fromJSON(JSON.stringify({
      name: '导出测试', notes: { 'C4': 'KeyA', 'D4': 'KeyS' }
    }));
    return window.ScoreKeymap.toJSON(m);
  });
  check('导出的 JSON 是「音符当 key、按键当 value」',
        (() => { const o = JSON.parse(exported); return o.notes && o.notes.C4 === 'KeyA' && o.notes.D4 === 'KeyS'; })(),
        exported.replace(/\s+/g, ' ').slice(0, 80));
  check('导出的键位 JSON 能原样再导入回来（往返一致）', (() => {
    const back = require('../src/keymap.js').fromJSON(exported);
    return back.name === '导出测试' && back.binds.length === 2 &&
           back.binds[0].midi === 60 && back.binds[0].code === 'KeyA';
  })(), exported.replace(/\s+/g, ' ').slice(0, 90));

  /* ---------- 4.8 快捷键：Ctrl 暂停 / 继续 ---------- */
  await page.evaluate(() => {
    document.getElementById('chkCountin').checked = false;
    document.getElementById('bpm').value = '120';
  });
  await page.click('#btnStart');
  await page.waitForFunction(() => REC.state === 'rec', { timeout: 30000 });
  await page.keyboard.down('Control'); await page.keyboard.up('Control');
  const ctrl1 = await page.evaluate(() => REC.state);
  await page.keyboard.down('Control'); await page.keyboard.up('Control');
  const ctrl2 = await page.evaluate(() => REC.state);
  check('录音时按一下 Ctrl 暂停、再按一下继续', ctrl1 === 'paused' && ctrl2 === 'rec',
        ctrl1 + ' → ' + ctrl2);

  // Ctrl+C 这种组合键不能被误当成"按了一下 Ctrl"
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyC');
  await page.keyboard.up('Control');
  await sleep(80);
  const ctrl3 = await page.evaluate(() => REC.state);
  check('Ctrl+C 不会被误当成暂停/继续', ctrl3 === 'rec', ctrl3);
  await page.click('#btnEnd');

  // 键位表把 Z 绑成音符之后：以用户绑的为准，不再换音区
  const zBound = await page.evaluate(() => {
    applyKeymap(window.ScoreKeymap.setBinding(keymap, 48, 'KeyZ'));
    return { z: keyToMidi.KeyZ };
  });
  await page.keyboard.down('KeyZ');
  await sleep(80);
  const zPlay = await page.evaluate(() => ({ held: pressed.size }));
  await page.keyboard.up('KeyZ');
  check('Z 被键位表绑成音符后，按 Z 是弹那个音，而不是换音区',
        zBound.z === 48 && zPlay.held === 1, JSON.stringify({ zBound, zPlay }));

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
