/**
 * 录音 → 乐谱脚本 的单元测试。
 *
 * 被测的 ../recorder.js 就是 record.html 里跑的那一份（浏览器里挂 window.ScoreRecorder），
 * 所以这里测到的行为就是用户实际得到的行为，不存在"测了个过时副本"。
 *
 *   node recorder-test.js
 */
const { parseScore, formatScore } = require('../src/parser.js');
const R = require('../src/recorder.js');
const { build, quantize, durSuffix, tpbOf, beatsPerBarOf, GRIDS } = R;

let fails = 0;
const ok = (n, c, d) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (d !== undefined ? '  :: ' + d : '')); };

/* 确定性伪随机（可复现，不用 Math.random —— 失败信息要能重放） */
function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

/** 生成的文本 → 音符列表（按 tick 计），用来和工作区里"用户实际弹的"逐个比对 */
function tickNotes(text, tpb) {
  const p = parseScore(text);
  const out = [];
  for (const t of p.tracks) {
    for (const n of t.notes) {
      out.push(t.name + '|' + n.midi + '|' + Math.round(n.beat * tpb) + '|' +
               Math.round((n.beat + n.durBeats) * tpb));
    }
  }
  return out.sort();
}
/** 期望值：用户弹的每个音 → 应该落在哪条轨道上 */
function wantKeys(notes, o) {
  return notes.map((n) => {
    const name = o.splitHands ? (n.midi >= o.splitMidi ? '右手' : '左手') : '钢琴';
    return name + '|' + n.midi + '|' + n.start + '|' + n.end;
  }).sort();
}
const barLines = (text) => text.split('\n').map((l) => l.trim()).filter((l) => l.endsWith('|'));

/* ============================================================
   1. 网格 / 拍号 / 时值记号
   ============================================================ */
ok('1/8 网格 = 每拍 2 格', tpbOf('1/8') === 2, tpbOf('1/8'));
ok('1/16 网格 = 每拍 4 格', tpbOf('1/16') === 4, tpbOf('1/16'));
ok('未知网格退回 1/8', tpbOf('乱写') === 2, tpbOf('乱写'));
ok('4/4 每小节 4 拍', beatsPerBarOf('4/4') === 4);
ok('3/4 每小节 3 拍', beatsPerBarOf('3/4') === 3);
ok('6/8 每小节 3 拍', beatsPerBarOf('6/8') === 3);
ok('拍号写坏时按 4/4 处理', beatsPerBarOf('x') === 4);

ok('1 拍不写后缀（C4 比 C4:q 好读）', durSuffix(1, 1) === '', JSON.stringify(durSuffix(1, 1)));
ok('2 拍 → :h', durSuffix(2, 1) === ':h', durSuffix(2, 1));
ok('4 拍 → :w', durSuffix(4, 1) === ':w', durSuffix(4, 1));
ok('半拍 → :e', durSuffix(1, 2) === ':e', durSuffix(1, 2));
ok('3 拍 → 数字 :3', durSuffix(3, 1) === ':3', durSuffix(3, 1));
ok('32 分 → :t', durSuffix(1, 8) === ':t', durSuffix(1, 8));
// 这里必须原样输出：早先用了 round2，0.375 变成 0.38，攒到最后每小节多 0.01 拍
ok('1/32 网格的 0.375 拍不能被四舍五入成 0.38', durSuffix(3, 8) === ':0.375', durSuffix(3, 8));

