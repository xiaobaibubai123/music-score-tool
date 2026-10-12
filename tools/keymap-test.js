/**
 * 键位表 单元测试。
 *
 * 被测的 ../keymap.js 就是 record.html 里跑的那一份。
 * 这块最怕的事情是"用户写错一个键位，页面静静地少了一半键，却不给任何提示"，
 * 所以下面重点测的是**写错以后会怎样**，而不是顺利的时候对不对。
 *
 *   node keymap-test.js
 */
const K = require('../keymap.js');

let fails = 0;
const ok = (n, c, d) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (d !== undefined ? '  :: ' + d : '')); };

const flat = (m) => Object.keys(m.keys).map((c) => c + '=' + m.keys[c]).sort().join(' ');

/* ============================================================
   1. 预设本身要自洽
   ============================================================ */
ok('内置了 3 个以上预设', K.PRESETS.length >= 3, K.PRESETS.map((p) => p.name).join(' / '));
ok('默认就是"键盘钢琴（通用主键区）"', K.DEFAULT.name === K.PRESETS[0].name &&
   /主键区/.test(K.DEFAULT.name), K.DEFAULT.name);

{
  let bad = [];
  K.PRESETS.forEach((p) => {
    const m = K.materialize(p);
    const codes = Object.keys(m.keys);
    // 换八度的键不能同时又是音符键，否则一按就既发声又跳八度
    if (codes.indexOf(m.octaveUp) >= 0) bad.push(p.name + ': 升八度键 ' + m.octaveUp + ' 同时是音符');
    if (codes.indexOf(m.octaveDown) >= 0) bad.push(p.name + ': 降八度键 ' + m.octaveDown + ' 同时是音符');
    const ms = codes.map((c) => m.keys[c]);
    if (ms.some((x) => x == null || x < 21 || x > 108)) bad.push(p.name + ': 有音超出钢琴音域');
    if (new Set(ms).size !== ms.length) bad.push(p.name + ': 有两个键绑到了同一个音');
    if (m.warnings.length) bad.push(p.name + ': ' + m.warnings.join('；'));
  });
  ok('每个预设都自洽（换八度键不占音符、音域合法、没有重复音）', bad.length === 0, bad.join(' | '));
}

{
  // 主键区的音高关系必须是 do re mi fa sol la si …
  const m = K.materialize(K.DEFAULT);
  const whites = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon']
    .map((c) => m.keys[c]);
  ok('主键区那排就是 C 大调音阶（全全半全全全半）',
     whites.join(',') === '60,62,64,65,67,69,71,72,74,76', whites.join(','));
  const blacks = ['KeyW', 'KeyE', 'KeyT', 'KeyY', 'KeyU', 'KeyO', 'KeyP'].map((c) => m.keys[c]);
  ok('上一排是黑键 C#4 D#4 F#4 G#4 A#4 C#5 D#5',
     blacks.join(',') === '61,63,66,68,70,73,75', blacks.join(','));
}

/* ============================================================
   2. 解析与容错
   ============================================================ */
{
  const m = K.fromJSON(JSON.stringify({
    name: '我的键位',
    keys: { KeyA: 'C4', KeyB: 62, KeyC: 'D#4', Digit1: 'E4' },
    octaveUp: 'KeyX', octaveDown: 'KeyZ'
  }));
  ok('音名和 MIDI 号都能写', m.keys.KeyA === 60 && m.keys.KeyB === 62 && m.keys.KeyC === 63 && m.keys.Digit1 === 64,
     flat(m));
  ok('name / 换八度键读得对', m.name === '我的键位' && m.octaveUp === 'KeyX' && m.octaveDown === 'KeyZ');
  ok('没有警告', m.warnings.length === 0, JSON.stringify(m.warnings));
}

{
  const m = K.fromJSON(JSON.stringify({
    keys: { keya: 'C4', KeyD: '不是音名', KeyE: 'E4', KeyF: 'C99' }
  }));
  ok('写错按键代码 / 音名只跳过那一条，其余照用',
     Object.keys(m.keys).length === 1 && m.keys.KeyE === 64, flat(m));
  ok('每条错误都有说明', m.warnings.length === 3, JSON.stringify(m.warnings));
  ok('错误提示里说清楚了要写 KeyboardEvent.code', /KeyboardEvent\.code/.test(m.warnings[0]), m.warnings[0]);
  // parsePitch("C99") 会算出 1200，不拦就会变成"1200 号音"到播放时才炸
  ok('越界音名（C99 → MIDI 1200）被拦下', m.keys.KeyF === undefined, 'KeyF=' + m.keys.KeyF);
}

{
  const m = K.fromJSON(JSON.stringify({ keys: { KeyA: 'C4', KeyB: 'C0' } }));
  ok('音域边界外但合法的音会给提示（而不是悄悄接受）',
     m.warnings.length === 1 && /钢琴音域/.test(m.warnings[0]) && m.keys.KeyB === 12, JSON.stringify(m.warnings));
}

