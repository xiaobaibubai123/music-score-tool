/** 定位 Chrome / Edge 可执行文件。
 *  优先用环境变量 CHROME_PATH，其次按常见安装位置查找（Windows / macOS / Linux）。 */
const fs = require('fs');

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const found = CANDIDATES.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });

if (!found) {
  console.error('找不到 Chrome / Edge。请设置环境变量 CHROME_PATH 指向浏览器可执行文件，例如：');
  console.error('  Windows:  set CHROME_PATH=C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  console.error('  macOS:    export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"');
  process.exit(2);
}

module.exports = found;