/* ============================================================
   2. 量化
   ============================================================ */
{
  // bpm 120 → 一拍 0.5s；1/8 网格 → 每格 0.25s
  const q = quantize([{ midi: 60, on: 0.26, off: 0.51 }], { bpm: 120, grid: '1/8' });
  ok('量化：0.26s 落到第 1 格', q.notes[0].start === 1, q.notes[0].start);
  ok('量化：0.51s 落到第 2 格', q.notes[0].end === 2, q.notes[0].end);

  const short = quantize([{ midi: 60, on: 0.30, off: 0.31 }], { bpm: 120, grid: '1/8' });
  ok('太短的一碰至少给一格（不会变成 0 时值）',
     short.notes[0].end - short.notes[0].start === 1, JSON.stringify(short.notes[0]));

  const dup = quantize([{ midi: 60, on: 0, off: 0.25 }, { midi: 60, on: 0.02, off: 0.5 }],
                       { bpm: 120, grid: '1/8' });
  ok('同一个音在同一格按两次会合并（不然会像加了失真）', dup.notes.length === 1 && dup.notes[0].end === 2,
     JSON.stringify(dup.notes));

  const overlap = quantize([{ midi: 60, on: 0, off: 2.0 }, { midi: 60, on: 0.6, off: 1.0 }],
                           { bpm: 120, grid: '1/8' });
  ok('同一个音高先后重叠会被裁开（钢琴上就是重新击弦）',
     overlap.notes.length === 2 && overlap.notes[0].end === overlap.notes[1].start,
     JSON.stringify(overlap.notes));

  const neg = quantize([{ midi: 60, on: -5, off: -5 }], { bpm: 120, grid: '1/8' });
  ok('负时间被夹到 0', neg.notes[0].start === 0 && neg.notes[0].end === 1);
}

/* ============================================================
   3. build：小节 / 休止 / 和弦 / 补满末尾
   ============================================================ */
{
  // 4 个四分音符（bpm 120 → 每拍 0.5s）
  const ev = [0, 1, 2, 3].map((i) => ({ midi: 60 + i * 2, on: i * 0.5, off: i * 0.5 + 0.45 }));
  const r = build({ events: ev, bpm: 120, grid: '1/8', timeSig: '4/4', title: '测试' });
  const p = parseScore(r.text);
  ok('4 个四分音符 = 1 小节', r.stats.bars === 1, r.stats.bars);
  ok('解析无错误', p.errors.length === 0, JSON.stringify(p.errors));
  ok('解析无警告（小节线一条不差）', p.warnings.length === 0, JSON.stringify(p.warnings));
  ok('每小节一行、行尾是 |', barLines(r.text).length === 1 && /C4 D4 E4 F#4 \|/.test(r.text),
     JSON.stringify(barLines(r.text)));
  ok('弹的 4 个音一个不差地出现在脚本里',
     tickNotes(r.text, r.stats.tpb).join(',') === wantKeys(r.notes, {}).join(','),
     tickNotes(r.text, r.stats.tpb).join(','));
}

{
  // 只弹一个四分音符 → 剩下的 3 拍要补休止符，否则解析器会报"这一小节只有 1 拍"
  const r = build({ events: [{ midi: 60, on: 0, off: 0.5 }], bpm: 120, grid: '1/8', timeSig: '4/4' });
  const p = parseScore(r.text);
  ok('末尾缺拍会自动补休止符', p.warnings.length === 0, JSON.stringify(p.warnings));
  ok('补的是休止符而不是音符', r.stats.notes === 1 && barLines(r.text)[0] === 'C4 r:3 |',
     barLines(r.text)[0]);
}

{
  // 开头等 2 秒才开始弹
  const r = build({ events: [{ midi: 60, on: 2, off: 2.5 }], bpm: 120, grid: '1/8', timeSig: '4/4' });
  ok('默认去掉开头的空白（脚本从第一拍开始）', /^\s*C4/m.test(r.text), JSON.stringify(r.text));
  const keep = build({ events: [{ midi: 60, on: 2, off: 2.5 }], bpm: 120, grid: '1/8',
                       timeSig: '4/4', trimLead: false });
  ok('关掉「去掉开头空白」就保留休止符', barLines(keep.text)[0].startsWith('r'),
     JSON.stringify(barLines(keep.text)));
}

