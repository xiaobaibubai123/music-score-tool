/**
 * 极简静态服务器 —— 用来跑 index.html / editor.html / embed.html
 * 不需要 webpack，也不会有 TS 报错。
 *
 *   node serve.js                 # 默认发布本脚本所在目录（项目根），http://localhost:8081/
 *   node serve.js 9000            # 换端口
 *   node serve.js 9000 dist       # 发布指定目录（相对【当前所在目录】解析）
 *
 * 已经做了两件对「服务器压力」很关键的事：
 *   1. gzip / brotli 压缩 —— Tone.js 从 341 KB 压到 ~78 KB
 *   2. 分级缓存 —— vendor/ 与 assets/ 长期强缓存，HTML 每次校验保证更新能生效
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// 不给目录参数时，默认发布项目根目录；给了就相对当前工作目录解析，符合命令行直觉
const ROOT = process.argv[3] ? path.resolve(process.cwd(), process.argv[3]) : __dirname;
const PORT = Number(process.argv[2] || process.env.PORT || 8081);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':    'text/javascript; charset=utf-8',
  '.mjs':   'text/javascript; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.json':  'application/json; charset=utf-8',
  '.mid':   'audio/midi',
  '.midi':  'audio/midi',
  '.mp3':   'audio/mpeg',
  '.wav':   'audio/wav',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.webp':  'image/webp',
  '.svg':   'image/svg+xml',
  '.ico':   'image/x-icon',
  '.map':   'application/json; charset=utf-8',
  '.txt':   'text/plain; charset=utf-8',
  '.md':    'text/plain; charset=utf-8',
};

// 文本类资源才值得压缩；midi/mp3/png 本身已压缩，再压反而浪费 CPU
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.md', '.map']);

// vendor/ 和 assets/ 内容基本不变（库换代时改 HTML 里的 ?v=N 即可），可以长期强缓存
const IMMUTABLE = /^\/(vendor|assets)\//;

function pickEncoding(accept = '') {
  if (/\bbr\b/.test(accept)) return 'br';
  if (/\bgzip\b/.test(accept)) return 'gzip';
  if (/\bdeflate\b/.test(accept)) return 'deflate';
  return null;
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    res.writeHead(400).end('Bad request');
    return;
  }

  if (pathname === '/') pathname = '/index.html';
  if (pathname.length > 1 && pathname.endsWith('/')) pathname += 'index.html';

  const target = path.resolve(ROOT, '.' + pathname);
  // 防目录穿越：解析后的路径必须仍在发布目录内
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + pathname);
      return;
    }

    const ext = path.extname(target).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const cache = IMMUTABLE.test(pathname)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';

    // 条件请求：HTML 每次带 If-None-Match 来问，内容没变就回 304（只有几百字节响应头，
    // 不重传正文）。没有这一步的话 no-cache 会导致每次访问都全量重下 HTML。
    const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    const lastModified = st.mtime.toUTCString();
    if (req.headers['if-none-match'] === etag ||
        req.headers['if-modified-since'] === lastModified) {
      res.writeHead(304, {
        'ETag': etag, 'Last-Modified': lastModified, 'Cache-Control': cache,
      });
      res.end();
      return;
    }

    const headers = {
      'Content-Type': type,
      'Cache-Control': cache,
      'Vary': 'Accept-Encoding',
      'ETag': etag,
      'Last-Modified': lastModified,
    };

    const encoding = COMPRESSIBLE.has(ext) ? pickEncoding(req.headers['accept-encoding']) : null;

    if (req.method === 'HEAD') {
      headers['Content-Length'] = encoding ? 0 : st.size;
      res.writeHead(200, headers);
      res.end();
      return;
    }

    if (!encoding) {
      headers['Content-Length'] = st.size;
      res.writeHead(200, headers);
      fs.createReadStream(target).pipe(res);
      return;
    }

    // 压缩后长度未知，用 chunked 传输
    headers['Content-Encoding'] = encoding;
    res.writeHead(200, headers);
    const src = fs.createReadStream(target);
    const zip = encoding === 'br' ? zlib.createBrotliCompress({
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
    }) : encoding === 'gzip' ? zlib.createGzip({ level: 6 }) : zlib.createDeflate({ level: 6 });

    src.on('error', () => res.destroy());
    zip.on('error', () => res.destroy());
    src.pipe(zip).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log('发布目录     ' + ROOT);
  console.log('乐谱工作台   http://localhost:' + PORT + '/editor.html');
  console.log('乐器演奏台   http://localhost:' + PORT + '/');
  console.log('嵌入说明     http://localhost:' + PORT + '/embed.html');
  console.log('(已开启 gzip/br 压缩 + 分级缓存；Ctrl+C 停止)');
});
