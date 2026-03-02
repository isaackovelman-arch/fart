const http = require('http');
const https = require('https');
const url = require('url');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;

// ── Helpers ────────────────────────────────────────────────────────────────

function encodeTarget(target) {
  return Buffer.from(target).toString('base64url');
}

function decodeTarget(encoded) {
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function resolveUrl(base, relative) {
  try {
    return new url.URL(relative, base).href;
  } catch {
    return null;
  }
}

function rewriteHtml(html, baseUrl) {
  // Rewrite all href, src, action, srcset attributes through our proxy
  return html
    // href="..." (links, stylesheets)
    .replace(/\b(href|src|action)=(["'])(.*?)\2/gi, (match, attr, q, val) => {
      if (!val || val.startsWith('data:') || val.startsWith('javascript:') || val.startsWith('#') || val.startsWith('mailto:')) {
        return match;
      }
      const abs = resolveUrl(baseUrl, val);
      if (!abs) return match;
      return `${attr}=${q}/proxy/${encodeTarget(abs)}${q}`;
    })
    // srcset="url 2x, url2 3x"
    .replace(/\bsrcset=(["'])(.*?)\1/gi, (match, q, srcset) => {
      const rewritten = srcset.replace(/([^\s,]+)(\s*(?:\d+(?:\.\d+)?[wx])?)/g, (m, u, d) => {
        if (!u || u.startsWith('data:')) return m;
        const abs = resolveUrl(baseUrl, u);
        return abs ? `/proxy/${encodeTarget(abs)}${d}` : m;
      });
      return `srcset=${q}${rewritten}${q}`;
    })
    // Rewrite inline style url()
    .replace(/url\((["']?)(.*?)\1\)/gi, (match, q, val) => {
      if (!val || val.startsWith('data:')) return match;
      const abs = resolveUrl(baseUrl, val);
      return abs ? `url(${q}/proxy/${encodeTarget(abs)}${q})` : match;
    })
    // Inject base-rewrite script for dynamic navigation
    .replace(/<head([^>]*)>/i, `<head$1>
    <script>
      (function() {
        var _open = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(m, u) {
          try {
            var abs = new URL(u, '${baseUrl}').href;
            arguments[1] = '/proxy/' + btoa(abs).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'');
          } catch(e) {}
          return _open.apply(this, arguments);
        };
        var _fetch = window.fetch;
        window.fetch = function(input, init) {
          try {
            var u = typeof input === 'string' ? input : input.url;
            var abs = new URL(u, '${baseUrl}').href;
            var enc = btoa(abs).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'');
            input = typeof input === 'string' ? '/proxy/' + enc : new Request('/proxy/' + enc, input);
          } catch(e) {}
          return _fetch(input, init);
        };
      })();
    </script>`);
}

function rewriteCss(css, baseUrl) {
  return css.replace(/url\((["']?)(.*?)\1\)/gi, (match, q, val) => {
    if (!val || val.startsWith('data:')) return match;
    const abs = resolveUrl(baseUrl, val);
    return abs ? `url(${q}/proxy/${encodeTarget(abs)}${q})` : match;
  });
}

// ── Proxy fetch ────────────────────────────────────────────────────────────

function fetchRemote(targetUrl, reqHeaders, callback, redirectCount = 0) {
  if (redirectCount > 5) return callback({ status: 508, body: 'Too many redirects' });

  let parsedUrl;
  try {
    parsedUrl = new url.URL(targetUrl);
  } catch (e) {
    return callback({ status: 400, body: 'Invalid URL: ' + targetUrl });
  }

  const proto = parsedUrl.protocol === 'https:' ? https : http;
  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
    path: parsedUrl.pathname + (parsedUrl.search || ''),
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': reqHeaders.accept || 'text/html,application/xhtml+xml,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
    },
    timeout: 15000,
  };

  let done = false;
  function once(err, result) {
    if (done) return;
    done = true;
    callback(err, result);
  }

  const req = proto.request(options, (res) => {
    // Handle redirects
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      const redirectUrl = resolveUrl(targetUrl, res.headers.location);
      res.resume(); // drain the response
      if (redirectUrl) return fetchRemote(redirectUrl, reqHeaders, callback, redirectCount + 1);
      return once({ status: 502, body: 'Bad redirect location' });
    }

    const chunks = [];
    const encoding = res.headers['content-encoding'];

    let stream = res;
    try {
      if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
    } catch (e) {
      stream = res;
    }

    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      once(null, {
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
        finalUrl: targetUrl,
      });
    });
    stream.on('error', (e) => once({ status: 502, body: 'Stream error: ' + e.message }));
  });

  req.on('timeout', () => { req.destroy(); once({ status: 504, body: 'Request timed out' }); });
  req.on('error', (e) => once({ status: 502, body: 'Fetch error: ' + e.message }));
  req.end();
}

// ── Request handler ────────────────────────────────────────────────────────

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  const pathname = parsed.pathname;

  // ── Static routes ──────────────────────────────────────────────────────
  if (pathname === '/' || pathname === '/index.html') {
    return serveFile(res, path.join(__dirname, 'public', 'index.html'), 'text/html; charset=utf-8');
  }

  // ── Proxy route: /proxy/<base64url-encoded-target-url> ─────────────────
  if (pathname.startsWith('/proxy/')) {
    const encoded = pathname.slice('/proxy/'.length);
    const targetUrl = decodeTarget(encoded);

    if (!targetUrl || !targetUrl.startsWith('http')) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Bad proxy target');
    }

    fetchRemote(targetUrl, req.headers, (err, result) => {
      if (err) {
        res.writeHead(err.status || 502, { 'Content-Type': 'text/html' });
        return res.end(`<!DOCTYPE html><html><body style="font-family:monospace;padding:40px;background:#0d0d0d;color:#ff4466">
          <h2>⚠ Proxy Error</h2><p>${err.body}</p>
          <p><a href="/" style="color:#00e5ff">← Back to ProxyVault</a></p></body></html>`);
      }

      const contentType = result.headers['content-type'] || '';
      const isHtml = contentType.includes('text/html');
      const isCss  = contentType.includes('text/css');

      // Strip security headers that block embedding / rewriting
      const safeHeaders = { 'content-type': contentType };
      ['cache-control', 'vary'].forEach(h => {
        if (result.headers[h]) safeHeaders[h] = result.headers[h];
      });

      // Never send these through — they would break the proxy
      // (x-frame-options, content-security-policy, etc. are intentionally excluded)

      res.writeHead(result.status, safeHeaders);

      if (isHtml) {
        const html = result.body.toString('utf8');
        return res.end(rewriteHtml(html, targetUrl));
      }

      if (isCss) {
        const css = result.body.toString('utf8');
        return res.end(rewriteCss(css, targetUrl));
      }

      // Binary / other — pass through as-is
      res.end(result.body);
    });

    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n🔮 ProxyVault server running at http://localhost:${PORT}\n`);
});
