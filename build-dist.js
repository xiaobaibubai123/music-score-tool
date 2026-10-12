/**
 * 打包成可直接上传到任意静态托管的 dist/ 目录。
 *
 *   node build-dist.js
 *
 * 产物结构（自包含，不依赖 node_modules，全部相对路径）：
 *   dist/index.html     乐谱工作台（唯一页面）
 *   dist/vendor/*.js    Tone.js + @tonejs/midi + lamejs（本地化）
 *   dist/assets/demo.mid 内置示例
 *
 * 上传 dist/ 里的【内容】到网站根目录即可；放在子目录（如 GitHub Pages 的 /repo/）也能用，
 * 因为页面里没有任何以 / 开头的绝对路径。
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

const FILES = ['index.html'];
const DIRS = ['vendor', 'assets'];

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name), d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

// 安全检查：产物里不允许出现以 / 开头的绝对资源路径
function checkNoAbsolutePaths(file) {
  const html = fs.readFileSync(file, 'utf8');
  const bad = [];
  const re = /(?:src|href)\s*=\s*"(\/[^"]*)"|fetch\(\s*'(\/[^']*)'/g;
  let m;
  while ((m = re.exec(html))) bad.push(m[1] || m[2]);
  return bad;
}

function main() {
  // 源头就检查一遍，别把问题带到 dist
  const srcBad = [];
  FILES.forEach(f => checkNoAbsolutePaths(path.join(ROOT, f))
    .forEach(p => srcBad.push(f + ' → ' + p)));
  if (srcBad.length) {
    console.error('✖ 源文件里还有绝对路径，部署到子目录会 404：');
    srcBad.forEach(s => console.error('   ' + s));
    process.exit(1);
  }

  const required = ['vendor/Tone.js', 'vendor/Midi.js', 'vendor/lame.min.js',
                    'vendor/piano/A0.mp3', 'vendor/piano/C4.mp3', 'vendor/piano/C8.mp3',
                    'assets/demo.mid'];
  const missing = required.filter(r => !fs.existsSync(path.join(ROOT, r)));
  if (missing.length) {
    console.error('✖ 缺少自包含资源（请先从 node_modules 复制到 vendor/）：');
    missing.forEach(m => console.error('   ' + m));
    process.exit(1);
  }
  // 钢琴采样少一个，对应的音就只能靠邻近采样硬拉，听起来会怪 —— 数量对不上直接拦下
  const sampleDir = path.join(ROOT, 'vendor', 'piano');
  const nSamples = fs.existsSync(sampleDir)
    ? fs.readdirSync(sampleDir).filter(f => f.endsWith('.mp3')).length : 0;
  if (nSamples < 30) {
    console.error('✖ 钢琴采样只有 ' + nSamples + ' 个（应为 30 个，A0–C8 每 3 个半音一个）');
    process.exit(1);
  }

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  FILES.forEach(f => fs.copyFileSync(path.join(ROOT, f), path.join(DIST, f)));
  DIRS.forEach(d => copyDir(path.join(ROOT, d), path.join(DIST, d)));

  const files = walk(DIST).sort();
  let total = 0;
  console.log('✔ 打包完成 → ' + DIST + '\n');
  for (const f of files) {
    const size = fs.statSync(path.join(DIST, f)).size;
    total += size;
    console.log('   ' + String(Math.round(size / 1024)).padStart(5) + ' KB  ' + f);
  }
  console.log('\n   合计 ' + (total / 1024).toFixed(1) + ' KB，共 ' + files.length + ' 个文件');
  console.log('\n本地预览：  node serve.js 8082 dist');
  console.log('上传：把 dist/ 里的全部内容传到网站根目录（或任意子目录）即可。');
}

main();