{
  // 一个音符跨 2 小节 → 必须在过小节线的地方切开，后半段用 ~ 接上
  const r = build({ events: [{ midi: 60, on: 0, off: 4.0 }], bpm: 120, grid: '1/8', timeSig: '4/4' });
  const p = parseScore(r.text);
  ok('跨小节的长音被小节线切开', p.warnings.length === 0 && r.stats.bars === 2, JSON.stringify(p.warnings));
  ok('切开的后半段写成 ~C4（不是重新敲一次）', /~C4/.test(r.text), JSON.stringify(barLines(r.text)));
  ok('切开后回放仍是"一个 4 拍长音"',
     tickNotes(r.text, r.stats.tpb).join(',') === wantKeys(r.notes, {}).join(','),
     tickNotes(r.text, r.stats.tpb).join(','));
}

{
  // 和弦：C4 E4 G4 同时按，G4 先松手
  const r = build({
    events: [
      { midi: 60, on: 0, off: 1.0 },
      { midi: 64, on: 0, off: 1.0 },
      { midi: 67, on: 0, off: 0.5 }
    ], bpm: 120, grid: '1/16', timeSig: '4/4' });
  ok('同时按下的音压成一个和弦记号', /\[C4 E4 G4\]/.test(r.text), JSON.stringify(barLines(r.text)));
  ok('G4 先松手后，C4/E4 用 ~ 继续而不是重新击键', /\[~C4 ~E4\]/.test(r.text), JSON.stringify(barLines(r.text)));
  ok('和弦+延续能被解析器还原成 3 个音',
     parseScore(r.text).tracks[0].notes.length === 3,
     JSON.stringify(parseScore(r.text).tracks[0].notes.map(n => n.name + ':' + n.durBeats)));
  ok('和弦版本无警告', parseScore(r.text).warnings.length === 0);
  ok('和弦版本每个音的起止都对',
     tickNotes(r.text, r.stats.tpb).join(',') === wantKeys(r.notes, {}).join(','),
     tickNotes(r.text, r.stats.tpb).join(','));
}

{
  // 按住的长音 + 走的低音：长音不能被写成好几遍
  const r = build({
    events: [
      { midi: 72, on: 0, off: 2.0 },                       // C5 按住 4 拍
      { midi: 48, on: 0, off: 0.5 }, { midi: 50, on: 0.5, off: 1.0 },
      { midi: 52, on: 1.0, off: 1.5 }, { midi: 53, on: 1.5, off: 2.0 }
    ], bpm: 120, grid: '1/16', timeSig: '4/4' });
  const notes = parseScore(r.text).tracks[0].notes;
  const c5 = notes.filter((n) => n.name === 'C5');
  ok('按住不动的长音在乐谱里只有一个 C5', c5.length === 1 && Math.abs(c5[0].durBeats - 4) < 1e-9,
     JSON.stringify(notes.map(n => n.name + ':' + n.durBeats)));
  ok('长音 + 走低音：全部音都对得上',
     tickNotes(r.text, r.stats.tpb).join(',') === wantKeys(r.notes, {}).join(','),
     tickNotes(r.text, r.stats.tpb).join(','));

  // 回归：后进来的音落在前一个音里面，以前会被整个吃掉
  const inside = build({
    events: [{ midi: 60, on: 0, off: 5.0 }, { midi: 64, on: 3.0, off: 4.0 }],
    bpm: 120, grid: '1/8', timeSig: '4/4'
  });
  ok('落在别的音中间的短音不会被吃掉', inside.stats.notes === 2 &&
     /E4/.test(inside.text), JSON.stringify(inside.text));
  ok('落在别的音中间的短音起止都对',
     tickNotes(inside.text, inside.stats.tpb).join(',') === wantKeys(inside.notes, {}).join(','),
     tickNotes(inside.text, inside.stats.tpb).join(','));
}

