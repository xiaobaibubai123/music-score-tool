/**
 * 键盘键位 —— 页面和测试共用的唯一一份。
 *
 * JSON 的写法是【音符当 key，按键当 value】：
 *
 *   {
 *     "name": "我的键位",
 *     "notes": { "C4": "KeyA", "C#4": "KeyW", "D4": "KeyS" }
 *   }
 *
 * 这样读起来才是"哪个音用哪个键弹"。为了兼容，旧的 { "KeyA": "C4" } 也认，
 * 靠"key 像音名还是像按键代码"投票判断方向（见 detectDirection）。
 *
 * 只认 KeyboardEvent.code（KeyA / Digit1 / Semicolon / ArrowLeft …），
 * 不认 e.key —— 后者受输入法、大小写、CapsLock 影响，中文输入法下会变成 "Process"。
 *
 * 浏览器：<script src="keymap.js"></script> → window.ScoreKeymap
 * Node：  require('./keymap.js')
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./parser.js'));
  else root.ScoreKeymap = factory(root.ScoreParser);
})(typeof self !== 'undefined' ? self : this, function (Parser) {
  'use strict';

  const { parsePitch, midiName } = Parser;
  const LO_MIDI = 21, HI_MIDI = 108;                    // 钢琴的 A0 ~ C8

  /* ---------- 常见 KeyboardEvent.code（用来给手写 JSON 报错，而不是让它静默失效） ---------- */
  const KNOWN_CODES = (() => {
    const s = new Set();
    for (let i = 0; i < 26; i++) s.add('Key' + String.fromCharCode(65 + i));
    for (let i = 0; i <= 9; i++) s.add('Digit' + i);
    for (let i = 1; i <= 12; i++) s.add('F' + i);
    for (let i = 0; i <= 9; i++) s.add('Numpad' + i);
    ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
     'Semicolon', 'Quote', 'Comma', 'Period', 'Slash', 'Backslash',
     'BracketLeft', 'BracketRight', 'Minus', 'Equal', 'Backquote',
     'Space', 'Tab', 'Enter', 'Backspace', 'Escape',
     'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
     'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
     'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock',
     'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide',
     'NumpadDecimal', 'NumpadEnter'].forEach((c) => s.add(c));
    return s;
  })();

  /* 这些键当音符键不合适：功能键会跟浏览器/系统抢，Escape 还要用来取消绑定 */
  const RISKY_CODES = new Set(['Escape', 'Tab', 'F1', 'F5', 'F11', 'F12',
    'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
    'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock']);

  const CODE_LABEL = {
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
    BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`',
    Space: '空格', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    NumpadAdd: '小键盘+', NumpadSubtract: '小键盘-', NumpadMultiply: '小键盘*',
    NumpadDivide: '小键盘/', NumpadDecimal: '小键盘.', NumpadEnter: '小键盘回车'
  };
  /** 给界面显示用：KeyA → A，Digit2 → 2，Semicolon → ; */
  function labelOf(code) {
    if (CODE_LABEL[code]) return CODE_LABEL[code];
    let m = /^Key([A-Z])$/.exec(code); if (m) return m[1];
    m = /^Digit(\d)$/.exec(code); if (m) return m[1];
    m = /^Numpad(\d)$/.exec(code); if (m) return '小键盘' + m[1];
    m = /^F(\d+)$/.exec(code); if (m) return 'F' + m[1];
    return code;
  }

  /* ============================================================
     识别"这是音名还是按键代码"
     ============================================================ */
  const NOTE_RE = /^[A-Ga-g](?:#|b|x)*(-?\d+)$/;
  /** "C4" / "F#3" / "Bb5" 都算音名。注意 "F4" 既是音名 F4、也是功能键 F4 —— 靠投票决定 */
  function looksLikeNote(s) { return typeof s === 'string' && NOTE_RE.test(s.trim()); }
  function looksLikeCode(s) { return typeof s === 'string' && KNOWN_CODES.has(s.trim()); }

  /** 一条键位值 → MIDI；支持 "C4" / "C#4" / "Db4" / 60 / "60"。
   *  ⚠ 音名解析不会自己检查范围：parsePitch("C99") 会算出 1200。
   *    不拦的话一个手滑的 "C99" 会变成一个 1200 号的"音"，到播放时才炸。 */
  function toMidi(v) {
    if (typeof v === 'number') return (Number.isFinite(v) && v >= 0 && v <= 127) ? Math.round(v) : null;
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (/^-?\d+$/.test(s)) { const n = +s; return (n >= 0 && n <= 127) ? n : null; }
    const m = parsePitch(s);
    return (m != null && m >= 0 && m <= 127) ? m : null;
  }

  /* ============================================================
     内置预设（音符 → 按键）
     ============================================================ */

  /** ① 键盘钢琴（通用主键区）—— 各类"在线钢琴"最常见的排法 */
  const HOME_ROW = {
    name: '键盘钢琴（通用主键区）',
    description: '在线钢琴最常见的排法：主键区当白键，上一排当黑键',
    notes: {
      'C4': 'KeyA', 'C#4': 'KeyW', 'D4': 'KeyS', 'D#4': 'KeyE', 'E4': 'KeyD',
      'F4': 'KeyF', 'F#4': 'KeyT', 'G4': 'KeyG', 'G#4': 'KeyY', 'A4': 'KeyH',
      'A#4': 'KeyU', 'B4': 'KeyJ', 'C5': 'KeyK', 'C#5': 'KeyO', 'D5': 'KeyL',
      'D#5': 'KeyP', 'E5': 'Semicolon', 'F5': 'Quote'
    }
  };

  /** ② 双排两个八度 —— DAW（Ableton / FL Studio）和电子琴软件教的那种 */
  const TWO_ROW = {
    name: '双排两个八度（DAW / 电钢风格）',
    description: 'Ableton / FL Studio 那套：ZXCVBNM + QWERTYU 两排白键，SDGHJ + 23567 当黑键',
    notes: {
      'C3': 'KeyZ', 'C#3': 'KeyS', 'D3': 'KeyX', 'D#3': 'KeyD', 'E3': 'KeyC', 'F3': 'KeyV',
      'F#3': 'KeyG', 'G3': 'KeyB', 'G#3': 'KeyH', 'A3': 'KeyN', 'A#3': 'KeyJ', 'B3': 'KeyM',
      'C4': 'KeyQ', 'C#4': 'Digit2', 'D4': 'KeyW', 'D#4': 'Digit3', 'E4': 'KeyE', 'F4': 'KeyR',
      'F#4': 'Digit5', 'G4': 'KeyT', 'G#4': 'Digit6', 'A4': 'KeyY', 'A#4': 'Digit7', 'B4': 'KeyU'
    }
  };

  /** ③ 单排一个八度 —— 只想随便敲敲、不想记两排的时候用 */
  const ONE_ROW = {
    name: '单排一个八度（最省事）',
    description: 'A S D F G H J 就是 do re mi fa sol la si，W E T Y U 是黑键',
    notes: {
      'C4': 'KeyA', 'C#4': 'KeyW', 'D4': 'KeyS', 'D#4': 'KeyE', 'E4': 'KeyD',
      'F4': 'KeyF', 'F#4': 'KeyT', 'G4': 'KeyG', 'G#4': 'KeyY', 'A4': 'KeyH',
      'A#4': 'KeyU', 'B4': 'KeyJ'
    }
  };

  const PRESETS = [HOME_ROW, TWO_ROW, ONE_ROW];
  const DEFAULT = HOME_ROW;

  /* ============================================================
     解析 / 校验
     ============================================================ */

  const byMidi = (a, b) => a.midi - b.midi || a.code.localeCompare(b.code);
  function sortBinds(binds) { return binds.slice().sort(byMidi); }

  function blank(name, description) {
    return { name: name || '自定义键位', description: description || '',
             binds: [], warnings: [], builtin: false };
  }

  /** 预设 → 内部结构 */
  function materialize(preset) {
    const binds = [];
    const warnings = [];
    for (const note of Object.keys(preset.notes)) {
      const midi = toMidi(note);
      const code = preset.notes[note];
      if (midi == null) { warnings.push('预设里的音名 "' + note + '" 读不出来'); continue; }
      if (!KNOWN_CODES.has(code)) { warnings.push('预设里的按键 "' + code + '" 不认识'); continue; }
      binds.push({ midi, code });
    }
    return { name: preset.name, description: preset.description,
             binds: sortBinds(binds), warnings, builtin: true };
  }

  /** 投票判断这份 JSON 是"音符→按键"还是"按键→音符"。0 = 音符优先，1 = 按键优先 */
  function detectDirection(obj) {
    let noteFirst = 0, codeFirst = 0;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (looksLikeNote(k)) noteFirst += 1;
      if (looksLikeCode(k)) codeFirst += 1;
      if (looksLikeNote(v)) codeFirst += 1;          // 值是音名 → 说明 key 是按键
      if (looksLikeCode(v)) noteFirst += 1;          // 值是按键 → 说明 key 是音名
    }
    return codeFirst > noteFirst ? 1 : 0;
  }

  /**
   * 把用户写的 JSON 变成能直接用的键位表。
   * 坏的地方记成 warnings 显示出来，不直接抛错 —— 一个键位写错不该让整张键位表作废。
   */
  function normalize(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      const m = materialize(DEFAULT);
      m.warnings.push('键位文件的内容不是一个 JSON 对象，已用内置默认键位');
      return m;
    }
    const raw = obj.notes || obj.keys || obj.bindings || null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      const m = materialize(DEFAULT);
      m.warnings.push('键位文件里缺少 "notes" 对象（格式：{"notes":{"C4":"KeyA", "D4":"KeyS"}}）');
      return m;
    }

    const explicit = String(obj.format || '').toLowerCase();
    let keyIsNote;
    if (/^(note[-_]?key|音符)/.test(explicit)) keyIsNote = true;
    else if (/^(key[-_]?note|按键)/.test(explicit)) keyIsNote = false;
    else keyIsNote = detectDirection(raw) === 0;

    const warnings = [];
    const binds = [];
    const seenNotes = new Set();
    for (const a of Object.keys(raw)) {
      const b = raw[a];
      const noteStr = keyIsNote ? a : b;
      const codeStr = keyIsNote ? b : a;

      const midi = toMidi(noteStr);
      if (midi == null) {
        warnings.push('"' + noteStr + '" 不像音名（写成 C4 / F#3 / 60 这样，已跳过）');
        continue;
      }
      const code = typeof codeStr === 'string' ? codeStr.trim() : '';
      if (!KNOWN_CODES.has(code)) {
        warnings.push('"' + code + '" 不是能识别的按键：要用 KeyboardEvent.code，' +
                      '例如 KeyA / Digit1 / Semicolon / ArrowLeft（已跳过）');
        continue;
      }
      if (midi < LO_MIDI || midi > HI_MIDI) {
        warnings.push(midiName(midi) + ' 超出了钢琴音域（A0–C8），采样会被拉得很怪');
      }
      if (RISKY_CODES.has(code)) {
        warnings.push('"' + code + '"（' + labelOf(code) + '）容易跟浏览器或系统抢按键，建议换一个');
      }
      if (seenNotes.has(midi)) {
        warnings.push(midiName(midi) + ' 在文件里写了两次，只保留第一条');
        continue;
      }
      seenNotes.add(midi);
      binds.push({ midi, code });
    }

    if (!binds.length) {
      const m = materialize(DEFAULT);
      m.warnings = warnings.concat(['一个能用的键位都没有，已退回内置默认键位']);
      return m;
    }
    return {
      name: (typeof obj.name === 'string' && obj.name.trim()) ? obj.name.trim() : '自定义键位',
      description: typeof obj.description === 'string' ? obj.description : '',
      binds: sortBinds(binds),
      warnings,
      builtin: false
    };
  }

  function fromJSON(text) {
    let obj;
    try { obj = JSON.parse(text); }
    catch (e) { throw new Error('不是合法的 JSON：' + (e && e.message ? e.message : e)); }
    return normalize(obj);
  }

  /** 导出成可以再编辑的 JSON：音符当 key，按键当 value */
  function toJSON(map) {
    const notes = {};
    sortBinds(map.binds).forEach((b) => { notes[midiName(b.midi)] = b.code; });
    return JSON.stringify({
      name: map.name || '自定义键位',
      description: map.description || '',
      notes: notes
    }, null, 2) + '\n';
  }

  /* ============================================================
     冲突 / 派生
     ============================================================ */

  /**
   * 冲突 = 同一个按键绑给了不止一个音。
   * 编辑时我们会自动把键从旧主人身上摘掉，所以冲突主要来自手写的 JSON ——
   * 但不管从哪来，页面都会把它们标红，因为"按下去只响一个音"这件事用户根本看不出来。
   * @returns {Array<{code:string, midis:number[]}>}
   */
  function conflicts(map) {
    const byCode = new Map();
    for (const b of map.binds) {
      const arr = byCode.get(b.code);
      if (arr) arr.push(b.midi); else byCode.set(b.code, [b.midi]);
    }
    const out = [];
    for (const [code, midis] of byCode) {
      const uniq = [...new Set(midis)].sort((a, b) => a - b);
      if (uniq.length > 1) out.push({ code, midis: uniq });
    }
    return out;
  }

  /** 运行时用：e.code → MIDI。有冲突时先到先得（低音优先，和界面里标红的那几条一致）。 */
  function codeToMidi(map) {
    const out = {};
    sortBinds(map.binds).forEach((b) => { if (out[b.code] == null) out[b.code] = b.midi; });
    return out;
  }
  /** MIDI → e.code（一个音只留一个键） */
  function noteToCode(map) {
    const out = {};
    sortBinds(map.binds).forEach((b) => { if (out[b.midi] == null) out[b.midi] = b.code; });
    return out;
  }

  function range(map) {
    if (!map.binds.length) return { lo: 60, hi: 60 };
    const ms = map.binds.map((b) => b.midi);
    return { lo: Math.min.apply(null, ms), hi: Math.max.apply(null, ms) };
  }

  /** 整组移调（页面上的「整组 ↑/↓ 八度」就是直接改每一条，不是运行时的偏移） */
  function transpose(map, semitones) {
    const out = { name: map.name, description: map.description, warnings: [],
                  builtin: false, binds: [] };
    for (const b of map.binds) {
      const m = b.midi + semitones;
      if (m < LO_MIDI || m > HI_MIDI) out.warnings.push(
        '整组移调后 ' + midiName(b.midi) + ' 会跑到 ' + midiName(m) + '，超出钢琴音域，已跳过');
      else out.binds.push({ midi: m, code: b.code });
    }
    out.binds = sortBinds(out.binds);
    if (!out.binds.length) {
      out.warnings.push('移调后一个键都不剩了，已放弃这次移调');
      return Object.assign({}, map, { warnings: out.warnings });   // 原样返回，但要说清楚为什么没变
    }
    return out;
  }

  /** 改一条绑定：把 (midi → code) 写进去。同一个键原本属于别的音，就从那个音身上摘掉。 */
  function setBinding(map, midi, code) {
    const binds = map.binds.filter((b) => b.midi !== midi && b.code !== code);
    binds.push({ midi, code });
    return Object.assign({}, map, { binds: sortBinds(binds), builtin: false,
                                    name: map.name, warnings: [] });
  }
  /** 删掉某个音的绑定 */
  function removeNote(map, midi) {
    return Object.assign({}, map, { binds: map.binds.filter((b) => b.midi !== midi),
                                    builtin: false, warnings: [] });
  }

  return { PRESETS, DEFAULT, KNOWN_CODES, RISKY_CODES, labelOf,
           looksLikeNote, looksLikeCode, detectDirection, toMidi,
           normalize, materialize, fromJSON, toJSON,
           conflicts, codeToMidi, noteToCode, range, transpose, setBinding, removeNote,
           sortBinds, LO_MIDI, HI_MIDI };
});
