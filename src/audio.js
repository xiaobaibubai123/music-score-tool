/**
 * 钢琴音源 —— 工作台（index.html）和演奏录音页（record.html）共用的唯一一份。
 *
 * 为什么单独成文件：和 parser.js 一样的理由。以前这段代码只在 index.html 里，
 * 一旦演奏页需要"按一下键盘就出声"，最省事的做法就是复制一份过去 ——
 * 然后调音量、换采样、改兜底合成器时就只改一边，两个页面听到的音色悄悄不一样了。
 * 抽出来之后，改一次两边同时生效。
 *
 * 浏览器：<script src="parser.js"></script><script src="audio.js"></script> → window.ScoreAudio
 * Node：  require('./audio.js')（纯配置，建乐器要 Web Audio，只能在浏览器里跑）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./parser.js'));
  else root.ScoreAudio = factory(root.ScoreParser);
})(typeof self !== 'undefined' ? self : this, function (Parser) {
  'use strict';

  const midiName = (Parser && Parser.midiName) ||
    ((m) => ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][((m % 12) + 12) % 12] +
            (Math.floor(m / 12) - 1));

  /* 采样点：A0 起每 3 个半音一个直到 C8。
   * ⚠ 键必须是标准音名（D#1），值才是文件名 —— Salamander 的文件名用 s 表示升号（Ds1.mp3），
   *   直接把文件名当键会让 Tone.Sampler 认不出音名、静默退回合成器。 */
  const PIANO_SAMPLES = {
    'A0': 'A0.mp3',
    'C1': 'C1.mp3', 'D#1': 'Ds1.mp3', 'F#1': 'Fs1.mp3', 'A1': 'A1.mp3',
    'C2': 'C2.mp3', 'D#2': 'Ds2.mp3', 'F#2': 'Fs2.mp3', 'A2': 'A2.mp3',
    'C3': 'C3.mp3', 'D#3': 'Ds3.mp3', 'F#3': 'Fs3.mp3', 'A3': 'A3.mp3',
    'C4': 'C4.mp3', 'D#4': 'Ds4.mp3', 'F#4': 'Fs4.mp3', 'A4': 'A4.mp3',
    'C5': 'C5.mp3', 'D#5': 'Ds5.mp3', 'F#5': 'Fs5.mp3', 'A5': 'A5.mp3',
    'C6': 'C6.mp3', 'D#6': 'Ds6.mp3', 'F#6': 'Fs6.mp3', 'A6': 'A6.mp3',
    'C7': 'C7.mp3', 'D#7': 'Ds7.mp3', 'F#7': 'Fs7.mp3', 'A7': 'A7.mp3',
    'C8': 'C8.mp3'
  };

  const PIANO = {
    sampleDir: 'vendor/piano/',
    samples: PIANO_SAMPLES,
    volume: -10,      // 采样本身已经很响，3 个音同时弹峰值就冲到 1.39（削波），所以留足余量
    reverb: { decay: 1.8, preDelay: 0.01, wet: 0.13 },
    // ↓ 拿不到采样时用的合成器。实测过：三角波谐波太少（高频仅 6.7%）听起来像电子蜂鸣，
    //   所以这里用 16 个谐波按 1/n^1.3 衰减 + 无 sustain 的钢琴包络。
    fallback: {
      maxPolyphony: 64,
      oscillator: {
        type: 'custom',
        partials: Array.from({ length: 16 }, (_, i) => +(1 / Math.pow(i + 1, 1.3)).toFixed(3))
      },
      envelope: { attack: 0.004, decay: 2.2, sustain: 0.05, release: 0.85 }
    },
    fallbackFilterHz: 9500
  };

  /** 建乐器：优先真实钢琴采样，失败退回合成器。试听 / 演奏 / MP3 导出共用这一份。 */
  async function buildInstrument(Tone) {
    const T = Tone || root.Tone;
    if (!T) throw new Error('Tone.js 未加载');
    const out = new T.Gain(1);
    try {
      const s = new T.Sampler({ urls: PIANO.samples, baseUrl: PIANO.sampleDir });
      await T.loaded();                 // 等所有采样真的下完
      s.connect(out);
      return { node: s, out, kind: 'sampler' };
    } catch (e) {
      // 采样拿不到（离线打开 / 服务器没放 vendor/piano / 音名写错）时退回合成器。
      // 一定要留下日志，否则「悄悄退回」很难排查。
      console.warn('钢琴采样加载失败，退回合成音色：', e && e.message ? e.message : e);
      const p = new T.PolySynth(T.Synth, PIANO.fallback);
      const f = new T.Filter({ frequency: PIANO.fallbackFilterHz, type: 'lowpass', rolloff: -12 });
      p.connect(f); f.connect(out);
      return { node: p, out, kind: 'synth' };
    }
  }

  /* 按下 / 松开：Tone.Sampler 和 Tone.PolySynth 的 API 是一致的，
     但都要自己把 MIDI 号换成音名，别在页面里各写一遍。 */
  const attack = (node, midi, velocity, time) =>
    node.triggerAttack(midiName(midi), time, velocity == null ? 0.85 : velocity);
  const release = (node, midi, time) => node.triggerRelease(midiName(midi), time);

  return { PIANO, PIANO_SAMPLES, buildInstrument, attack, release, midiName };
});