{
  // 空输入
  const r = build({ events: [], bpm: 120 });
  ok('一个音都没录到时不编造脚本', r.text === '' && r.stats.notes === 0);
}

{
  // 分左右手
  const r = build({
    events: [
      { midi: 48, on: 0, off: 0.5 },   // C3 → 左手
      { midi: 72, on: 0, off: 0.5 }    // C5 → 右手
    ], bpm: 120, grid: '1/8', timeSig: '4/4', splitHands: true, splitMidi: 60 });
  const p = parseScore(r.text);
  ok('分轨后是两条轨道', p.tracks.length === 2, p.tracks.map((t) => t.name).join('/'));
  ok('右手排在前面（歌词默认对齐第一条）', p.tracks[0].name === '右手', p.tracks[0].name);
  ok('左右手各自的小节都对得上（都没警告）', p.warnings.length === 0, JSON.stringify(p.warnings));
  ok('左右手分轨后音符一个不差',
     tickNotes(r.text, r.stats.tpb).join(',') === wantKeys(r.notes, { splitHands: true, splitMidi: 60 }).join(','),
     tickNotes(r.text, r.stats.tpb).join(','));
}

{
  // 分轨时两手起始时间不同 → 两边都要用休止符补齐，小节线才会对齐
  const r = build({
    events: [
      { midi: 72, on: 0, off: 0.5 },
      { midi: 48, on: 1.0, off: 1.5 }
    ], bpm: 120, grid: '1/8', timeSig: '4/4', splitHands: true, splitMidi: 60 });
  const p = parseScore(r.text);
  ok('左右手时间不同也能对齐小节', p.warnings.length === 0, JSON.stringify(p.warnings));
  ok('左右手时间不同也一个音不差',
     tickNotes(r.text, r.stats.tpb).join(',') === wantKeys(r.notes, { splitHands: true, splitMidi: 60 }).join(','),
     tickNotes(r.text, r.stats.tpb).join(','));
}

{
  // 3/4 拍
  const ev = [0, 1, 2].map((i) => ({ midi: 60 + i, on: i * 0.5, off: i * 0.5 + 0.45 }));
  const r = build({ events: ev, bpm: 120, grid: '1/8', timeSig: '3/4' });
  ok('3/4 一小节装 3 拍', r.stats.bars === 1 && parseScore(r.text).warnings.length === 0,
     JSON.stringify(parseScore(r.text).warnings));
}

{
  // 生成出来的文本再过一次 formatScore 不应该变化（说明本来就是一行一小节）
  const r = build({ events: [0, 1, 2, 3, 4, 5].map((i) => ({ midi: 60, on: i * 0.5, off: i * 0.5 + 0.4 })),
                    bpm: 120, grid: '1/8', timeSig: '4/4' });
  const again = formatScore(r.text);
  ok('生成的脚本已经是"一行一小节"，格式化不会再改它',
     again.replace(/\s+/g, ' ') === r.text.replace(/\s+/g, ' '));
}

