/**
 * 音色回归测试 —— 直接从页面读出 PIANO 定义，和「旧音色」在同一条件下对比。
 *
 *   HF%   —— 指定频率以上的能量占比。越大越亮、越"清脆"
 *   decay —— 1 秒后振幅 / 50ms 振幅。钢琴是"敲下去就衰减"，该值必须远小于 1
 *
 * 为什么要有这个测试：
 *   最初的音色是「三角波 + sustain 0.32 + 5200Hz 低通」，
 *   实测 C5 高频只有 6.7%、1 秒后还残留 62% —— 听感就是"闷、不清脆、糊成一团"。
 *   这种问题耳朵听得出来，一般的功能测试抓不到，所以单独量化卡住。
 *
 * 判据用「相对旧音色的倍数」，而不是绝对阈值 —— 因为低音的能量本来就在 3kHz 以下，
 * 对 C3 用固定阈值会误判（实测任何配置都只有 2~4%）。
 *
 *   node verify-timbre.js
 */
const puppeteer = require('puppeteer-core');

const CHROME = require('./chrome.js');
const BASE = (process.env.BASE_URL || 'http://localhost:8081').replace(/\/+$/, '');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  :: ' + detail : ''));
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'shell',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });

  const r = await page.evaluate(async () => {
    const T = window.Tone;
    const P = (typeof PIANO !== 'undefined') ? PIANO : null;
    if (!P) return { error: '页面里找不到 PIANO 定义' };

    // 最初那版音色，用来做对比基准
    const LEGACY = { maxPolyphony: 64, oscillator: { type: 'triangle' },
                     envelope: { attack: 0.012, decay: 0.18, sustain: 0.32, release: 1.0 } };

    const rms = (b) => { const d = b.getChannelData(0); let q = 0;
      for (let i = 0; i < d.length; i++) q += d[i] * d[i]; return Math.sqrt(q / d.length); };

    /** 量某个音色在 note 上的高频占比 / 衰减 / 峰值 */
    async function probe(voiceCfg, filterHz, note, hpHz) {
      const mk = () => {
        const s = new T.PolySynth(T.Synth, voiceCfg);
        const f = new T.Filter({ frequency: filterHz, type: 'lowpass', rolloff: -12 });
        s.connect(f);
        return s;
      };
      const full = await T.Offline(async () => {
        const s = mk(); s.toDestination(); s.volume.value = -8; s.triggerAttackRelease(note, 1, 0);
      }, 2.0, 1, 44100);
      const hp = await T.Offline(async () => {
        const s = mk();
        const h = new T.Filter({ type: 'highpass', frequency: hpHz, rolloff: -12 });
        s.connect(h); h.toDestination(); s.volume.value = -8; s.triggerAttackRelease(note, 1, 0);
      }, 2.0, 1, 44100);
      const d = full.getChannelData(0);
      let peak = 0; for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
      const at = (t) => { const i = Math.floor(t * 44100); let p = 0;
        for (let j = i; j < Math.min(d.length, i + 2205); j++) { const v = Math.abs(d[j]); if (v > p) p = v; } return p; };
      return { hf: rms(hp) / Math.max(1e-9, rms(full)) * 100, peak,
               decay: at(1) / Math.max(1e-9, at(0.05)) };
    }

    const out = { voice: P.voice.oscillator, sustain: P.voice.envelope.sustain,
                  filterHz: P.filterHz, n: (P.voice.oscillator.partials || []).length, notes: {} };
    // 低音用 1.2kHz 带、中高音用 3kHz 带
    for (const [note, hp] of [['C3', 1200], ['C5', 3000], ['G5', 3000]]) {
      out.notes[note] = {
        now: await probe(P.voice, P.filterHz, note, hp),
        old: await probe(LEGACY, 5200, note, hp),
        hp,
      };
    }
    return out;
  });

  if (r.error) { console.error('✖ ' + r.error); await browser.close(); process.exit(1); }

  console.log('页面实际音色: type=' + r.voice.type + '  谐波=' + r.n +
              '  sustain=' + r.sustain + '  低通=' + r.filterHz + 'Hz\n');
  console.log('  音符  高通      现在 HF%   旧 HF%   倍率    现在 decay  旧 decay');
  for (const [n, v] of Object.entries(r.notes)) {
    console.log('  ' + n.padEnd(5) + String(v.hp + 'Hz').padStart(8) +
      String(v.now.hf.toFixed(1) + '%').padStart(11) +
      String(v.old.hf.toFixed(1) + '%').padStart(9) +
      String((v.now.hf / Math.max(1e-9, v.old.hf)).toFixed(1) + '×').padStart(8) +
      String(v.now.decay.toFixed(3)).padStart(12) +
      String(v.old.decay.toFixed(3)).padStart(10));
  }
  console.log('');

  for (const [n, v] of Object.entries(r.notes)) {
    const ratio = v.now.hf / Math.max(1e-9, v.old.hf);
    check(n + ' 高频比旧音色至少亮 1.8 倍', ratio >= 1.8,
          ratio.toFixed(1) + '×（' + v.now.hf.toFixed(1) + '% vs ' + v.old.hf.toFixed(1) + '%）');
    check(n + ' 1 秒后残留 ≤ 0.30，且远低于旧音色', v.now.decay <= 0.30 && v.now.decay < v.old.decay * 0.6,
          v.now.decay.toFixed(3) + ' vs 旧 ' + v.old.decay.toFixed(3));
    check(n + ' 峰值 0.05~0.95（不爆音也不太小）', v.now.peak > 0.05 && v.now.peak < 0.95,
          v.now.peak.toFixed(3));
  }
  check('用谐波列而不是单一三角波（三角波听起来像电子蜂鸣）',
        r.voice.type === 'custom' && r.n >= 8, r.voice.type + ' / ' + r.n + ' 个谐波');
  check('没有长音 sustain（钢琴是敲下去就衰减）', Number(r.sustain) <= 0.1, String(r.sustain));
  check('无未捕获 JS 异常', errs.length === 0, JSON.stringify(errs.slice(0, 3)));

  await browser.close();
  const failed = results.filter(x => !x.ok);
  console.log('\n===== ' + (results.length - failed.length) + ' / ' + results.length + ' 通过 =====');
  failed.forEach(f => console.log('  ✗ ' + f.name + ' :: ' + f.detail));
  if (failed.length) process.exitCode = 1;
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
