/**
 * 乐谱 DSL 解析器 —— 页面和测试共用的唯一一份实现。
 *
 * 为什么单独成文件：之前 index.html 和 tools/parser-test.js 各有一份 parseScore，
 * 加 vol / 歌词 / barlines off 时只改了一边，测试却在"通过"——测的是过时的那份。
 * 抽成共享文件后这种漂移不可能再发生。
 *
 * 浏览器：<script src="parser.js"></script> → window.ScoreParser
 * Node：  require('./parser.js')
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScoreParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STEP = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  const DUR_WORDS = { w: 4, h: 2, q: 1, e: 0.5, s: 0.25, t: 0.125 };
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const midiName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  
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
  const round2 = (n) => Math.round(n * 100) / 100;

  function parseScore(text) {
    const errors = [], warnings = [], tracks = [];
    let cur = null, bpm = 120, beatsPerBar = 4, title = '', timeSig = '4/4';
    let checkBars = true;          // barlines off 后只把 | 当视觉分隔，不做每小节拍数校验
    let lyricMode = false, lyricSyms = [];   // 歌词：音节按顺序对齐第一条轨道的音符
  
    const isLyricName = (n) => /^(歌词|词|lyrics?|words?)$/i.test((n || '').trim());
  
    const newTrack = (name) => {
      const t = { name: name || ('Track ' + (tracks.length + 1)), notes: [], pos: 0, lastBarAt: 0 };
      tracks.push(t); return t;
    };
    const checkBar = (line) => {
      if (!checkBars) { cur.lastBarAt = cur.pos; return; }
      const atBar = cur.pos - cur.lastBarAt;
      if (atBar > 1e-6 && Math.abs(atBar - beatsPerBar) > 1e-6) {
        warnings.push({ line, msg: '第 ' + line + ' 行：第 ' + (Math.floor(cur.lastBarAt / beatsPerBar) + 1) +
          ' 小节是 ' + round2(atBar) + ' 拍，' + timeSig + ' 每小节应该是 ' + round2(beatsPerBar) + ' 拍' });
      }
      cur.lastBarAt = cur.pos;
    };
  
    text.split(/\r?\n/).forEach((raw, i) => {
      const line = i + 1;
      const s = raw.replace(/(^|\s)(#|\/\/).*$/, '$1').trim();
      if (!s) return;
  
      const dir = /^(bpm|title|time|barlines)\s+(.+)$/i.exec(s);
      if (dir) {
        const k = dir[1].toLowerCase(), v = dir[2].trim();
        if (k === 'bpm') {
          const n = parseFloat(v);
          if (!(n > 0)) errors.push({ line, msg: 'bpm 必须是正数，收到 "' + v + '"' });
          else bpm = n;
        } else if (k === 'title') title = v;
        else if (k === 'barlines') {
          const on = /^(on|true|yes|1)$/i.test(v);
          const off = /^(off|false|no|0|free)$/i.test(v);
          if (on) checkBars = true;
          else if (off) checkBars = false;
          else errors.push({ line, msg: 'barlines 只能写 on 或 off，收到 "' + v + '"' });
        } else {
          const m = /^(\d+)\s*\/\s*(\d+)$/.exec(v);
          if (!m || +m[2] === 0) errors.push({ line, msg: '拍号要写成 4/4 这样的形式，收到 "' + v + '"' });
          else { timeSig = m[1] + '/' + m[2]; beatsPerBar = (+m[1]) * 4 / (+m[2]); }
        }
        return;
      }
  
      // 轨道内的音量指令：vol 0.55（左手伴奏通常要比右手轻）
      const vol = /^(vol|volume|音量)\s+([\d.]+)$/i.exec(s);
      if (vol) {
        if (!cur) { errors.push({ line, msg: 'vol 要写在某条轨道里面，例如：\n左手:\n  vol 0.55' }); return; }
        const v = parseFloat(vol[2]);
        if (!(v >= 0 && v <= 2)) errors.push({ line, msg: 'vol 取值范围 0~2，收到 "' + vol[2] + '"' });
        else cur.volume = v;
        return;
      }
  
      const th = /^([^:]+):\s*$/.exec(s);
      if (th) {
        const name = th[1].trim();
        // 歌词轨：内容不是音符，而是按顺序对齐第一条轨道各音符的音节
        if (isLyricName(name)) { lyricMode = true; cur = null; return; }
        lyricMode = false;
        // 同名轨道 = 接着往下写，而不是新开一条（方便按乐段分段书写）
        cur = tracks.find(t => t.name === name) || newTrack(name);
        return;
      }
  
      // 歌词行：只收音节，不做音符解析
      if (lyricMode) {
        for (const sym of (s.replace(/\|/g, ' ').match(/\S+/g) || [])) lyricSyms.push(sym);
        return;
      }
  
      if (!cur) cur = newTrack('');
  
      // 括号感知分词：和弦 [C4 E4 G4]:2 必须保持为一个 token
      const tokens = (s.replace(/\|/g, ' | ').match(/\[[^\]]*\](?::\S*)?|\S+/g) || []);
  
      for (const tok of tokens) {
        if (tok === '|') { checkBar(line); continue; }
  
        let durStr = null, items = null;
        const chord = /^\[([^\]]*)\](?::(.*))?$/.exec(tok);
        const atom = /^(~?[A-Ga-g][#bx]*-?\d+|[A-Za-z_]+|[-_])(?::(.*))?$/.exec(tok);
        if (chord) { items = chord[1].trim().split(/\s+/).filter(Boolean); durStr = chord[2]; }
        else if (atom) { items = [atom[1]]; durStr = atom[2]; }
        else { errors.push({ line, msg: '看不懂的记号 "' + tok + '"（音符写成 C4 / F#3 / [C4 E4 G4]:2 / r，小节线用 |）' }); continue; }
  
        const dur = parseDur(durStr);
        if (dur == null) { errors.push({ line, msg: '时值 "' + durStr + '" 无效：可用拍数数字，或 w h q e s' }); continue; }
  
        const start = cur.pos;
        for (const it of items) {
          if (/^(r|rest|_|-)$/i.test(it)) continue;
          /* ~C4 = 接着前面那个还在响的 C4 往下拉长，不重新击键。
             录音页录"按住不放"时靠它，否则一个音被拆成好几段、回放会变成反复敲同一个键。 */
          const contM = /^~(.*)$/.exec(it);
          if (contM) {
            const cMidi = parsePitch(contM[1]);
            if (cMidi == null) { errors.push({ line, msg: '无法识别的音名 "' + contM[1] + '"' }); continue; }
            const prev = cur.notes.find(n => n.midi === cMidi &&
              Math.abs(n.beat + n.durBeats - start) < 1e-6);
            if (!prev) {
              errors.push({ line, msg: '"' + it + '" 想延续一个正在响的音，但这里并没有正在响的 ' +
                contM[1] + '（~ 只能接在还没结束的那个音后面）' });
              continue;
            }
            /* 精确到位、不要 round2：1/32 网格下 0.375 拍被四舍五入成 0.38 之后，
               下一个 ~ 就对不上"这个音到底响到哪"了（真发生过，102 组模糊测试全报这个错）。 */
            prev.durBeats = Math.round(((start + dur) - prev.beat) * 1e6) / 1e6;
            continue;
          }
          const midi = parsePitch(it);
          if (midi == null) { errors.push({ line, msg: '无法识别的音名 "' + it + '"（写成 C4、F#3、Bb5 这样）' }); continue; }
          cur.notes.push({ midi, name: midiName(midi), beat: start, durBeats: dur, velocity: 0.85 });
        }
        cur.pos = start + dur;
      }
      if (cur.pos > cur.lastBarAt) checkBar(line);
    });
  
    const clean = tracks.map((t, i) => ({
      index: i, name: t.name, notes: t.notes,
      volume: t.volume == null ? 1 : t.volume
    })).filter(t => t.notes.length > 0);
    let totalBeats = 0;
    clean.forEach(t => t.notes.forEach(n => { totalBeats = Math.max(totalBeats, n.beat + n.durBeats); }));
    const spb = 60 / bpm;
    clean.forEach(t => t.notes.forEach(n => { n.time = n.beat * spb; n.duration = n.durBeats * spb; }));
  
    /* 歌词对齐：按顺序贴到第一条轨道（通常是主旋律）的「音符事件」上。
       和弦算一个事件；写 "-" 表示这个音继续唱上一个字（一字多音）。 */
    const lyrics = [];
    if (lyricSyms.length && clean.length) {
      const evs = [], seen = new Set();
      for (const n of clean[0].notes) {
        const k = n.beat + '|' + n.durBeats;
        if (seen.has(k)) continue;
        seen.add(k);
        evs.push({ beat: n.beat, durBeats: n.durBeats });
      }
      let si = 0;
      for (const ev of evs) {
        if (si >= lyricSyms.length) break;
        const sym = lyricSyms[si++];
        if (sym === '-' || sym === '—') {           // 一字多音：接着唱上一个字
          const last = lyrics[lyrics.length - 1];
          if (last) last.durBeats = (ev.beat + ev.durBeats) - last.beat;
          continue;
        }
        lyrics.push({ syl: sym, beat: ev.beat, durBeats: ev.durBeats });
      }
      lyrics.forEach(l => { l.time = l.beat * spb; l.duration = l.durBeats * spb; });
      if (si < lyricSyms.length) {
        warnings.push({ msg: '歌词有 ' + lyricSyms.length + ' 个字，但旋律只有 ' + evs.length +
                             ' 个音（事件），多出来的 ' + (lyricSyms.length - si) + ' 个字贴不上' });
      }
      if (lyrics.length > evs.length) {
        warnings.push({ msg: '歌词比旋律音符还多，请检查' });
      }
    } else if (lyricSyms.length && !clean.length) {
      warnings.push({ msg: '只写了歌词，没有可对齐的旋律轨道' });
    }
  
    return { title, bpm, timeSig, beatsPerBar, totalBeats, duration: totalBeats * spb,
             tracks: clean, lyrics, errors, warnings };
  }

  function formatScore(text) {
    const out = [];
    for (const raw of text.split(/\r?\n/)) {
      const s = raw.trim();
      if (!s) { out.push(''); continue; }
      // 注释、全局指令、轨道头、音量指令：原样保留
      if (/^(#|\/\/)/.test(s) ||
          /^(bpm|title|time|barlines)\s/i.test(s) ||
          /^(vol|volume|音量)\s/i.test(s) ||
          /^[^:]+:\s*$/.test(s)) {
        out.push(raw.replace(/\s+$/, ''));
        continue;
      }
      const indent = (raw.match(/^\s*/) || [''])[0];
      const segs = s.split('|');
      let wrote = false;
      for (let i = 0; i < segs.length; i++) {
        const body = segs[i].trim();
        const isLast = i === segs.length - 1;
        if (!body) continue;
        out.push(indent + body + (isLast ? '' : ' |'));
        wrote = true;
      }
      if (!wrote) out.push(raw.replace(/\s+$/, ''));
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
  }

  return { parseScore, formatScore, midiName, parsePitch, parseDur, round2,
           NOTE_NAMES, STEP, DUR_WORDS };
});
