/**
 * 键位表 单元测试。
 *
 * 被测的 ../keymap.js 就是 record.html 里跑的那一份。
 * 这块最怕两件事：
 *   ① 用户写错一个键位，页面静静地少了一半键，不给任何提示
 *   ② 同一个键绑给了两个音（冲突），用户按下去只响一个音，却完全不知道为什么
 * 所以下面重点测的是**写错以后会怎样**和**冲突能不能被认出来**。
 *
 *   node keymap-test.js
 */
const K = require('../src/keymap.js');

let fails = 0;
const ok = (n, c, d) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (d !== undefined ? '  :: ' + d : '')); };

const codesOf = (m) => K.sortBinds(m.binds).map((b) => b.code).join(',');
const midisOf = (m) => K.sortBinds(m.binds).map((b) => b.midi).join(',');

/* ============================================================
   1. 预设本身要自洽
   ============================================================ */
ok('内置了 3 个以上预设', K.PRESETS.length >= 3, K.PRESETS.map((p) => p.name).join(' / '));
ok('默认就是"键盘钢琴（通用主键区）"',
   K.DEFAULT.name === K.PRESETS[0].name && /主键区/.test(K.DEFAULT.name), K.DEFAULT.name);

{
  const bad = [];
  K.PRESETS.forEach((p) => {
    const m = K.materialize(p);
    if (m.warnings.length) bad.push(p.name + ': ' + m.warnings.join('；'));
    if (!m.binds.length) bad.push(p.name + ': 一个键都没有');
    if (new Set(m.binds.map((b) => b.midi)).size !== m.binds.length) bad.push(p.name + ': 一个音绑了两个键');
    if (K.conflicts(m).length) bad.push(p.name + ': 同一个键绑了多个音 —— ' + JSON.stringify(K.conflicts(m)));
    m.binds.forEach((b) => {
      if (b.midi < K.LO_MIDI || b.midi > K.HI_MIDI) bad.push(p.name + ': ' + b.midi + ' 超出钢琴音域');
      if (!K.KNOWN_CODES.has(b.code)) bad.push(p.name + ': 按键 ' + b.code + ' 不认识');
    });
  });
  ok('每个预设都自洽（无冲突、音域合法、按键都认识）', bad.length === 0, bad.join(' | '));
}

{
  // 主键区的音高关系必须是 do re mi fa sol la si …
  const m = K.materialize(K.DEFAULT);
  const pick = (n) => (m.binds.filter((b) => b.midi === n)[0] || {}).code;
  ok('主键区那排就是 C 大调音阶（到高八度的 do 为止）',
     [60, 62, 64, 65, 67, 69, 71, 72].map(pick).join(',') === 'KeyA,KeyS,KeyD,KeyF,KeyG,KeyH,KeyJ,KeyK',
     [60, 62, 64, 65, 67, 69, 71, 72].map(pick).join(','));
  ok('上一排就是黑键 C#4 D#4 F#4 G#4 A#4',
     [61, 63, 66, 68, 70].map(pick).join(',') === 'KeyW,KeyE,KeyT,KeyY,KeyU',
     [61, 63, 66, 68, 70].map(pick).join(','));
  ok('默认正好一组：13 个键（C4–C5）', m.binds.length === 13, m.binds.length);
}

/* ============================================================
   1.6 "一组"怎么算 —— 钢琴只画一组，靠这个函数决定范围
   ============================================================ */
{
  const one = K.materialize(K.DEFAULT);                     // C4–C5
  const g1 = K.groupRange(one);
  ok('C4–C5 → 正好一组（60–72，8 白 5 黑）',
     g1.lo === 60 && g1.hi === 72 && g1.octaves === 1, JSON.stringify(g1));

  const tw = K.materialize(K.PRESETS[1]);                   // DAW 那套 C3–B4
  const g2 = K.groupRange(tw);
  ok('C3–B4 跨两组时，显示也从整组到整组（48–72，两组）',
     g2.lo === 48 && g2.hi === 72 && g2.octaves === 2, JSON.stringify(g2));

  const only = K.fromJSON(JSON.stringify({ notes: { 'F#4': 'KeyA' } }));
  const g3 = K.groupRange(only);
  ok('只有一个音时也只画那一组（不会只画一个键）',
     g3.lo === 60 && g3.hi === 72, JSON.stringify(g3));

  ok('组的中文名：C4 = 小字一组', K.groupName(60) === '小字一组', K.groupName(60));
  ok('组的中文名：C3 = 小字组', K.groupName(48) === '小字组', K.groupName(48));
  ok('组的中文名：C2 = 大字组', K.groupName(36) === '大字组', K.groupName(36));
  ok('组的中文名：C5 = 小字二组', K.groupName(72) === '小字二组', K.groupName(72));

  const atEdge = K.fromJSON(JSON.stringify({ notes: { 'C8': 'KeyA' } }));
  const g4 = K.groupRange(atEdge);
  ok('最高一个 C 不会算出超过钢琴范围的组', g4.hi <= K.HI_MIDI, JSON.stringify(g4));
}

