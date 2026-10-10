/* 乐谱文本 DSL 解析器 —— 先在 Node 里验证，再内联进页面 */
const STEP = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const DUR_WORDS = { w: 4, h: 2, q: 1, e: 0.5, s: 0.25, t: 0.125 };
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const midiName = (m) => NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

function parsePitch(tok) {
  const m = /^([A-Ga-g])((?:#|b|x)*)(-?\d+)$/.exec(tok);
  if (!m) return null;
  let semi = STEP[m[1].toLowerCase()];
  for (const ch of m[2]) { if (ch === '#') semi++; else if (ch === 'b') semi--; else if (ch === 'x') semi += 2; }
  return (parseInt(m[3], 10) + 1) * 12 + semi;
}

function parseDur(s) {
  if (s == null || s === '') return 1;
  const k = String(s).toLowerCase();
  if (DUR_WORDS[k] != null) return DUR_WORDS[k];
  const n = parseFloat(s);
  return (isNaN(n) || n <= 0) ? null : n;
}

function parseScore(text) {
  const errors = [], warnings = [], tracks = [];
  let cur = null, bpm = 120, beatsPerBar = 4, title = '未命名', timeSig = '4/4';

  const newTrack = (name) => {
    const t = { name, notes: [], pos: 0, lastBarAt: 0 };
    tracks.push(t); return t;
  };
  const checkBar = (line) => {
    const at = cur.pos, atBar = cur.pos - cur.lastBarAt;
    if (atBar > 1e-6 && Math.abs(atBar - beatsPerBar) > 1e-6) {
      warnings.push({ line, msg: '第 ' + line + ' 行：第 ' + (Math.floor(cur.lastBarAt / beatsPerBar) + 1) +
        ' 小节只有 ' + round2(atBar) + ' 拍，' + timeSig + ' 应该是 ' + beatsPerBar + ' 拍' });
    }
    cur.lastBarAt = at;
  };

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const s = raw.replace(/(^|\s)(#|\/\/).*$/, '$1').trim();
    if (!s) return;

    const dir = /^(bpm|title|time)\s+(.+)$/i.exec(s);
    if (dir) {
      const k = dir[1].toLowerCase(), v = dir[2].trim();
      if (k === 'bpm') {
        const n = parseFloat(v);
        if (!(n > 0)) errors.push({ line, msg: 'bpm 必须是正数，收到 "' + v + '"' });
        else bpm = n;
      } else if (k === 'title') title = v;
      else {
        const m = /^(\d+)\s*\/\s*(\d+)$/.exec(v);
        if (!m || +m[2] === 0) errors.push({ line, msg: '拍号应写成 4/4 这样的形式，收到 "' + v + '"' });
        else { timeSig = m[1] + '/' + m[2]; beatsPerBar = (+m[1]) * 4 / (+m[2]); }
      }
      return;
    }

    const th = /^([^:]+):\s*$/.exec(s);
    if (th) {
      const name = th[1].trim();
      // 同名轨道 = 接着往下写，而不是新开一条（方便按乐段分段书写）
      cur = tracks.find(t => t.name === name) || newTrack(name);
      return;
    }
    if (!cur) cur = newTrack('Track 1');

    // 括号感知分词：和弦 [C4 E4 G4]:2 必须保持为一个 token
    const tokens = (s.replace(/\|/g, ' | ').match(/\[[^\]]*\](?::\S*)?|\S+/g) || []);

    for (const tok of tokens) {
      if (tok === '|') { checkBar(line); continue; }

      let durStr = null, items = null;
      const chord = /^\[([^\]]*)\](?::(.*))?$/.exec(tok);
      const atom = /^([A-Ga-g][#bx]*-?\d+|[A-Za-z_]+|[-_])(?::(.*))?$/.exec(tok);
      if (chord) { items = chord[1].trim().split(/\s+/).filter(Boolean); durStr = chord[2]; }
      else if (atom) { items = [atom[1]]; durStr = atom[2]; }
      else { errors.push({ line, msg: '看不懂的记号 "' + tok + '"（音符写成 C4 / F#3 / [C4 E4 G4]:2 / r，小节线用 |）' }); continue; }

      const dur = parseDur(durStr);
      if (dur == null) { errors.push({ line, msg: '时值 "' + durStr + '" 无效：可用拍数数字或 w h q e s' }); continue; }

      const start = cur.pos;
      for (const it of items) {
        if (/^(r|rest|_|-)$/i.test(it)) continue;
        const midi = parsePitch(it);
        if (midi == null) { errors.push({ line, msg: '无法识别的音名 "' + it + '"（写成 C4、F#3、Bb5 这样）' }); continue; }
        cur.notes.push({ midi, name: midiName(midi), beat: start, durBeats: dur, velocity: 0.85 });
      }
      cur.pos = start + dur;
    }
    if (cur.pos > cur.lastBarAt) checkBar(line);   // 行尾也算一次小节检查
  });

  const clean = tracks.map((t, i) => ({
    index: i, name: t.name, notes: t.notes
  })).filter(t => t.notes.length > 0);

  let totalBeats = 0;
  clean.forEach(t => t.notes.forEach(n => { totalBeats = Math.max(totalBeats, n.beat + n.durBeats); }));
  const spb = 60 / bpm;
  clean.forEach(t => t.notes.forEach(n => { n.time = n.beat * spb; n.duration = n.durBeats * spb; }));

  return { title, bpm, timeSig, beatsPerBar, totalBeats, duration: totalBeats * spb,
           tracks: clean, errors, warnings };
}
function round2(n) { return Math.round(n * 100) / 100; }

/**
 * @tonejs/midi 写文本 meta 事件时按「码点 & 0xFF」逐字节写入（不是 UTF-8），
 * 中文会被截断成乱码。这里把 UTF-8 字节伪装成 Latin-1 字符传进去，
 * 库就会原样写出正确的 UTF-8 字节，且 writeVarInt(o.length) 的长度也恰好是字节数。
 */
function toMidiText(s) {
  const bytes = new TextEncoder().encode(s || '');
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}
/** 反向：把库读回来的 Latin-1 字符串还原成真实文本 */
function fromMidiText(s) {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
  return new TextDecoder().decode(bytes);
}

module.exports = { parseScore, parsePitch, midiName, parseDur, toMidiText, fromMidiText };

if (require.main === module) {
  const { Midi } = require('@tonejs/midi');
  let fails = 0;
  const ok = (n, c, d) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (d !== undefined ? '  :: ' + d : '')); };

  const demo = `# 示例：小星星（一条主旋律 + 一条低音）
title 小星星
bpm 100
time 4/4

主旋律:
  C4 C4 G4 G4 | A4 A4 G4:2 |
  F4 F4 E4 E4 | D4 D4 C4:2 |

低音:
  C3:4 | F3:2 C3:2 |
`;
  const r = parseScore(demo);
  ok('无错误', r.errors.length === 0, JSON.stringify(r.errors));
  ok('无小节警告', r.warnings.length === 0, JSON.stringify(r.warnings));
  ok('标题', r.title === '小星星', r.title);
  ok('两条轨道', r.tracks.length === 2, r.tracks.map(t => t.name + ':' + t.notes.length).join(' '));
  ok('主旋律 14 个音', r.tracks[0].notes.length === 14, r.tracks[0].notes.length);
  ok('低音 3 个音', r.tracks[1].notes.length === 3, r.tracks[1].notes.length);
  ok('总拍数 16', Math.abs(r.totalBeats - 16) < 1e-9, r.totalBeats);
  ok('时长 = 16*60/100 = 9.6s', Math.abs(r.duration - 9.6) < 1e-9, r.duration);
  ok('音名序列正确',
     r.tracks[0].notes.map(n => n.name).join(' ') === 'C4 C4 G4 G4 A4 A4 G4 F4 F4 E4 E4 D4 D4 C4',
     r.tracks[0].notes.map(n => n.name).join(' '));
  ok('G4:2 时值 = 1.2s', Math.abs(r.tracks[0].notes[6].duration - 1.2) < 1e-9, r.tracks[0].notes[6].duration);
  ok('最后一音起点 = 8.4s', Math.abs(r.tracks[0].notes[13].time - 8.4) < 1e-9, r.tracks[0].notes[13].time);

  // 和弦 / 休止 / 字母时值
  const r2 = parseScore('t:\n [C4 E4 G4]:2 r:1 C4:e C4:h');
  ok('和弦 = 3 个同起点同时值音',
     r2.tracks[0].notes.filter(n => n.beat === 0).length === 3 &&
     r2.tracks[0].notes.filter(n => n.beat === 0).every(n => n.durBeats === 2),
     JSON.stringify(r2.tracks[0].notes.map(n => [n.name, n.beat, n.durBeats])));
  ok('休止符正确推进时间', r2.tracks[0].notes.map(n => n.beat).join(',') === '0,0,0,3,3.5',
     r2.tracks[0].notes.map(n => n.beat).join(','));
  ok('字母时值 e/h 生效',
     r2.tracks[0].notes.some(n => Math.abs(n.durBeats - 0.5) < 1e-9) &&
     r2.tracks[0].notes.some(n => Math.abs(n.durBeats - 2) < 1e-9));

  // 升降号与等音
  const r3 = parseScore('t:\n C#4 Db4 B#3 Cb5');
  ok('升降号 MIDI 正确', r3.tracks[0].notes.map(n => n.midi).join(',') === '61,61,60,71',
     r3.tracks[0].notes.map(n => n.midi).join(','));
  ok('等音显示为 C#4/C#4/C4/B4', r3.tracks[0].notes.map(n => n.name).join(' ') === 'C#4 C#4 C4 B4',
     r3.tracks[0].notes.map(n => n.name).join(' '));

  // 错误与警告
  const bad = parseScore('t:\n C4 H4 | C4 C4');
  ok('坏音名报错带行号', bad.errors.length === 1 && bad.errors[0].line === 2, JSON.stringify(bad.errors));
  const w1 = parseScore('t:\n C4 C4 | C4 C4 C4 C4');
  ok('小节少拍给警告', w1.warnings.length === 1, JSON.stringify(w1.warnings));
  const w2 = parseScore('t:\n C4 C4 C4 C4 | C4 C4 C4 C4');
  ok('小节齐整不报警', w2.warnings.length === 0, JSON.stringify(w2.warnings));
  const w3 = parseScore('time 3/4\nt:\n C4 C4 C4 | C4 C4');
  ok('3/4 拍号生效并识别少拍', w3.warnings.length === 1, JSON.stringify(w3.warnings));

  // 注释
  const c = parseScore('# 全行注释\nt: # 行尾注释\n C4 // 另一种注释\n');
  ok('三种注释都能忽略', c.errors.length === 0 && c.tracks[0].notes.length === 1,
     JSON.stringify(c.errors) + ' notes=' + (c.tracks[0] ? c.tracks[0].notes.length : 0));

  // 只写音符、不写轨道名
  const noName = parseScore('C4 D4 E4');
  ok('省略轨道名也能解析', noName.tracks.length === 1 && noName.tracks[0].notes.length === 3,     JSON.stringify(noName.tracks.map(t => t.name + ':' + t.notes.length)));

  // 空输入
  const empty = parseScore('   \n# 只有注释\n');
  ok('空输入不崩溃', empty.tracks.length === 0 && empty.errors.length === 0);

  // 同名轨道应「接着写」而不是「新开一条」—— 分乐段书写的基础
  // 注意：第 1 段是 4 拍（E4 G4 A4 G4），所以第 2 段第一个音应落在第 4 拍
  const dup = parseScore('右手:\n E4 G4 A4 G4 |\n\n# 第二个乐段\n右手:\n C5:4 |\n\n左手:\n C3:4 | C3:4 |');
  ok('同名轨道继续而不是新开',
     dup.tracks.length === 2 && dup.tracks[0].notes.length === 5,
     '轨道数 ' + dup.tracks.length + '，右手音数 ' + (dup.tracks[0] ? dup.tracks[0].notes.length : '?'));
  ok('同名轨道的时间接着走（第 5 个音在第 4 拍）',
     dup.tracks[0] && Math.abs(dup.tracks[0].notes[4].beat - 4) < 1e-9,
     dup.tracks[0] ? dup.tracks[0].notes.map(n => n.beat).join(',') : '?');
  ok('分段书写不影响小节检查', dup.warnings.length === 0, JSON.stringify(dup.warnings));
  ok('右手 2 小节、左手也是 2 小节（总拍数 8）', Math.abs(dup.totalBeats - 8) < 1e-9, dup.totalBeats);

  // ---- 导出 MIDI 再读回 ----
  const midi = new Midi();
  midi.header.fromJSON({ name: toMidiText(r.title), ppq: 480, tempos: [{ bpm: r.bpm, ticks: 0 }],
    timeSignatures: [{ ticks: 0, timeSignature: [4, 4] }], keySignatures: [], meta: [] });
  r.tracks.forEach(t => {
    const tr = midi.addTrack(); tr.name = toMidiText(t.name);
    t.notes.forEach(n => tr.addNote({ midi: n.midi, time: n.time, duration: n.duration, velocity: n.velocity }));
  });
  const bytes = midi.toArray();
  ok('导出 MIDI 字节非空', bytes && bytes.length > 50, bytes && bytes.length);
  const back = new Midi(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const total = r.tracks.reduce((s, t) => s + t.notes.length, 0);
  const cnt = back.tracks.reduce((s, t) => s + t.notes.length, 0);
  ok('导出 MIDI 读回音符数一致', cnt === total, '原 ' + total + ' → 回读 ' + cnt);
  ok('读回音高一致',
     back.tracks[0].notes.map(n => n.name).join(' ') === r.tracks[0].notes.map(n => n.name).join(' '),
     back.tracks[0].notes.map(n => n.name).join(' '));
  ok('中文轨道名以 UTF-8 正确落盘',
     back.tracks.map(t => fromMidiText(t.name)).join(',') === '主旋律,低音',
     back.tracks.map(t => fromMidiText(t.name)).join(','));
  ok('中文曲名以 UTF-8 正确落盘',
     fromMidiText(back.header.name) === '小星星', fromMidiText(back.header.name));

  console.log('\n===== ' + (fails === 0 ? '全部通过' : fails + ' 项失败') + ' =====');
  if (fails) process.exitCode = 1;
}
