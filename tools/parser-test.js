/* 乐谱文本 DSL 解析器测试 —— 解析器本体在 ../parser.js，页面和测试共用同一份，
   避免两边不同步（曾经发生过：加了 vol/歌词，测试却在测旧的副本）。 */
const { parseScore, formatScore, parsePitch, midiName, parseDur, round2 } = require('../parser.js');


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

module.exports = { parseScore, parsePitch, midiName, parseDur, toMidiText, fromMidiText,
                   formatScore, round2 };

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

  /* ---------- barlines off：机器导入的谱面不做拍数校验 ---------- */
  const rB = parseScore('barlines off\nt:\n C4 C4 | C4 |');
  ok('barlines off 后小节拍数不再报警', rB.warnings.length === 0, JSON.stringify(rB.warnings));
  ok('barlines off 不影响音符解析', rB.tracks[0].notes.length === 3, rB.tracks[0].notes.length);
  const rB2 = parseScore('t:\n C4 C4 | C4 |');
  ok('默认仍然会报小节拍数', rB2.warnings.length > 0, rB2.warnings.length + ' 条警告');

  /* ---------- vol：分轨音量 ---------- */
  const rV = parseScore('t1:\n vol 0.4\n C4:4 |\nt2:\n C4:4 |');
  ok('vol 指令设定了该轨道音量', Math.abs(rV.tracks[0].volume - 0.4) < 1e-9, rV.tracks[0].volume);
  ok('没写 vol 的轨道音量为 1', Math.abs(rV.tracks[1].volume - 1) < 1e-9, rV.tracks[1].volume);
  const rVbad = parseScore('t:\n vol 9\n C4:4 |');
  ok('vol 超范围会报错', rVbad.errors.length > 0, JSON.stringify(rVbad.errors.map(e => e.msg)));
  const rVoutside = parseScore('vol 0.5\nC4:4 |');
  ok('vol 写在轨道外会报错', rVoutside.errors.length > 0,
     JSON.stringify(rVoutside.errors.map(e => e.msg)));

  /* ---------- 歌词 ---------- */
  const rL = parseScore([
    '右手:', '  C4 D4 E4 F4 | G4 A4 B4 C5 |',
    '歌词:', '  一 闪 一 闪 | 亮 晶 晶 - |'
  ].join('\n'));
  ok('歌词按顺序对齐旋律', rL.lyrics.map(l => l.syl).join('') === '一闪一闪亮晶晶',
     rL.lyrics.map(l => l.syl).join(''));
  ok('歌词拍位取自对应音符',
     rL.lyrics.length === 7 && Math.abs(rL.lyrics[0].beat - 0) < 1e-9 &&
     Math.abs(rL.lyrics[6].beat - 6) < 1e-9,
     rL.lyrics.map(l => l.syl + '@' + l.beat).join(' '));
  ok('"-" 表示一字多音，会延长上一个字',
     Math.abs(rL.lyrics[6].durBeats - 2) < 1e-9, rL.lyrics[6].durBeats);
  ok('歌词轨不会被当成音符轨', rL.tracks.length === 1, rL.tracks.length);
  const rL2 = parseScore([
    '右手:', '  C4 D4 |',
    '歌词:', '  多 出 来 的 字 |'
  ].join('\n'));
  ok('歌词比音符多时会给出警告', rL2.warnings.some(w => /歌词/.test(w.msg)),
     JSON.stringify(rL2.warnings.map(w => w.msg)));
  ok('没有歌词时 lyrics 为空数组', Array.isArray(rL2.lyrics) === true);
  const rL3 = parseScore('右手:\n C4 D4 |');
  ok('不写歌词轨时 lyrics 长度为 0', (rL3.lyrics || []).length === 0);

  /* ---------- formatScore：每小节换行 ---------- */
  const fIn = ['title T', 'vol 0.5', '', '右手:', '  C4 D4 E4 F4 | G4 A4 B4 C5 |', '歌词:', '  一 二 | 三 四 |'].join('\n');
  const fOut = formatScore(fIn);
  const fLines = fOut.split('\n');
  ok('格式化：音符行每行只剩一个小节线',
     fLines.filter(l => l.includes('|') && !l.trim().startsWith('#')).every(l => (l.match(/\|/g) || []).length === 1),
     JSON.stringify(fLines));
  ok('格式化：轨道头没被拆坏',
     fLines.some(l => l.trim() === '右手:') && fLines.some(l => l.trim() === '歌词:'),
     JSON.stringify(fLines));
  ok('格式化：音符内容没变（去掉空白后一致）',
     fOut.replace(/\s+/g, '') === fIn.replace(/\s+/g, ''), fOut.replace(/\s+/g, ''));
  ok('格式化后再解析结果一致',
     JSON.stringify(parseScore(fOut).tracks.map(t => t.notes.map(n => n.name))) ===
     JSON.stringify(parseScore(fIn).tracks.map(t => t.notes.map(n => n.name))));

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
