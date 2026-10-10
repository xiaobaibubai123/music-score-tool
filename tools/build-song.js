/**
 * 把 scores/ 里的乐谱文本编译成 .mid 和 .midi.json，并做音乐性检查。
 *
 *   node build-song.js "星光下的梦想"
 *
 * 检查项：
 *   1. 语法错误 / 小节拍数警告（复用已验证的解析器，不另写一套）
 *   2. 每小节的和弦 + 旋律音，反推和声进行
 *   3. 同时发声的右手/左手之间是否有小二度、小九度冲突
 *   4. 导出 .mid 后重新读回，核对音符数、音高、中文名
 */
const fs = require('fs');
const path = require('path');
const { Midi } = require('@tonejs/midi');
const { parseScore, midiName, toMidiText, fromMidiText } = require('./parser-test.js');

const NAME = process.argv[2] || '星光下的梦想';
const SRC = path.join(__dirname, '..', 'scores', NAME + '.txt');
const OUT = path.join(__dirname, '..', 'scores');

/* ---------- 和弦识别 ---------- */
const PC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SHAPES = [
  { iv: [0, 4, 7],       suffix: '' },
  { iv: [0, 3, 7],       suffix: 'm' },
  { iv: [0, 4, 7, 11],   suffix: 'maj7' },
  { iv: [0, 3, 7, 10],   suffix: 'm7' },
  { iv: [0, 4, 7, 10],   suffix: '7' },
  { iv: [0, 3, 7, 10, 14], suffix: 'm9' },
  { iv: [0, 4, 7, 14],   suffix: 'add9' },
];
function chordName(midis) {
  if (!midis.length) return '—';
  const pcs = [...new Set(midis.map(m => ((m % 12) + 12) % 12))].sort((a, b) => a - b);
  const bass = ((Math.min(...midis) % 12) + 12) % 12;
  for (const root of pcs) {
    const rel = pcs.map(p => ((p - root) % 12 + 12) % 12).sort((a, b) => a - b);
    for (const s of SHAPES) {
      const want = [...new Set(s.iv.map(i => i % 12))].sort((a, b) => a - b);
      if (rel.length === want.length && rel.every((v, i) => v === want[i])) {
        const label = PC[root] + s.suffix;
        return bass === root ? label : label + '/' + PC[bass];
      }
    }
  }
  return pcs.map(p => PC[p]).join('+');
}

/* ---------- 主流程 ---------- */
const text = fs.readFileSync(SRC, 'utf8');
const p = parseScore(text);

console.log('══════════════════════════════════════════════════════');
console.log('  《' + p.title + '》');
console.log('══════════════════════════════════════════════════════');
console.log('  调性/拍号 : C 大调 · ' + p.timeSig);
console.log('  速度      : ' + p.bpm + ' BPM');
console.log('  总拍数    : ' + p.totalBeats + ' 拍 = ' + Math.round(p.totalBeats / p.beatsPerBar) + ' 小节');
console.log('  时长      : ' + p.duration.toFixed(1) + ' 秒 (' +
            Math.floor(p.duration / 60) + ':' + String(Math.round(p.duration % 60)).padStart(2, '0') + ')');
p.tracks.forEach(t => {
  const lo = Math.min(...t.notes.map(n => n.midi));
  const hi = Math.max(...t.notes.map(n => n.midi));
  console.log('  轨道 "' + t.name + '" : ' + t.notes.length + ' 个音，音域 ' +
              midiName(lo) + '–' + midiName(hi));
});

console.log('\n─── 语法检查 ───');
if (p.errors.length) {
  console.log('  ✖ 错误 ' + p.errors.length + ' 处：');
  p.errors.forEach(e => console.log('     第 ' + e.line + ' 行: ' + e.msg));
} else console.log('  ✔ 没有语法错误');
if (p.warnings.length) {
  console.log('  ⚠ 警告 ' + p.warnings.length + ' 处：');
  p.warnings.forEach(w => console.log('     第 ' + w.line + ' 行: ' + w.msg));
} else console.log('  ✔ 所有小节拍数都对齐（' + p.beatsPerBar + '/4 每小节 ' + p.beatsPerBar + ' 拍）');

/* ---------- 和声进行 ---------- */
const mel = p.tracks.find(t => /右|旋律|mel/i.test(t.name)) || p.tracks[0];
const acc = p.tracks.find(t => /左|伴奏|bass|左手/i.test(t.name)) || p.tracks[1];
const bars = Math.round(p.totalBeats / p.beatsPerBar);

console.log('\n─── 和声进行与旋律（每小节）───');
console.log('  小节  和弦      右手旋律');
const progression = [];
for (let b = 0; b < bars; b++) {
  const t0 = b * p.beatsPerBar, t1 = t0 + p.beatsPerBar;
  const accN = acc.notes.filter(n => n.beat < t1 && n.beat + n.durBeats > t0);
  const melN = mel.notes.filter(n => n.beat < t1 && n.beat + n.durBeats > t0);
  // 本曲是「每小节一个和弦」，所以取整小节左手音来识别；
  // 若取「第 1 拍起音」的写法，琶音段只会拿到一个音，识别不出和弦。
  const chord = chordName(accN.map(n => n.midi));
  progression.push(chord);
  const melStr = melN.map(n => n.name + (n.durBeats !== 1 ? ':' + n.durBeats : '')).join(' ');
  console.log('  ' + String(b + 1).padStart(3) + '   ' + chord.padEnd(9) + melStr);
}