/* ============================================================
   2. JSON 方向：音符当 key、按键当 value
   ============================================================ */
{
  const m = K.fromJSON(JSON.stringify({ notes: { C4: 'KeyA', 'C#4': 'KeyW', D4: 'KeyS' } }));
  ok('正式写法是 { 音符: 按键 }', midisOf(m) === '60,61,62' && codesOf(m) === 'KeyA,KeyW,KeyS',
     codesOf(m) + ' → ' + midisOf(m));
  ok('这种写法没有警告', m.warnings.length === 0, JSON.stringify(m.warnings));
}

{
  // 兼容旧的 { 按键: 音符 }，靠内容投票判断方向
  const m = K.fromJSON(JSON.stringify({ keys: { KeyA: 'C4', KeyW: 'C#4' } }));
  ok('旧的 { 按键: 音符 } 也认（投票判断方向）',
     midisOf(m) === '60,61' && codesOf(m) === 'KeyA,KeyW', codesOf(m) + ' → ' + midisOf(m));
  ok('方向判对了就没有警告', m.warnings.length === 0, JSON.stringify(m.warnings));
}

{
  // "F4" 既是音名 F4、又是功能键 F4 —— 这是唯一真有歧义的地方，靠值来定
  const a = K.fromJSON(JSON.stringify({ notes: { F4: 'KeyA' } }));
  ok('"F4": "KeyA" 认成"音 F4 用 A 键"', a.binds.length === 1 && a.binds[0].midi === 65 && a.binds[0].code === 'KeyA',
     JSON.stringify(a.binds));
  const b = K.fromJSON(JSON.stringify({ keys: { F4: 'C4' } }));
  ok('{ "F4": "C4" } 认成"F4 功能键发 C4"', b.binds.length === 1 && b.binds[0].midi === 60 && b.binds[0].code === 'F4',
     JSON.stringify(b.binds));
}

{
  const m = K.fromJSON(JSON.stringify({ format: 'key-note', notes: { C4: 'KeyA' } }));
  ok('可以显式写 format 定死方向，不靠猜', m.binds.length === 0 || m.binds[0].midi === 60,
     JSON.stringify(m.binds));
  const m2 = K.fromJSON(JSON.stringify({ format: 'note-key', notes: { C4: 'KeyA' } }));
  ok('format: note-key 正常', m2.binds[0].midi === 60 && m2.binds[0].code === 'KeyA');
}

/* ============================================================
   3. 冲突 —— 同一个键绑给两个音
   ============================================================ */
{
  const m = K.fromJSON(JSON.stringify({ notes: { C4: 'KeyA', D4: 'KeyA' } }));
  const c = K.conflicts(m);
  ok('同一个键绑给两个音会被认出来', c.length === 1 && c[0].code === 'KeyA' &&
     c[0].midis.join(',') === '60,62', JSON.stringify(c));
  ok('冲突时运行时只发一个音（低的那个先到先得）',
     JSON.stringify(K.codeToMidi(m)) === '{"KeyA":60}', JSON.stringify(K.codeToMidi(m)));
}

{
  const m = K.fromJSON(JSON.stringify({ notes: { C4: 'KeyA', D4: 'KeyS', E4: 'KeyD' } }));
  ok('没有冲突时 conflicts 是空的', K.conflicts(m).length === 0, JSON.stringify(K.conflicts(m)));
}

{
  const m = K.fromJSON(JSON.stringify({ notes: { C4: 'KeyA', D4: 'KeyA', E4: 'KeyA' } }));
  ok('三个音抢一个键也只报一条冲突（三个音都在里面）',
     K.conflicts(m).length === 1 && K.conflicts(m)[0].midis.length === 3,
     JSON.stringify(K.conflicts(m)));
}