/* ============================================================
   4. 模糊测试：随便弹，生成的脚本都必须能被解析器干净地读回来，
      而且【每个音的起止】要和工作区里弹的一模一样。
   ------------------------------------------------------------
   这是这套逻辑最该防的事故：
     · 节奏一重叠/拖长就把小节线算错 → 用户拿到"能播但每小节都报警告"的谱子
     · 落在别的音中间的短音被吃掉 → 少音
     · 按住的长音被拆成好几段 → 回放变成反复敲同一个键
   上面三个都是真发生过的，所以这里逐个音比对，而不是只数个数。
   ============================================================ */
{
  const rand = lcg(20240607);
  const grids = GRIDS.map((g) => g.id);
  const sigs = ['4/4', '3/4', '2/4', '6/8'];
  let cases = 0, badParse = 0, badBars = 0, mismatch = 0, worst = null;
  for (let t = 0; t < 400; t++) {
    const bpm = 40 + Math.floor(rand() * 200);
    const grid = grids[Math.floor(rand() * grids.length)];
    const timeSig = sigs[Math.floor(rand() * sigs.length)];
    const splitHands = rand() < 0.5;
    const opt = { bpm, grid, timeSig, splitHands, splitMidi: 60, trimLead: rand() < 0.7 };
    const spb = 60 / bpm;
    const n = 1 + Math.floor(rand() * 24);
    const events = [];
    let cursor = rand() * 3;
    for (let i = 0; i < n; i++) {
      const stack = 1 + Math.floor(rand() * 3);              // 单音或和弦
      const on = cursor;
      const hold = (0.1 + rand() * 3) * spb;
      const base = 40 + Math.floor(rand() * 40);
      for (let k = 0; k < stack; k++) {
        const dur = hold * (rand() < 0.3 ? 0.5 : 1) * (1 + Math.floor(rand() * 3));
        events.push({ midi: base + k * 4, on, off: on + dur, velocity: 0.8 });
      }
      cursor = on + hold * (rand() < 0.5 ? 0.5 : 1);         // 有时留白，有时紧接
    }
    const r = build(Object.assign({ events, title: 'fuzz' }, opt));
    cases++;
    const p = parseScore(r.text);
    if (p.errors.length) { badParse++; if (!worst) worst = { kind: 'error', opt, first: p.errors[0] }; }
    else if (p.warnings.length) { badBars++; if (!worst) worst = { kind: 'warn', opt, first: p.warnings[0] }; }
    else if (tickNotes(r.text, r.stats.tpb).join(',') !== wantKeys(r.notes, opt).join(',')) {
      mismatch++;
      if (!worst) worst = { kind: '音不符', opt, got: tickNotes(r.text, r.stats.tpb), want: wantKeys(r.notes, opt) };
    }
  }
  ok('模糊测试 ' + cases + ' 组随机演奏：解析零错误', badParse === 0,
     badParse + ' 组 ' + (worst && worst.kind === 'error' ? JSON.stringify(worst.opt) + ' ' + JSON.stringify(worst.first) : ''));
  ok('模糊测试：小节拍数零警告', badBars === 0,
     badBars + ' 组 ' + (worst && worst.kind === 'warn' ? JSON.stringify(worst.opt) + ' ' + JSON.stringify(worst.first) : ''));
  ok('模糊测试：每个音的起点/终点/音高/所在轨道都一致', mismatch === 0,
     mismatch + ' 组 ' + (worst && worst.kind === '音不符' ? JSON.stringify(worst.opt) + '\n    得到 ' +
       JSON.stringify(worst.got) + '\n    应为 ' + JSON.stringify(worst.want) : ''));
}

/* ============================================================
   5. 真实使用场景：弹一段《小星星》的节奏
   ============================================================ */
{
  const spb = 0.6;
  const seq = ['C4', 'C4', 'G4', 'G4', 'A4', 'A4', 'G4'];
  const pitch = { C4: 60, G4: 67, A4: 69 };
  const events = seq.map((n, i) => ({ midi: pitch[n], on: i * spb, off: i * spb + spb * 0.9 }));
  const r = build({ events, bpm: 100, grid: '1/8', timeSig: '4/4', title: '小星星' });
  const p = parseScore(r.text);
  ok('弹小星星能被完整还原（7 个音）', p.tracks[0].notes.length === 7, p.tracks[0].notes.length);
  ok('小星星无警告', p.warnings.length === 0, JSON.stringify(p.warnings));
  ok('曲名 / 速度写进了脚本', /title 小星星/.test(r.text) && /bpm 100/.test(r.text));
  ok('7 个四分音符 + 末尾补 1 拍 = 2 小节', r.stats.bars === 2, r.stats.bars);
}

console.log('\n===== recorder ' + (fails ? '有 ' + fails + ' 项失败' : '全部通过') + ' =====');
if (fails) process.exitCode = 1;
