/**
 * 乐谱格式化：把每个小节拆成单独一行，让文本结构和谱面一致。
 *
 *   node format-score.js <输入.txt> [输出.txt]      # 不给输出就打印到屏幕
 *
 * 只动排版，不改任何音符、时值、轨道名。
 * 解析器把行尾也当一次小节检查，所以「每行正好一小节」时拍数校验依然有效。
 *
 * 注：页面里也有同样的 formatScore()（给「🔤 每小节换行」按钮用）。
 *     两边逻辑要保持一致，改一处记得改另一处。
 */
const fs = require('fs');
const path = require('path');

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

if (require.main === module) {
  const inFile = process.argv[2];
  if (!inFile) {
    console.log('用法: node format-score.js <输入.txt> [输出.txt]');
    process.exit(1);
  }
  const src = fs.readFileSync(path.resolve(inFile), 'utf8');
  const out = formatScore(src);
  const outFile = process.argv[3];
  if (outFile) {
    fs.writeFileSync(path.resolve(outFile), out);
    const bars = (out.match(/\|/g) || []).length;
    console.log('✔ ' + path.resolve(outFile) + '  （' + bars + ' 个小节，已每小节一行）');
  } else {
    process.stdout.write(out);
  }
}

module.exports = { formatScore };