/* ============================================================
   4. 解析与容错
   ============================================================ */
{
  const m = K.fromJSON(JSON.stringify({
    name: '我的键位',
    notes: { C4: 'KeyA', '62': 'KeyS', E4: 'KeyC' }   // 音符写音名，也可以写 MIDI 号
  }));
  ok('音符可以写音名，也可以写 MIDI 号', midisOf(m) === '60,62,64', midisOf(m));
  ok('这种写法也没有警告', m.warnings.length === 0, JSON.stringify(m.warnings));
}

{
  const m = K.fromJSON(JSON.stringify({
    notes: { '不是音名': 'KeyA', D4: 'keya', E4: 'KeyC', C99: 'KeyD' }
  }));
  ok('写坏的只跳过那一条，其余照用',
     Object.keys(m.binds).length === 1 && m.binds[0].midi === 64, JSON.stringify(m.binds));
  ok('每条错误都有说明', m.warnings.length === 3, JSON.stringify(m.warnings));
  ok('提示里说清楚了要写 KeyboardEvent.code', /KeyboardEvent\.code/.test(m.warnings[1]), m.warnings[1]);
  // parsePitch("C99") 会算出 1200，不拦就会变成"1200 号音"到播放时才炸
  ok('越界音名（C99 → MIDI 1200）被拦下', !m.binds.some((b) => b.midi === 1200));
}

{
  const m = K.fromJSON(JSON.stringify({ notes: { C0: 'KeyA', C4: 'KeyB', C9: 'KeyC' } }));
  ok('超出钢琴音域的音会给提示（C0 / C9）',
     m.warnings.filter((w) => /钢琴音域/.test(w)).length === 2, JSON.stringify(m.warnings));
}

{
  const m = K.fromJSON(JSON.stringify({ notes: { C4: 'Escape' } }));
  ok('把 Escape 绑成音符会给提示（它还要用来取消录键位）',
     m.warnings.length === 1 && /Escape/.test(m.warnings[0]), JSON.stringify(m.warnings));
  const m2 = K.fromJSON(JSON.stringify({ notes: { C4: 'ShiftLeft' } }));
  ok('绑修饰键也会给提示', m2.warnings.length === 1 && /ShiftLeft/.test(m2.warnings[0]), JSON.stringify(m2.warnings));
}

{
  const m = K.fromJSON(JSON.stringify({ notes: {} }));
  ok('一个键位都没有时退回内置默认（而不是变成不能弹）',
     m.binds.length === K.materialize(K.DEFAULT).binds.length && m.warnings.length === 1, m.warnings[0]);
}

{
  const m = K.fromJSON(JSON.stringify({ name: '没有 notes' }));
  ok('缺少 notes 字段会有明确提示', m.warnings.length === 1 && /notes/.test(m.warnings[0]), m.warnings[0]);
}

{
  let threw = '';
  try { K.fromJSON('{ 这不是 json'); } catch (e) { threw = e.message; }
  ok('JSON 语法错会抛错（页面才能提示用户）', /合法/.test(threw), threw);
}

/* ============================================================
   5. 导出 / 往返
   ============================================================ */
{
  const src = K.fromJSON(JSON.stringify({ name: '往返', notes: { D4: 'KeyS', C4: 'KeyA' } }));
  const text = K.toJSON(src);
  const obj = JSON.parse(text);
  ok('导出的 JSON 里音符是 key、按键是 value', obj.notes && obj.notes.C4 === 'KeyA' && obj.notes.D4 === 'KeyS',
     text.replace(/\s+/g, ' ').slice(0, 70));
  ok('导出按音高排序（低音在前）', Object.keys(obj.notes).join(',') === 'C4,D4', Object.keys(obj.notes).join(','));
  ok('不带 format 字段（保持文件干净，靠内容自动判方向）', obj.format === undefined);
  const back = K.fromJSON(text);
  ok('导出再导入，键位一个不差', codesOf(back) === codesOf(src) && midisOf(back) === midisOf(src),
     codesOf(back));
}