/* ---------- 冲突检测 ---------- */
// 判定要分程度：同八度的小二度（相隔 1 个半音）才是真打架；
// 相隔一个八度的小九度（13 半音）属于常见的扩展和弦色彩，只是略紧张；
// 相隔两个八度左右的小九度（23 半音）非常柔和，例如 Am9 里的 C3+B4，不应报警。
console.log('\n─── 和声冲突检测 ───');
const hard = [], soft = [], wide = [];
for (const m of mel.notes) {
  for (const a of acc.notes) {
    const overlap = Math.min(m.beat + m.durBeats, a.beat + a.durBeats) - Math.max(m.beat, a.beat);
    if (overlap <= 1e-6) continue;
    const d = Math.abs(m.midi - a.midi);
    if (d % 12 !== 1) continue;
    const rec = { bar: Math.floor(m.beat / p.beatsPerBar) + 1, m: m.name, a: a.name, d };
    if (d === 1) hard.push(rec);
    else if (d <= 13) soft.push(rec);
    else wide.push(rec);
  }
}
if (hard.length) {
  console.log('  ✖ 小二度冲突（同八度，需要修）' + hard.length + ' 处：');
  hard.forEach(c => console.log('     第 ' + c.bar + ' 小节: ' + c.m + ' 撞 ' + c.a));
} else {
  console.log('  ✔ 没有小二度冲突（同八度）');
}
if (soft.length) {
  console.log('  ⚠ 邻近小九度（1 个八度内，略紧张）' + soft.length + ' 处：');
  soft.slice(0, 10).forEach(c => console.log('     第 ' + c.bar + ' 小节: ' + c.m + ' 撞 ' + c.a + '（' + c.d + ' 半音）'));
} else {
  console.log('  ✔ 没有邻近的小九度');
}
console.log('  · 跨度 ≥25 半音的小九度（两个八度开外）' + wide.length + ' 处 —— 已宽到不构成紧张感，不计为问题' +
            (wide.length ? '，例如 第 ' + wide[0].bar + ' 小节 ' + wide[0].m + '/' + wide[0].a : ''));

/* ---------- 导出 ---------- */
console.log('\n─── 导出 ───');
const midi = new Midi();
midi.header.fromJSON({
  name: toMidiText(p.title),
  ppq: 480,
  tempos: [{ bpm: p.bpm, ticks: 0 }],
  timeSignatures: [{ ticks: 0, timeSignature: p.timeSig.split('/').map(Number) }],
  keySignatures: [{ key: 'C', scale: 'major', ticks: 0 }],
  meta: [],
});

// 右手稍响、左手稍轻，让旋律浮出来
const VELOCITY = { [mel.name]: 0.88, [acc.name]: 0.60 };
p.tracks.forEach(t => {
  const tr = midi.addTrack();
  tr.name = toMidiText(t.name);
  t.notes.forEach(n => tr.addNote({
    midi: n.midi, time: n.time, duration: n.duration,
    velocity: VELOCITY[t.name] != null ? VELOCITY[t.name] : n.velocity,
  }));
});

const midPath = path.join(OUT, NAME + '.mid');
fs.writeFileSync(midPath, Buffer.from(midi.toArray()));

const jsonPath = path.join(OUT, NAME + '.midi.json');
// JSON 本身是 UTF-8，中文直接写原文即可；
// toMidiText() 那套「把 UTF-8 字节伪装成 Latin-1」只适用于写 .mid 的二进制字节。
const rawJson = midi.toJSON();
rawJson.header.name = p.title;
rawJson.tracks.forEach((tr, i) => { if (p.tracks[i]) tr.name = p.tracks[i].name; });
fs.writeFileSync(jsonPath, JSON.stringify(rawJson, null, 2));

/* ---------- 回读校验 ---------- */
const midBuf = fs.readFileSync(midPath);
const back = new Midi(midBuf.buffer.slice(midBuf.byteOffset, midBuf.byteOffset + midBuf.byteLength));const totalSrc = p.tracks.reduce((s, t) => s + t.notes.length, 0);
const totalBack = back.tracks.reduce((s, t) => s + t.notes.length, 0);
console.log('  ' + midPath.replace(path.join(__dirname, '..') + path.sep, '') +
            '   ' + (fs.statSync(midPath).size / 1024).toFixed(1) + ' KB');
console.log('  ' + jsonPath.replace(path.join(__dirname, '..') + path.sep, '') +
            '   ' + (fs.statSync(jsonPath).size / 1024).toFixed(1) + ' KB');

console.log('\n─── 回读校验 ───');
const ok = (label, cond, detail) =>
  console.log('  ' + (cond ? '✔' : '✖') + ' ' + label + (detail ? '  (' + detail + ')' : ''));
ok('音符数一致', totalBack === totalSrc, '原 ' + totalSrc + ' → 回读 ' + totalBack);
ok('中文曲名正确', fromMidiText(back.header.name) === p.title, fromMidiText(back.header.name));
ok('中文轨道名正确',
   back.tracks.map(t => fromMidiText(t.name)).join(',') === p.tracks.map(t => t.name).join(','),
   back.tracks.map(t => fromMidiText(t.name)).join(','));
ok('速度正确', Math.abs(back.header.tempos[0].bpm - p.bpm) < 0.01, back.header.tempos[0].bpm);
ok('右手音高序列一致',
   back.tracks[0].notes.map(n => n.name).join(' ') === mel.notes.map(n => n.name).join(' '));
ok('左手音高序列一致',
   back.tracks[1].notes.map(n => n.name).join(' ') === acc.notes.map(n => n.name).join(' '));

const uniqueChords = [...new Set(progression)];
console.log('\n  用到的和弦：' + uniqueChords.join('  '));
console.log('  和声进行  ：' + progression.join(' → '));
console.log('');
