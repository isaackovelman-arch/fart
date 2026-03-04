const http = require('http');
const https = require('https');
const url = require('url');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;

// ── Encode / Decode ────────────────────────────────────────────────────────

function encodeTarget(target) {
  return Buffer.from(target).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

function decodeTarget(encoded) {
  try {
    // restore base64 padding and standard chars
    let b64 = encoded.replace(/-/g,'+').replace(/_/g,'/');
    while (b64.length % 4) b64 += '=';
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function resolveUrl(base, relative) {
  try { return new url.URL(relative, base).href; } catch { return null; }
}

// ── HTML / CSS rewriting ───────────────────────────────────────────────────

function rewriteHtml(html, baseUrl) {
  return html
    .replace(/\b(href|src|action)=(["'])(.*?)\2/gi, (match, attr, q, val) => {
      if (!val || val.startsWith('data:') || val.startsWith('javascript:') || val.startsWith('#') || val.startsWith('mailto:')) return match;
      const abs = resolveUrl(baseUrl, val);
      if (!abs) return match;
      return `${attr}=${q}/proxy/${encodeTarget(abs)}${q}`;
    })
    .replace(/\bsrcset=(["'])(.*?)\1/gi, (match, q, srcset) => {
      const rewritten = srcset.replace(/([^\s,]+)(\s*(?:\d+(?:\.\d+)?[wx])?)/g, (m, u, d) => {
        if (!u || u.startsWith('data:')) return m;
        const abs = resolveUrl(baseUrl, u);
        return abs ? `/proxy/${encodeTarget(abs)}${d}` : m;
      });
      return `srcset=${q}${rewritten}${q}`;
    })
    .replace(/url\((["']?)(.*?)\1\)/gi, (match, q, val) => {
      if (!val || val.startsWith('data:')) return match;
      const abs = resolveUrl(baseUrl, val);
      return abs ? `url(${q}/proxy/${encodeTarget(abs)}${q})` : match;
    })
    .replace(/<head([^>]*)>/i, `<head$1>
    <base href="${baseUrl}">
    <script>
    (function() {
      function enc(u) {
        try {
          var b = btoa(unescape(encodeURIComponent(u))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'');
          return '/proxy/' + b;
        } catch(e) { return u; }
      }
      function abs(u) {
        try { return new URL(u, '${baseUrl}').href; } catch(e) { return u; }
      }
      // intercept XHR
      var _open = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(m, u) {
        try { arguments[1] = enc(abs(u)); } catch(e) {}
        return _open.apply(this, arguments);
      };
      // intercept fetch
      var _fetch = window.fetch;
      window.fetch = function(input, init) {
        try {
          var u = typeof input === 'string' ? input : input.url;
          var encoded = enc(abs(u));
          input = typeof input === 'string' ? encoded : new Request(encoded, input);
        } catch(e) {}
        return _fetch(input, init);
      };
      // intercept link clicks for navigation
      document.addEventListener('click', function(e) {
        var el = e.target.closest('a');
        if (!el || !el.href) return;
        var href = el.getAttribute('href');
        if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return;
        e.preventDefault();
        var absUrl = abs(el.href);
        window.location.href = enc(absUrl);
      }, true);
      // intercept form submissions
      document.addEventListener('submit', function(e) {
        var form = e.target;
        var action = abs(form.action || '${baseUrl}');
        e.preventDefault();
        var data = new FormData(form);
        if (form.method && form.method.toUpperCase() === 'POST') {
          fetch(enc(action), { method: 'POST', body: data });
        } else {
          var params = new URLSearchParams(data).toString();
          window.location.href = enc(action + (params ? '?' + params : ''));
        }
      }, true);
    })();
    <\/script>`);
}

function rewriteCss(css, baseUrl) {
  return css.replace(/url\((["']?)(.*?)\1\)/gi, (match, q, val) => {
    if (!val || val.startsWith('data:')) return match;
    const abs = resolveUrl(baseUrl, val);
    return abs ? `url(${q}/proxy/${encodeTarget(abs)}${q})` : match;
  });
}

// ── Fetch remote ───────────────────────────────────────────────────────────

function fetchRemote(targetUrl, reqHeaders, callback, redirectCount = 0) {
  if (redirectCount > 8) return callback({ status: 508, body: 'Too many redirects' });

  let parsedUrl;
  try { parsedUrl = new url.URL(targetUrl); }
  catch (e) { return callback({ status: 400, body: 'Invalid URL: ' + targetUrl }); }

  const proto = parsedUrl.protocol === 'https:' ? https : http;
  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
    path: parsedUrl.pathname + (parsedUrl.search || ''),
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    },
    timeout: 20000,
  };

  let done = false;
  function once(err, result) {
    if (done) return;
    done = true;
    callback(err, result);
  }

  const req = proto.request(options, (res) => {
    if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
      const redirectUrl = resolveUrl(targetUrl, res.headers.location);
      res.resume();
      if (redirectUrl) return fetchRemote(redirectUrl, reqHeaders, callback, redirectCount + 1);
      return once({ status: 502, body: 'Bad redirect' });
    }

    const chunks = [];
    const encoding = res.headers['content-encoding'];
    let stream = res;
    try {
      if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
    } catch(e) { stream = res; }

    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => once(null, {
      status: res.statusCode,
      headers: res.headers,
      body: Buffer.concat(chunks),
      finalUrl: targetUrl,
    }));
    stream.on('error', e => once({ status: 502, body: 'Stream error: ' + e.message }));
  });

  req.on('timeout', () => { req.destroy(); once({ status: 504, body: 'Timed out' }); });
  req.on('error', e => once({ status: 502, body: 'Fetch error: ' + e.message }));
  req.end();
}

// ── Static file helper ─────────────────────────────────────────────────────

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// ── Server ─────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  const pathname = parsed.pathname;

  if (pathname === '/' || pathname === '/index.html') {
    return serveFile(res, path.join(__dirname, 'public', 'index.html'), 'text/html; charset=utf-8');
  }

  if (pathname === '/sw.js') {
    return serveFile(res, path.join(__dirname, 'public', 'sw.js'), 'application/javascript');
  }

  if (pathname.startsWith('/proxy/')) {
    const encoded = pathname.slice('/proxy/'.length);
    const targetUrl = decodeTarget(encoded);

    if (!targetUrl || !targetUrl.startsWith('http')) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Bad proxy target: ' + encoded);
    }

    fetchRemote(targetUrl, req.headers, (err, result) => {
      if (err) {
        res.writeHead(err.status || 502, { 'Content-Type': 'text/html' });
        return res.end(`<!DOCTYPE html><html><body style="font-family:monospace;padding:40px;background:#0e0f11;color:#ff6b6b">
          <h2>⚠ Proxy Error</h2><p>${err.body}</p>
          <p>Target: ${targetUrl}</p>
          <p><a href="/" style="color:#6c8fff">← Back home</a></p>
        </body></html>`);
      }

      const contentType = result.headers['content-type'] || '';
      const isHtml = contentType.includes('text/html');
      const isCss = contentType.includes('text/css');

      const safeHeaders = { 'content-type': contentType };
      ['cache-control', 'vary', 'last-modified', 'etag'].forEach(h => {
        if (result.headers[h]) safeHeaders[h] = result.headers[h];
      });

      res.writeHead(result.status, safeHeaders);

      if (isHtml) return res.end(rewriteHtml(result.body.toString('utf8'), targetUrl));
      if (isCss) return res.end(rewriteCss(result.body.toString('utf8'), targetUrl));
      res.end(result.body);
    });

    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n🔮 ProxyVault running at http://localhost:${PORT}\n`);
});