/* ============================================================
   6. 编辑操作（页面上点着改用的就是这几个）
   ============================================================ */
{
  const m = K.materialize(K.DEFAULT);
  const moved = K.setBinding(m, 62, 'KeyW');          // 把 C#4 的 W 抢过来给 D4
  ok('改绑一个用过的键，会把它从旧主人身上摘掉（不会留下冲突）',
     K.conflicts(moved).length === 0 &&
     !moved.binds.some((b) => b.midi === 61) &&
     moved.binds.filter((b) => b.code === 'KeyW').length === 1 &&
     moved.binds.filter((b) => b.code === 'KeyW')[0].midi === 62,
     K.sortBinds(moved.binds).filter((b) => b.code === 'KeyW').map((b) => b.midi).join(','));

  const added = K.setBinding(m, 79, 'Digit9');        // 给一个原本没有的音加键
  ok('可以给原本没有键位的音加一个键', added.binds.some((b) => b.midi === 79 && b.code === 'Digit9'));

  const one = K.setBinding(m, 62, 'KeyA');            // A 从 C4 换到 D4
  ok('同一个音换键 = 覆盖，不会变成两条',
     one.binds.filter((b) => b.midi === 62).length === 1 &&
     !one.binds.some((b) => b.midi === 60), JSON.stringify(K.sortBinds(one.binds).slice(0, 3)));

  const removed = K.removeNote(m, 60);
  ok('删掉一个音的绑定', removed.binds.length === m.binds.length - 1 &&
     !removed.binds.some((b) => b.midi === 60));

  ok('编辑出来的键位表不再是"内置"（导出后要能存下来）', moved.builtin === false);
}

{
  const m = K.materialize(K.DEFAULT);                 // C4..C5
  const up = K.transpose(m, 12);
  ok('整组升八度：C4→C5、C5→C6', K.range(up).lo === 72 && K.range(up).hi === 84,
     K.range(up).lo + '–' + K.range(up).hi);
  ok('整组升八度不改变按键（只是每个键换了个音）', codesOf(up) === codesOf(m));
  ok('升完之后组名也跟着变（小字一组 → 小字二组）',
     K.groupName(K.groupRange(up).lo) === '小字二组', K.groupName(K.groupRange(up).lo));
  const down = K.transpose(m, -12);
  ok('整组降八度：C4→C3', K.range(down).lo === 48 && K.range(down).hi === 60,
     K.range(down).lo + '–' + K.range(down).hi);

  const wayDown = K.transpose(m, -60);                // 会撞到 A0 以下
  ok('整组移调撞到音域边界时，超出的音被丢掉并给出说明',
     wayDown.warnings.length > 0 && wayDown.binds.every((b) => b.midi >= K.LO_MIDI),
     JSON.stringify(wayDown.warnings));
}

/* ============================================================
   7. 界面显示用的键名
   ============================================================ */
ok('KeyA → A', K.labelOf('KeyA') === 'A');
ok('Digit2 → 2', K.labelOf('Digit2') === '2');
ok('Semicolon → ;', K.labelOf('Semicolon') === ';');
ok('Quote → \'', K.labelOf('Quote') === "'");
ok('ArrowLeft → ←', K.labelOf('ArrowLeft') === '←');
ok('Space → 空格', K.labelOf('Space') === '空格');
ok('认不出来的代码原样返回（不至于显示空白）', K.labelOf('Weird') === 'Weird');

ok('looksLikeNote("C4") = true', K.looksLikeNote('C4') === true);
ok('looksLikeNote("KeyA") = false', K.looksLikeNote('KeyA') === false);
ok('looksLikeCode("KeyA") = true', K.looksLikeCode('KeyA') === true);

/* ============================================================
   8. keymap.json 必须和内置默认一致
   ------------------------------------------------------------
   仓库根目录那份是给用户直接改的；它和页面内置默认一旦不一致，
   "我明明改了 keymap.json 却没变化"就会变成很难查的问题。
   ============================================================ */
{
  const fs = require('fs');
  const path = require('path');
  const p = path.join(__dirname, '..', 'config', 'keymap.json');
  ok('仓库里有 keymap.json', fs.existsSync(p), p);
  if (fs.existsSync(p)) {
    const raw = fs.readFileSync(p, 'utf8');
    const obj = JSON.parse(raw);
    const file = K.fromJSON(raw);
    const def = K.materialize(K.DEFAULT);
    ok('keymap.json 用的是「音符 → 按键」写法', obj.notes && obj.notes.C4 === 'KeyA',
       JSON.stringify(Object.keys(obj.notes || {}).slice(0, 3)));
    ok('keymap.json 没有写错的地方', file.warnings.length === 0, JSON.stringify(file.warnings));
    ok('keymap.json 和内置默认键位完全一致（改了文件不会"没生效"）',
       codesOf(file) === codesOf(def) && midisOf(file) === midisOf(def), codesOf(file));
    ok('keymap.json 里没有冲突', K.conflicts(file).length === 0, JSON.stringify(K.conflicts(file)));
  }
}

console.log('\n===== keymap ' + (fails ? '有 ' + fails + ' 项失败' : '全部通过') + ' =====');
if (fails) process.exitCode = 1;
