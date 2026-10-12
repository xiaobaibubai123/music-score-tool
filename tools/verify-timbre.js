/**
 * 音源回归测试 —— 现在用真实钢琴采样，合成器只在采样拿不到时兜底。
 *
 * 检查四件事：
 *   1. 采样清单覆盖足够宽的音域（否则超出范围的音会被拉得很怪）
 *   2. 采样文件确实能取到（换服务器/改目录时最容易漏）
 *   3. 页面真的用上了采样（而不是悄悄退回合成器）
 *   4. 兜底合成器仍比最初那版明显亮、且会衰减
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
  const errs = [], badReqs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('response', r => { if (r.status() >= 400) badReqs.push('HTTP ' + r.status() + ' ' + r.url()); });
  await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });

  /* ---------- 1. 采样清单 ---------- */
  const inv = await page.evaluate(() => {
    const P = (typeof PIANO !== 'undefined') ? PIANO : null;
    if (!P) return { error: '页面里找不到 PIANO' };
    const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const midiOf = (n) => {
      const m = /^([A-G])(#|b)?(-?\d+)$/.exec(n);
      if (!m) return NaN;
      const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
      let v = base[m[1]] + 12 * (+m[3] + 1);
      if (m[2] === '#') v += 1;
      if (m[2] === 'b') v -= 1;
      return v;
    };
    const keys = Object.keys(P.samples || {});
    const ms = keys.map(midiOf).sort((a, b) => a - b);
    return {
      count: keys.length,
      lo: NAMES[ms[0] % 12] + (Math.floor(ms[0] / 12) - 1),
      hi: NAMES[ms[ms.length - 1] % 12] + (Math.floor(ms[ms.length - 1] / 12) - 1),
      loMidi: ms[0], hiMidi: ms[ms.length - 1],
      dir: P.sampleDir,
      firstUrl: P.sampleDir + P.samples[keys[0]],
      fallbackType: P.fallback && P.fallback.oscillator ? P.fallback.oscillator.type : null,
      fallbackPartials: P.fallback && P.fallback.oscillator ? (P.fallback.oscillator.partials || []).length : 0,
      fallbackSustain: P.fallback && P.fallback.envelope ? P.fallback.envelope.sustain : null,
    };
  });
  if (inv.error) { console.error('✖ ' + inv.error); await browser.close(); process.exit(1); }

  console.log('采样: ' + inv.count + ' 个，音域 ' + inv.lo + '–' + inv.hi +
              '（MIDI ' + inv.loMidi + '–' + inv.hiMidi + '），目录 ' + inv.dir + '\n');

  check('采样数量 ≥ 25', inv.count >= 25, inv.count + ' 个');
  check('采样音域覆盖 A0–C8（钢琴全音域，超出会被拉得很难听）',
        inv.loMidi <= 22 && inv.hiMidi >= 108, inv.lo + '–' + inv.hi);
  check('采样目录以 / 结尾且指向 vendor/piano/',
        /^vendor\/piano\/$/.test(inv.dir), inv.dir);

  /* ---------- 2. 采样文件真的能取到 ---------- */
  const probe = await page.evaluate(async (base) => {
    const P = PIANO;
    const keys = Object.keys(P.samples);
    const pick = [keys[0], keys[Math.floor(keys.length / 2)], keys[keys.length - 1]];
    const out = [];
    for (const k of pick) {
      try {
        const r = await fetch(P.sampleDir + P.samples[k]);
        const b = await r.arrayBuffer();
        out.push({ k, status: r.status, bytes: b.byteLength,
                   type: r.headers.get('content-type') || '' });
      } catch (e) { out.push({ k, status: 0, bytes: 0, type: 'ERR ' + e.message }); }
    }
    return out;
  }, BASE);
  console.log('采样抽样: ' + probe.map(p => p.k + ' ' + p.status + ' ' +
    Math.round(p.bytes / 1024) + 'KB ' + p.type).join('  |  ') + '\n');
  check('采样文件都能下载到', probe.every(p => p.status === 200 && p.bytes > 5000),
        probe.map(p => p.k + ':' + p.status + '/' + p.bytes).join(' '));
  check('采样以 audio/mpeg 返回（浏览器能直接解码）',
        probe.every(p => /audio\/mpeg/.test(p.type)), probe.map(p => p.type).join(' '));

  /* ---------- 3. 页面确实用上了采样 ---------- */
  // 注意：不能用 element.click() —— 那只派发 click，不会派发 pointerdown，
  // 而页面的音频解锁监听的是 pointerdown，所以必须用真实鼠标事件。
  await page.mouse.click(400, 400);
  await page.waitForFunction(() => typeof audioReady !== 'undefined' && audioReady === true,
    { timeout: 90000 }).catch(() => {});
  const kind = await page.evaluate(() => (typeof instrumentKind !== 'undefined') ? instrumentKind : '(未定义)');
  check('页面用的是采样音源而不是合成器兜底', kind === 'sampler', kind || '(空)' + ' audioReady=' + (await page.evaluate(() => audioReady)));

  // 采样真的能出声，而且是衰减的（钢琴特征）
  const snd = await page.evaluate(async () => {
    const T = window.Tone;
    const at = (d, t) => { const i = Math.floor(t * 44100); let p = 0;
      for (let j = i; j < Math.min(d.length, i + 2205); j++) { const v = Math.abs(d[j]); if (v > p) p = v; } return p; };
    const buf = await T.Offline(async () => {
      const inst = await buildInstrument();
      inst.out.toDestination();
      inst.node.volume.value = PIANO.volume;
      for (const n of ['C3', 'C5', 'G5']) inst.node.triggerAttackRelease(n, 0.5, 0);
    }, 2.5, 1, 44100);
    const d = buf.getChannelData(0);
    let peak = 0; for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
    return { kind: await (async () => (await buildInstrument()).kind)(),
             peak, a50: at(d, 0.05), a1: at(d, 1.0) };
  });
  check('采样能真正出声（峰值 > 0.02）', snd.peak > 0.02, snd.peak.toFixed(3));
  check('钢琴采样是衰减的（1 秒后比 50ms 时轻）', snd.a1 < snd.a50,
        '50ms ' + snd.a50.toFixed(3) + ' → 1s ' + snd.a1.toFixed(3));

  /* ---------- 4. 兜底合成器仍然合格 ---------- */
  const fb = await page.evaluate(async () => {
    const T = window.Tone;
    const LEGACY = { maxPolyphony: 64, oscillator: { type: 'triangle' },
                     envelope: { attack: 0.012, decay: 0.18, sustain: 0.32, release: 1.0 } };
    const rms = (b) => { const d = b.getChannelData(0); let q = 0;
      for (let i = 0; i < d.length; i++) q += d[i] * d[i]; return Math.sqrt(q / d.length); };
    async function probe(cfg, filterHz, note) {
      const mk = () => { const s = new T.PolySynth(T.Synth, cfg);
        const f = new T.Filter({ frequency: filterHz, type: 'lowpass', rolloff: -12 });
        s.connect(f); return s; };
      const full = await T.Offline(async () => { const s = mk(); s.toDestination();
        s.volume.value = -8; s.triggerAttackRelease(note, 1, 0); }, 2.0, 1, 44100);
      const hp = await T.Offline(async () => { const s = mk();
        const h = new T.Filter({ type: 'highpass', frequency: 3000, rolloff: -12 });
        s.connect(h); h.toDestination(); s.volume.value = -8; s.triggerAttackRelease(note, 1, 0); }, 2.0, 1, 44100);
      const d = full.getChannelData(0);
      const at = (t) => { const i = Math.floor(t * 44100); let p = 0;
        for (let j = i; j < Math.min(d.length, i + 2205); j++) { const v = Math.abs(d[j]); if (v > p) p = v; } return p; };
      return { hf: rms(hp) / Math.max(1e-9, rms(full)) * 100, decay: at(1) / Math.max(1e-9, at(0.05)) };
    }
    return { C5: { now: await probe(PIANO.fallback, PIANO.fallbackFilterHz, 'C5'),
                   old: await probe(LEGACY, 5200, 'C5') } };
  });
  const ratio = fb.C5.now.hf / Math.max(1e-9, fb.C5.old.hf);
  check('兜底合成器比最初那版至少亮 1.8 倍', ratio >= 1.8,
        ratio.toFixed(1) + '×（' + fb.C5.now.hf.toFixed(1) + '% vs ' + fb.C5.old.hf.toFixed(1) + '%）');
  check('兜底合成器会衰减（1 秒后残留 ≤ 0.30）', fb.C5.now.decay <= 0.30, fb.C5.now.decay.toFixed(3));
  check('兜底合成器用谐波列而不是三角波', inv.fallbackType === 'custom' && inv.fallbackPartials >= 8,
        inv.fallbackType + ' / ' + inv.fallbackPartials + ' 个谐波');

  check('无未捕获 JS 异常', errs.length === 0, JSON.stringify(errs.slice(0, 3)));
  const br = badReqs.filter(u => !/favicon/i.test(u));
  check('无资源加载失败', br.length === 0, JSON.stringify(br.slice(0, 3)));

  await browser.close();
  const failed = results.filter(x => !x.ok);
  console.log('\n===== ' + (results.length - failed.length) + ' / ' + results.length + ' 通过 =====');
  failed.forEach(f => console.log('  ✗ ' + f.name + ' :: ' + f.detail));
  if (failed.length) process.exitCode = 1;
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