{
  const m = K.fromJSON(JSON.stringify({ name: '空的', keys: {} }));
  ok('一个键位都没有时退回内置默认（而不是变成不能弹）',
     Object.keys(m.keys).length === Object.keys(K.materialize(K.DEFAULT).keys).length &&
     m.warnings.length === 1, m.warnings[0]);
}

{
  const m = K.fromJSON(JSON.stringify({ name: '没有 keys' }));
  ok('缺少 keys 字段会有明确提示', m.warnings.length === 1 && /keys/.test(m.warnings[0]), m.warnings[0]);
}

{
  let threw = '';
  try { K.fromJSON('{ 这不是 json'); } catch (e) { threw = e.message; }
  ok('JSON 语法错会抛错（页面才能提示用户）', /合法/.test(threw), threw);
}

/* ============================================================
   3. 导出 / 往返
   ============================================================ */
{
  const src = K.fromJSON(JSON.stringify({
    name: '往返', description: '说明文字',
    keys: { KeyA: 'C4', KeyW: 'C#4', KeyS: 62 }, octaveUp: 'KeyX', octaveDown: 'KeyZ'
  }));
  const text = K.toJSON(src);
  const back = K.fromJSON(text);
  ok('导出的是可读 JSON（音名而不是数字）', /"KeyA": "C4"/.test(text), text.replace(/\s+/g, ' ').slice(0, 80));
  ok('导出再导入，键位一个不差', flat(back) === flat(src) && back.name === '往返', flat(back));
  ok('导出带上说明和换八度键', back.description === '说明文字' && back.octaveUp === 'KeyX');
}

/* ============================================================
   4. 八度偏移
   ============================================================ */
{
  const m = K.materialize(K.DEFAULT);          // C4(60) ~ F5(77)
  const lim = K.shiftLimits(m);
  ok('默认键位的换八度范围合理（还能降 3 个、升 2 个八度）',
     lim.down === 3 && lim.up === 2, JSON.stringify(lim));
  const up = K.resolveAll(m, 12);
  ok('升一个八度后 A 从 C4 变成 C5', up.KeyA === 72 && up.Semicolon === 88, 'A=' + up.KeyA + ' ;=' + up.Semicolon);
  const down = K.resolveAll(m, -36);
  ok('降到最低后正好是 A0 附近的合法音域', down.KeyA === 24 && down.KeyA >= K.LO_MIDI, 'A=' + down.KeyA);
}

{
  // 极端键位：只有两个音，shiftLimits 不该算出负数或越界
  const m = K.fromJSON(JSON.stringify({ keys: { KeyA: 'C0', KeyB: 'C8' } }));
  const lim = K.shiftLimits(m);
  ok('音域已经顶到两头时，换八度范围被夹到 0（不会算出负数）',
     lim.down >= 0 && lim.up >= 0, JSON.stringify(lim));
}

/* ============================================================
   5. 界面显示用的键名
   ============================================================ */
ok('KeyA → A', K.labelOf('KeyA') === 'A');
ok('Digit2 → 2', K.labelOf('Digit2') === '2');
ok('Semicolon → ;', K.labelOf('Semicolon') === ';');
ok('Quote → \'', K.labelOf('Quote') === "'");
ok('ArrowLeft → ←', K.labelOf('ArrowLeft') === '←');
ok('Space → 空格', K.labelOf('Space') === '空格');
ok('认不出来的代码原样返回（不至于显示空白）', K.labelOf('Weird') === 'Weird');

/* ============================================================
   6. keymap.json 必须和内置默认一致
   ------------------------------------------------------------
   仓库根目录那份是给用户直接改的；它和页面内置默认一旦不一致，
   "我明明改了 keymap.json 却没变化"就会变成很难查的问题。
   ============================================================ */
{
  const fs = require('fs');
  const path = require('path');
  const p = path.join(__dirname, '..', 'keymap.json');
  ok('仓库里有 keymap.json', fs.existsSync(p), p);
  if (fs.existsSync(p)) {
    const raw = fs.readFileSync(p, 'utf8');
    const file = K.fromJSON(raw);
    const def = K.materialize(K.DEFAULT);
    ok('keymap.json 没有写错的地方', file.warnings.length === 0, JSON.stringify(file.warnings));
    ok('keymap.json 和内置默认键位完全一致（改了文件不会"没生效"）',
       flat(file) === flat(def) && file.octaveUp === def.octaveUp && file.octaveDown === def.octaveDown,
       flat(file));
    ok('keymap.json 是合法 JSON 对象且带 keys', JSON.parse(raw).keys != null);
  }
}

console.log('\n===== keymap ' + (fails ? '有 ' + fails + ' 项失败' : '全部通过') + ' =====');
if (fails) process.exitCode = 1;
