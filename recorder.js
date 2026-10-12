/**
 * 录音 → 乐谱脚本 —— 页面和测试共用的唯一一份。
 *
 * 输入是"用户弹了什么"：一串 {midi, on, off}（秒，相对于开始录音那一刻）。
 * 输出是工作台能直接吃的 DSL 文本。
 *
 * 这个文件里【没有】任何 DOM / Web Audio / Tone.js，全是纯函数，
 * 所以同一份代码既跑在 record.html 里，也能被 node tools/recorder-test.js 直接测。
 * （不这么做的话，测试一定会退化成"测一份早就过时的副本"——parser.js 上已经栽过一次。）
 *
 * 内部一律用整数 tick 计算，不用秒、不用小数拍：
 * 小节线的判断是"正好落在边界上"，浮点累加攒出 1e-15 的误差就会多出一条假警告。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./parser.js'));
  else root.ScoreRecorder = factory(root.ScoreParser);
})(typeof self !== 'undefined' ? self : this, function (Parser) {
  'use strict';

  const { midiName, round2 } = Parser;

  /** 量化网格（单位：拍）。tpb = 每拍切成几格，必须是整数。 */
  const GRIDS = [
    { id: '1/4',  beats: 1,       tpb: 1, label: '四分音符（1/4）' },
    { id: '1/8',  beats: 0.5,     tpb: 2, label: '八分音符（1/8，推荐）' },
    { id: '1/16', beats: 0.25,    tpb: 4, label: '十六分音符（1/16）' },
    { id: '1/32', beats: 0.125,   tpb: 8, label: '三十二分音符（1/32）' }
  ];
  const gridOf = (id) => GRIDS.find(g => g.id === id) || GRIDS[1];
  const tpbOf = (id) => gridOf(id).tpb;

  /** 拍号 → 每小节几拍（4/4 → 4，3/4 → 3，6/8 → 3），和 parser.js 里的算法一致 */
  function beatsPerBarOf(timeSig) {
    const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(timeSig || '4/4'));
    if (!m || +m[2] === 0) return 4;
    return (+m[1]) * 4 / (+m[2]);
  }

  /** 时值后缀：1 拍省略（写 C4 D4 更好读），其余用 :h :q :e :s 或数字
   *  ⚠ 数字必须原样输出，不能 round2：1/32 网格下 3 格 = 0.375 拍，
   *    round2 会写成 0.38，每个音多出的 0.005 拍会一路累加，最后变成
   *    "每小节 4.01 拍"的假警告（真实发生过）。tpb 只取 1/2/4/8，
   *    所以 ticks/tpb 一定是 1/8 的整数倍，JS 的默认数字转字符串就是精确值。 */
  function durSuffix(ticks, tpb) {
    const b = ticks / tpb;
    if (b === 1) return '';
    const w = { 4: 'w', 2: 'h', 0.5: 'e', 0.25: 's', 0.125: 't' }[b];
    return ':' + (w || String(b));
  }

  /**
   * 把表演时间对齐到网格。
   * 同一个音高在同一格上按了两次 → 合并（保留最长的那个），否则会生成两个同时发声的同音，
   * 弹起来像加了失真。
   */
  function quantize(events, opts) {
    const bpm = (opts && opts.bpm) || 120;
    const tpb = tpbOf((opts && opts.grid) || '1/8');
    const spb = 60 / bpm;
    const map = new Map();
    let raw = 0, dropped = 0;
    for (const e of (events || [])) {
      if (!e || typeof e.midi !== 'number') { dropped++; continue; }
      raw++;
      const on = Math.max(0, e.on || 0);
      const off = Math.max(on, e.off == null ? on : e.off);
      const s = Math.max(0, Math.round(on / spb * tpb));
      let en = Math.round(off / spb * tpb);
      if (en <= s) en = s + 1;          // 极短的一碰至少给一格，否则时值会变成 0
      const vel = e.velocity == null ? 0.85 : e.velocity;
      const k = e.midi + '@' + s;
      const prev = map.get(k);
      if (prev) {
        prev.end = Math.max(prev.end, en);
        prev.velocity = Math.max(prev.velocity, vel);
      } else {
        map.set(k, { midi: e.midi, start: s, end: en, velocity: vel });
      }
    }
    const notes = [...map.values()];
    // 同一个音高先后重叠（手抖重击）：把前一个裁到后一个开始，钢琴上就是重新击弦。
    // 不裁的话两条同音高的音会重叠，"当前该响哪些音"就会同时数到两个同名音。
    const byPitch = new Map();
    for (const n of notes) {
      const arr = byPitch.get(n.midi);
      if (arr) arr.push(n); else byPitch.set(n.midi, [n]);
    }
    for (const arr of byPitch.values()) {
      arr.sort((a, b) => a.start - b.start || a.end - b.end);
      for (let i = 0; i < arr.length - 1; i++) {
        if (arr[i].end > arr[i + 1].start) arr[i].end = arr[i + 1].start;
      }
    }
    const kept = notes.filter((n) => n.end > n.start)
                      .sort((a, b) => a.start - b.start || a.midi - b.midi);
    return { notes: kept, raw, dropped, tpb, spb };
  }

  /**
   * 一条轨道 → 一行一小节的文本。
   *
   * 一条轨道只能顺序往下走，所以要在【每个音的起点和终点】上都切一刀：
   * 只有起点才切的话，后进来的音会被整个吃掉 ——
   * 比如 A 从 0 响到 10、B 从 6 响到 8，走到 10 时才回头看 B，B 早就结束了。
   * 切成断点之后 [0,6)[6,8)[8,10) 三段分别是 A / [A B] / A，一个音都不丢。
   *
   * 切出来的段里，还在响的音写 `~C4`（延续），只有新按下的才写真音名。
   * 不这么写的话，一个按住不放的音会被拆成好几个 C4 —— 乐谱看着没问题，
   * 但回放时每个 C4 都会重新击一次键，"按住的长音"就变成了"反复敲同一个键"。
   *
   * 跨小节的长音会被小节线切开，切开的后半段同样要写 ~：`[C4 E4]:w | [~C4 ~E4]:w`。
   */
  function emitTrack(notes, o) {
    const { barTicks, tpb, totalTicks } = o;
    const lines = [];
    let cur = [];
    let pos = 0;
    let prevSet = new Set();                  // 上一段还在响的音（用对象本身判断，不是按音名）

    const advance = (len, makeTok) => {
      let first = true;
      while (len > 0) {
        const barLeft = barTicks - (pos % barTicks);
        const take = Math.min(len, barLeft);
        cur.push(makeTok(take, first));
        first = false;
        pos += take;
        len -= take;
        if (pos % barTicks === 0) { lines.push(cur.join(' ') + ' |'); cur = []; }
      }
    };
    const restTok = (take) => 'r' + durSuffix(take, tpb);
    const cont = (names) => names.map((n) => (n.charAt(0) === '~' ? n : '~' + n));

    const pts = [...new Set(notes.flatMap((n) => [n.start, n.end]))].sort((a, b) => a - b);
    for (const p of pts) {
      if (p <= pos) continue;
      const active = notes.filter((n) => n.start <= pos && n.end > pos).sort((a, b) => a.midi - b.midi);
      if (active.length) {
        /* 判断"延续"必须看是不是同一个音，不能看音名：
           前一个音刚好结束、下一个同音高的音紧接着开始（重复敲同一个键），
           按音名会误判成延续，两个音被并成一个，用户弹的两次就少了一次。 */
        const tok = active.map((n) => (prevSet.has(n) ? '~' + midiName(n.midi) : midiName(n.midi)));
        const size = tok.length;
        prevSet = new Set(active);
        advance(p - pos, (take, firstTok) => {
          const t = firstTok ? tok : cont(tok);
          return (size > 1 ? '[' + t.join(' ') + ']' : t[0]) + durSuffix(take, tpb);
        });
      } else {
        prevSet = new Set();                  // 休止符之后没有音在响，不用写 ~
        advance(p - pos, restTok);
      }
    }
    // 末尾补满最后一小节：不补的话解析器会说"这一小节只有 X 拍"
    if (pos < totalTicks) advance(totalTicks - pos, restTok);
    if (cur.length) lines.push(cur.join(' '));      // 理论上不会走到（总长一定是整小节）
    return lines;
  }

  /**
   * 主入口。
   * @param {{events:Array, bpm:number, timeSig:string, grid:string, title:string,
   *          splitHands:boolean, splitMidi:number, trimLead:boolean}} opt
   * @returns {{text:string, stats:object, warnings:string[]}}
   */
  function build(opt) {
    const o = Object.assign({
      events: [], bpm: 90, timeSig: '4/4', grid: '1/8', title: '',
      splitHands: false, splitMidi: 60, trimLead: true,
      names: { right: '右手', left: '左手', single: '钢琴' }
    }, opt || {});
    const q = quantize(o.events, { bpm: o.bpm, grid: o.grid });
    const tpb = q.tpb, spb = q.spb;
    const beatsPerBar = beatsPerBarOf(o.timeSig);
    const barTicks = Math.round(beatsPerBar * tpb);
    const warnings = [];

    // 去掉开头那段"还没开始弹"的空白：否则脚本前面会挂一串休止符，看着像坏了
    let notes = q.notes;
    if (o.trimLead && notes.length) {
      const shift = notes[0].start;
      notes = notes.map((n) => Object.assign({}, n, { start: n.start - shift, end: n.end - shift }));
    }

    let endTick = 0;
    notes.forEach((n) => { if (n.end > endTick) endTick = n.end; });
    const totalTicks = Math.max(barTicks, Math.ceil(endTick / barTicks) * barTicks);

    const tracks = [];
    if (o.splitHands) {
      const right = notes.filter((n) => n.midi >= o.splitMidi);
      const left = notes.filter((n) => n.midi < o.splitMidi);
      // 右手排前面：歌词/旋律默认对齐第一条轨道
      if (right.length) tracks.push({ name: o.names.right, notes: right });
      if (left.length) tracks.push({ name: o.names.left, notes: left });
    } else if (notes.length) {
      tracks.push({ name: o.names.single, notes: notes });
    }

    const out = ['title ' + (o.title || '未命名演奏'), 'bpm ' + round2(o.bpm), 'time ' + o.timeSig, ''];
    for (const t of tracks) {
      out.push(t.name + ':');
      for (const ln of emitTrack(t.notes, { barTicks, tpb, totalTicks })) out.push('  ' + ln);
      out.push('');
    }
    const text = notes.length
      ? out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n'
      : '';
    if (notes.length && !tracks.length) warnings.push('有音符但没能分到任何一条轨道');

    const stats = {
      rawEvents: q.raw,
      notes: notes.length,
      bars: Math.round(totalTicks / barTicks),
      seconds: round2(endTick / tpb * spb),
      scriptSeconds: round2(totalTicks / tpb * spb),
      bpm: o.bpm, grid: o.grid, timeSig: o.timeSig,
      hands: tracks.length, tpb, barTicks, totalTicks
    };
    return { text, stats, warnings, notes };
  }

  return { GRIDS, gridOf, tpbOf, beatsPerBarOf, durSuffix, quantize, emitTrack, build };
});
