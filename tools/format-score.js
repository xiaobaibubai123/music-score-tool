/**
 * 乐谱格式化：把每个小节拆成单独一行，让文本结构和谱面一致。
 *
 *   node format-score.js <输入.txt> [输出.txt]      # 不给输出就打印到屏幕
 *
 * 只动排版，不改任何音符、时值、轨道名。
 * 解析器把行尾也当一次小节检查，所以「每行正好一小节」时拍数校验依然有效。
 *
 */
const fs = require('fs');
const path = require('path');
// formatScore 本体在 ../parser.js —— 和页面共用同一份，别在这里再抄一遍
const { formatScore } = require('../src/parser.js');


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
