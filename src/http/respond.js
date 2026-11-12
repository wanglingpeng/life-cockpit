'use strict';
/* 统一响应层：gzip + ETag + 条件请求(304) + JSON 封装 + 请求体读取。
 *
 * 从 server.js 抽出，行为零变化。抽出的动机不是"文件太大"，而是这层是
 * 全部 198 个路由的共同底座——它必须能被任何模块 import，而不依赖 server.js
 * 的初始化顺序。
 *
 * 起因（历史注释保留）：全站零压缩且静态资源无 ETag/Last-Modified、
 * Cache-Control 又是 no-cache，浏览器无法协商缓存，单页传输 ≈ 500KB。 */

const crypto = require('node:crypto');
const zlib = require('node:zlib');

const GZIP_MIN_BYTES = 1024;

function wantsGzip(req) {
  return !!req && /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
}

/* 静态文件压缩结果缓存：避免每次请求同步 gzip 一遍 150KB 的 theme/ 分片。
   key 含 mtime+size，文件一改自动失效；条目很少（~30），加上限兜底。 */
const assetCache = new Map();

function sendBuffer(req, res, buf, opts) {
  opts = opts || {};
  const mime = opts.mime || 'application/octet-stream';
  const cc = opts.cacheControl || 'no-cache';
  let etag = opts.etag, gz = opts.gz;
  if (!etag) {
    const key = (opts.file || '') + '|' + (opts.mtime || 0) + '|' + buf.length;
    const hit = opts.file ? assetCache.get(key) : null;
    if (hit) { etag = hit.etag; gz = hit.gz; }
    else {
      etag = '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20) + '"';
      if (buf.length >= GZIP_MIN_BYTES) { try { gz = zlib.gzipSync(buf, { level: 6 }); } catch (e) { gz = null; } }
      if (opts.file) { if (assetCache.size >= 160) assetCache.clear(); assetCache.set(key, { etag, gz }); }
    }
  }
  const inm = String((req && req.headers['if-none-match']) || '');
  if (inm && inm.split(',').some(t => t.trim() === etag)) {
    res.writeHead(304, { 'ETag': etag, 'Cache-Control': cc });
    res.end();
    return;
  }
  const headers = { 'Content-Type': mime, 'ETag': etag, 'Cache-Control': cc };
  if (opts.lastModified) headers['Last-Modified'] = opts.lastModified;
  let out = buf;
  if (gz && wantsGzip(req)) {
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    out = gz;
  }
  headers['Content-Length'] = out.length;
  res.writeHead(200, headers);
  res.end(out);
}

function sendJson(res, obj, status, extraHeaders) {
  const body = JSON.stringify(obj);
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  const req = res.req;              // Node ≥15.7 提供的反向引用
  let out = body;
  if (body.length >= GZIP_MIN_BYTES && wantsGzip(req)) {
    try {
      out = zlib.gzipSync(body, { level: 6 });
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
    } catch (e) { out = body; }
  }
  headers['Content-Length'] = Buffer.byteLength(out);
  res.writeHead(status || 200, headers);
  res.end(out);
}

function ok(res, data, msg, extraHeaders) { sendJson(res, { code: 200, message: msg || 'ok', data: data }, 200, extraHeaders); }
function fail(res, msg, code) { sendJson(res, { code: code || 400, message: msg, data: null }, code || 400); }

/* 请求体上限：防超大 body 把进程内存打满。
   图片上传走 base64（前端已压缩，解码后上限 6MB → base64 ≈ 8.2MB），取 12MB 留余量。
   超限时继续把数据读干（丢弃）再回 413，而不是直接 destroy socket——
   否则客户端会看到连接被重置而不是一条明确的错误提示。 */
const MAX_BODY_BYTES = 12 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    req.on('data', c => {
      if (settled) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) { tooLarge = true; chunks = []; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) {
        const err = new Error('请求体过大');
        err.isPayloadTooLarge = true;
        return done(reject, err);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return done(resolve, {});
      try {
        const parsed = JSON.parse(raw);
        done(resolve, parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch (e) { done(resolve, {}); }
    });
    req.on('error', () => done(resolve, {}));
  });
}

module.exports = {
  GZIP_MIN_BYTES, MAX_BODY_BYTES, wantsGzip, sendBuffer, sendJson, ok, fail, readBody, assetCache
};
