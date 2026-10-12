/**
 * 键盘键位 —— 页面和测试共用的唯一一份。
 *
 * 为什么单独成文件：键位是"用户会自己去改"的东西，改法有两种 ——
 * 编辑仓库里的 keymap.json，或者在页面上导入一份 JSON。
 * 两条路都必须走同一套解析/校验逻辑，否则手改的文件在页面上能弹、
 * 在测试里却可能被当成非法键位悄悄丢掉一半。
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
     内置预设
     ============================================================ */

  /** ① 键盘钢琴（通用主键区）—— 各类"在线钢琴"最常见的排法：
   *  主键区 A S D F G H J K L ; ' 当白键，上面一排 W E T Y U O P 当黑键，
   *  Z / X 换八度。手指落在 A S D F「主键位」上，不用低头找键。 */
  const HOME_ROW = {
    name: '键盘钢琴（通用主键区）',
    description: '在线钢琴最常见的排法：主键区当白键，上一排当黑键，Z / X 换八度',
    octaveDown: 'KeyZ',
    octaveUp: 'KeyX',
    keys: {
      KeyA: 'C4', KeyW: 'C#4', KeyS: 'D4', KeyE: 'D#4', KeyD: 'E4',
      KeyF: 'F4', KeyT: 'F#4', KeyG: 'G4', KeyY: 'G#4', KeyH: 'A4',
      KeyU: 'A#4', KeyJ: 'B4', KeyK: 'C5', KeyO: 'C#5', KeyL: 'D5',
      KeyP: 'D#5', Semicolon: 'E5', Quote: 'F5'
    }
  };

  /** ② 双排两个八度 —— DAW（Ableton / FL Studio）和电子琴软件教的那种：
   *  Z X C V B N M 一个八度，Q W E R T Y U 上八度，黑键在 S D G H J 和 2 3 5 6 7。 */
  const TWO_ROW = {
    name: '双排两个八度（DAW / 电钢风格）',
    description: 'Ableton / FL Studio 那套：ZXCVBNM + QWERTYU 两排白键，SDGHJ + 23567 当黑键',
    octaveDown: 'ArrowLeft',
    octaveUp: 'ArrowRight',
    keys: {
      KeyZ: 'C3', KeyS: 'C#3', KeyX: 'D3', KeyD: 'D#3', KeyC: 'E3', KeyV: 'F3',
      KeyG: 'F#3', KeyB: 'G3', KeyH: 'G#3', KeyN: 'A3', KeyJ: 'A#3', KeyM: 'B3',
      KeyQ: 'C4', Digit2: 'C#4', KeyW: 'D4', Digit3: 'D#4', KeyE: 'E4', KeyR: 'F4',
      Digit5: 'F#4', KeyT: 'G4', Digit6: 'G#4', KeyY: 'A4', Digit7: 'A#4', KeyU: 'B4'
    }
  };

  /** ③ 单排一个八度 —— 只想随便敲敲、不想记两排的时候用 */
  const ONE_ROW = {
    name: '单排一个八度（最省事）',
    description: 'A S D F G H J 就是 do re mi fa sol la si，W E T Y U 是黑键',
    octaveDown: 'KeyZ',
    octaveUp: 'KeyX',
    keys: {
      KeyA: 'C4', KeyW: 'C#4', KeyS: 'D4', KeyE: 'D#4', KeyD: 'E4',
      KeyF: 'F4', KeyT: 'F#4', KeyG: 'G4', KeyY: 'G#4', KeyH: 'A4',
      KeyU: 'A#4', KeyJ: 'B4'
    }
  };

  const PRESETS = [HOME_ROW, TWO_ROW, ONE_ROW];
  const DEFAULT = HOME_ROW;

  /* ============================================================
     解析 / 校验
     ============================================================ */

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

  /**
   * 把用户写的 JSON 变成能直接用的键位表。坏的地方记成 warnings 显示出来，
   * 不直接抛错 —— 一个键位写错不该让整张键位表作废。
   */
  function normalize(obj) {
    const warnings = [];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return Object.assign({}, materialize(DEFAULT), { warnings: ['键位文件的内容不是一个 JSON 对象'] });
    }
    const rawKeys = obj.keys || obj.bindings || null;
    if (!rawKeys || typeof rawKeys !== 'object' || Array.isArray(rawKeys)) {
      return Object.assign({}, materialize(DEFAULT),
        { warnings: ['键位文件里缺少 "keys" 对象（格式：{"keys":{"KeyA":"C4", ...}}）'] });
    }
    const keys = {};
    let badCode = 0, badNote = 0;
    for (const code of Object.keys(rawKeys)) {
      if (!KNOWN_CODES.has(code)) {
        badCode++;
        warnings.push('不认识的按键 "' + code + '"：要用 KeyboardEvent.code，' +
                      '例如 KeyA / Digit1 / Semicolon / ArrowLeft（已跳过）');
        continue;
      }
      const midi = toMidi(rawKeys[code]);
      if (midi == null) {
        badNote++;
        warnings.push('"' + code + '" 的音名 "' + rawKeys[code] + '" 读不出来（写成 C4 / F#3 / 60 这样，已跳过）');
        continue;
      }
      if (midi < 21 || midi > 108) {
        warnings.push('"' + code + '" = ' + midiName(midi) + ' 超出了钢琴音域（A0–C8），' +
                      '采样会被拉得很怪，建议改到音域内');
      }
      keys[code] = midi;
    }
    if (!Object.keys(keys).length) {
      return Object.assign({}, materialize(DEFAULT), {
        warnings: warnings.concat(['一个能用的键位都没有，已退回内置默认键位'])
      });
    }
    const pick = (v, fb) => (typeof v === 'string' && KNOWN_CODES.has(v)) ? v : fb;
    return {
      name: (typeof obj.name === 'string' && obj.name.trim()) ? obj.name.trim() : '自定义键位',
      description: typeof obj.description === 'string' ? obj.description : '',
      octaveDown: pick(obj.octaveDown, 'ArrowLeft'),
      octaveUp: pick(obj.octaveUp, 'ArrowRight'),
      keys: keys,
      warnings: warnings,
      builtin: false
    };
  }

  /** 预设 → 和 normalize 输出同一种结构 */
  function materialize(preset) {
    const o = { name: preset.name, description: preset.description,
                octaveDown: preset.octaveDown, octaveUp: preset.octaveUp,
                keys: {}, warnings: [], builtin: true };
    for (const code of Object.keys(preset.keys)) o.keys[code] = toMidi(preset.keys[code]);
    return o;
  }

  /** 页面：把一份键位 JSON 文本变成键位表（JSON 语法错会 throw，好让页面提示） */
  function fromJSON(text) {
    let obj;
    try { obj = JSON.parse(text); }
    catch (e) { throw new Error('不是合法的 JSON：' + (e && e.message ? e.message : e)); }
    return normalize(obj);
  }

  /** 导出成可以再编辑的 JSON 文本（音名而不是数字，人能看懂） */
  function toJSON(map) {
    const keys = {};
    Object.keys(map.keys).sort().forEach((c) => { keys[c] = midiName(map.keys[c]); });
    return JSON.stringify({
      name: map.name || '自定义键位',
      description: map.description || '',
      keys: keys,
      octaveDown: map.octaveDown || 'ArrowLeft',
      octaveUp: map.octaveUp || 'ArrowRight'
    }, null, 2) + '\n';
  }

  /** 键位表里最低 / 最高的音 */
  function range(map) {
    const ms = Object.keys(map.keys).map((c) => map.keys[c]);
    return ms.length ? { lo: Math.min.apply(null, ms), hi: Math.max.apply(null, ms) } : { lo: 60, hi: 60 };
  }

  /** 整体还能上下挪几个八度（挪完不能跑出 A0~C8） */
  function shiftLimits(map) {
    const r = range(map);
    return {
      down: Math.max(0, Math.floor((r.lo - LO_MIDI) / 12)),
      up: Math.max(0, Math.floor((HI_MIDI - r.hi) / 12))
    };
  }

  /** 加上八度偏移之后，每个键对应哪个音（页面用它来画琴键上的字母） */
  function resolveAll(map, shift) {
    const out = {};
    for (const code of Object.keys(map.keys)) out[code] = map.keys[code] + (shift || 0);
    return out;
  }

  return { PRESETS, DEFAULT, KNOWN_CODES, labelOf, normalize, materialize,
           fromJSON, toJSON, range, shiftLimits, resolveAll, toMidi, LO_MIDI, HI_MIDI };
});
