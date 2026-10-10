/**
 * 测量一次页面访问真正产生了多少网络传输量。
 * 用 CDP 的 Network 域逐个请求统计 encodedDataLength。
 */
const puppeteer = require('puppeteer-core');

const CHROME = require('./chrome.js');
const BASE = (process.env.BASE_URL || 'http://localhost:8081').replace(/\/+$/, '');
const PAGES = ['/', '/editor.html'];

async function measure(browser, url, { clearCache }) {
  const page = await browser.newPage();
  const cdp = await page.target().createCDPSession();
  await cdp.send('Network.enable');

  const meta = new Map();   // requestId -> {url, status, fromDiskCache}
  const sizes = new Map();  // requestId -> bytes

  cdp.on('Network.responseReceived', (e) => {
    meta.set(e.requestId, {
      url: e.response.url,
      status: e.response.status,
      fromDiskCache: !!e.response.fromDiskCache,
      type: e.type,
    });
  });
  cdp.on('Network.loadingFinished', (e) => sizes.set(e.requestId, e.encodedDataLength));

  if (clearCache) await cdp.send('Network.clearBrowserCache');

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 500));

  const rows = [];
  for (const [id, m] of meta) {
    if (!m.url.startsWith('http')) continue;
    rows.push({ ...m, bytes: sizes.get(id) || 0 });
  }
  await page.close();

  const total = rows.reduce((s, r) => s + r.bytes, 0);
  const statuses = {};
  rows.forEach(r => { statuses[r.status] = (statuses[r.status] || 0) + 1; });
  return { rows, total, statuses };
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'shell',
    args: ['--no-sandbox', '--mute-audio'],
  });

  for (const p of PAGES) {
    const cold = await measure(browser, BASE + p, { clearCache: true });
    const warm = await measure(browser, BASE + p, { clearCache: false });

    console.log('\n──────────────────────────────────────────────');
    console.log('页面 ' + p);
    console.log('──────────────────────────────────────────────');
    console.log('【首次访问 · 空缓存】  ' + (cold.total / 1024).toFixed(1) + ' KB  /  ' +
                cold.rows.length + ' 个请求   状态码 ' + JSON.stringify(cold.statuses));
    cold.rows.sort((a, b) => b.bytes - a.bytes)
      .forEach(r => console.log('    ' + String(Math.round(r.bytes / 1024)).padStart(5) + ' KB  ' +
        String(r.status) + '  ' + r.url.replace(BASE, '')));

    console.log('【再次访问 · 有缓存】  ' + (warm.total / 1024).toFixed(1) + ' KB  /  ' +
                warm.rows.length + ' 个请求   状态码 ' + JSON.stringify(warm.statuses));
    warm.rows.sort((a, b) => b.bytes - a.bytes)
      .forEach(r => console.log('    ' + String(Math.round(r.bytes)).padStart(5) + ' B   ' +
        String(r.status) + (r.fromDiskCache ? ' (磁盘缓存)' : '') + '  ' + r.url.replace(BASE, '')));
  }

  await browser.close();
})().catch(e => { console.error(e); process.exitCode = 1; });
