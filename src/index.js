// GitHub 加速代理 - Cloudflare Worker
// 用法: git clone https://<your-worker>.workers.dev/github.com/user/repo.git

const ALLOWED_HOSTS = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'gist.github.com',
  'gist.githubusercontent.com',
  'objects.githubusercontent.com',
  'codeload.github.com',
  'github.githubassets.com',
]);

// 需要代理重定向（而非让客户端跳转）的路径模式
const CLONE_PATH_REGEX = /\.(git)(\/|$)/;

export default {
  async fetch(request, env) {
    // 处理 CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/^\/+/, '');

    // 首页
    if (!pathname) {
      return landingPage(url.origin);
    }

    // 诊断接口
    if (pathname === '_health') {
      return healthCheck(env);
    }

    // 测试接口: /_test/owner/repo 模拟 git clone 的首次请求
    if (pathname.startsWith('_test/')) {
      return testClone(pathname.substring(6), env);
    }

    // 解析目标地址: 第一段为主机名, 剩余为路径
    const slashIndex = pathname.indexOf('/');
    if (slashIndex === -1) {
      return errorResponse(400, '无效的 URL 格式，正确格式: /<host>/<path>');
    }

    const targetHost = pathname.substring(0, slashIndex);
    const targetPath = pathname.substring(slashIndex);

    if (!ALLOWED_HOSTS.has(targetHost)) {
      return errorResponse(403, `不允许代理的主机: ${targetHost}`);
    }

    const targetUrl = `https://${targetHost}${targetPath}${url.search}`;

    // 构建转发请求头
    const forwardHeaders = new Headers();
    for (const [key, value] of request.headers) {
      // 跳过 Cloudflare 内部头和 Host
      if (key.startsWith('cf-') || key === 'host' || key === 'x-forwarded-for') continue;
      forwardHeaders.set(key, value);
    }
    forwardHeaders.set('Host', targetHost);
    if (!forwardHeaders.has('User-Agent')) {
      forwardHeaders.set('User-Agent', 'git/2.39.0');
    }

    const fetchInit = {
      method: request.method,
      headers: forwardHeaders,
      redirect: 'manual',
    };

    // POST 请求转发 body
    if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
      fetchInit.body = request.body;
    }

    try {
      // 第一次：匿名请求（不带 Token）
      let response = await fetchWithRedirects(targetUrl, fetchInit, url.origin);

      // 如果返回 401 且配置了 Token，带上 Token 重试
      if (response.status === 401 && env.GITHUB_TOKEN) {
        const basicAuth = btoa(`x-access-token:${env.GITHUB_TOKEN}`);
        forwardHeaders.set('Authorization', `Basic ${basicAuth}`);
        const retryInit = {
          method: request.method,
          headers: forwardHeaders,
          redirect: 'manual',
        };
        if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
          retryInit.body = request.body;
        }
        response = await fetchWithRedirects(targetUrl, retryInit, url.origin);
      }

      // 构建返回头
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Expose-Headers', '*');
      responseHeaders.delete('WWW-Authenticate');

      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      });
    } catch (err) {
      return errorResponse(502, `代理请求失败: ${err.message}`);
    }
  },
};

/**
 * 手动跟随重定向，保留 Authorization 头
 */
async function fetchWithRedirects(url, init, workerOrigin, maxRedirects = 10) {
  let currentUrl = url;

  for (let i = 0; i < maxRedirects; i++) {
    const response = await fetch(currentUrl, { ...init, redirect: 'manual' });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('Location');
      if (!location) return response;

      const redirectUrl = new URL(location, currentUrl);

      // 如果重定向到允许的 GitHub 域名，继续代理（保留 Auth）
      if (ALLOWED_HOSTS.has(redirectUrl.host)) {
        init.headers.set('Host', redirectUrl.host);
        currentUrl = redirectUrl.href;
        continue;
      }

      // 重定向到外部域名，改写为通过代理中转返回给客户端
      const rewritten = `${workerOrigin}/${redirectUrl.host}${redirectUrl.pathname}${redirectUrl.search}`;
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set('Location', rewritten);
      return new Response(null, { status: response.status, headers: responseHeaders });
    }

    return response;
  }

  throw new Error('Too many redirects');
}

/**
 * 测试接口: 模拟 git clone 的首次请求，查看 GitHub 返回什么
 */
async function testClone(repoPath, env) {
  const testUrl = `https://github.com/${repoPath}.git/info/refs?service=git-upload-pack`;
  const headers = new Headers();
  headers.set('Host', 'github.com');
  headers.set('User-Agent', 'git/2.39.0');
  if (env.GITHUB_TOKEN) {
    const basicAuth = btoa(`x-access-token:${env.GITHUB_TOKEN}`);
    headers.set('Authorization', `Basic ${basicAuth}`);
  }

  // 第一次请求用 manual 看是否有重定向
  const resp = await fetch(testUrl, { headers, redirect: 'manual' });
  const respHeaders = Object.fromEntries(resp.headers);
  let bodyPreview = '';
  try {
    const text = await resp.text();
    bodyPreview = text.substring(0, 300);
  } catch {}

  return new Response(JSON.stringify({
    test_url: testUrl,
    has_auth: !!env.GITHUB_TOKEN,
    response_status: resp.status,
    response_headers: respHeaders,
    body_preview: bodyPreview,
  }, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function healthCheck(env) {
  const hasToken = !!(env && env.GITHUB_TOKEN);
  const tokenPreview = hasToken ? env.GITHUB_TOKEN.substring(0, 8) + '...' : 'NOT SET';
  let githubStatus = 'untested';
  let githubUser = '';

  if (hasToken) {
    try {
      const resp = await fetch('https://api.github.com/user', {
        headers: {
          'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
          'User-Agent': 'github-proxy-worker',
        },
      });
      if (resp.status === 200) {
        const data = await resp.json();
        githubUser = data.login;
        githubStatus = `valid (user: ${data.login})`;
      } else {
        githubStatus = `failed (HTTP ${resp.status})`;
      }
    } catch (err) {
      githubStatus = `error: ${err.message}`;
    }
  }

  return new Response(JSON.stringify({
    token_configured: hasToken,
    token_preview: tokenPreview,
    github_api_check: githubStatus,
  }, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function errorResponse(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function landingPage(origin) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GitHub 加速代理 // 终端</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0a;
      color: #00ff41;
      font-family: 'Cascadia Code', 'Fira Code', 'Courier New', monospace;
      min-height: 100vh;
      position: relative;
      overflow-x: hidden;
    }

    /* 扫描线 */
    body::after {
      content: '';
      position: fixed; top: 0; left: 0;
      width: 100%; height: 100%;
      background: repeating-linear-gradient(
        0deg,
        transparent, transparent 2px,
        rgba(0,255,65,0.015) 2px, rgba(0,255,65,0.015) 4px
      );
      pointer-events: none; z-index: 999;
    }

    .terminal {
      max-width: 820px;
      margin: 0 auto;
      padding: 1rem;
    }

    /* 终端标题栏 */
    .titlebar {
      background: #1a1a1a;
      border: 1px solid #333;
      border-bottom: none;
      padding: 0.5rem 1rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      border-radius: 8px 8px 0 0;
      margin-top: 1.5rem;
    }
    .dot { width: 12px; height: 12px; border-radius: 50%; }
    .dot.r { background: #ff5f57; }
    .dot.y { background: #ffbd2e; }
    .dot.g { background: #28c840; }
    .titlebar span {
      flex: 1; text-align: center;
      color: #666; font-size: 0.8rem;
    }

    /* 终端主体 */
    .screen {
      background: #0d0d0d;
      border: 1px solid #333;
      border-radius: 0 0 8px 8px;
      padding: 1.5rem;
      box-shadow: 0 0 40px rgba(0,255,65,0.05), inset 0 0 80px rgba(0,0,0,0.5);
    }

    /* ASCII 标题 */
    .ascii-title {
      color: #00ff41;
      font-size: clamp(0.45rem, 1.5vw, 0.75rem);
      line-height: 1.2;
      white-space: pre;
      text-align: center;
      margin-bottom: 0.5rem;
      text-shadow: 0 0 10px rgba(0,255,65,0.5);
    }
    .sys-info {
      text-align: center;
      color: #555;
      font-size: 0.75rem;
      margin-bottom: 1.5rem;
      border-bottom: 1px dashed #222;
      padding-bottom: 1rem;
    }

    /* 区块 */
    .block { margin-bottom: 1.5rem; }
    .prompt {
      color: #00ff41;
      margin-bottom: 0.6rem;
      font-size: 0.85rem;
    }
    .prompt .path { color: #00aaff; }
    .prompt .sym { color: #00ff41; }

    /* 输入框 */
    .input-row {
      display: flex;
      align-items: center;
      gap: 0;
      margin-bottom: 0.3rem;
    }
    .input-prefix {
      color: #00ff41;
      padding: 0.6rem 0;
      font-size: 0.85rem;
      white-space: nowrap;
    }
    .input-row input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: #fff;
      font-family: inherit;
      font-size: 0.85rem;
      padding: 0.6rem 0.4rem;
      caret-color: #00ff41;
    }
    .input-row input::placeholder { color: #333; }
    .input-row button {
      background: #00ff41;
      color: #0a0a0a;
      border: none;
      padding: 0.6rem 1.2rem;
      font-family: inherit;
      font-size: 0.8rem;
      font-weight: bold;
      cursor: pointer;
      letter-spacing: 1px;
    }
    .input-row button:hover { background: #33ff66; }

    #output {
      display: none;
      color: #ffb800;
      font-size: 0.85rem;
      padding: 0.4rem 0;
      word-break: break-all;
    }
    #toast {
      display: none;
      color: #555;
      font-size: 0.75rem;
    }

    /* 代码区域 */
    .code {
      background: #0a0a0a;
      border: 1px solid #1a1a1a;
      padding: 1rem;
      overflow-x: auto;
      font-size: 0.8rem;
      line-height: 1.9;
    }
    .c { color: #444; }        /* comment */
    .g { color: #00ff41; }     /* green */
    .b { color: #00aaff; }     /* blue */
    .w { color: #ccc; }        /* white */
    .y { color: #ffb800; }     /* yellow */

    /* 域名列表 */
    .hosts {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 2px;
    }
    .hosts div {
      padding: 0.35rem 0;
      font-size: 0.8rem;
      color: #00ff41;
    }
    .hosts div::before {
      content: '[+] ';
      color: #555;
    }

    .tip {
      margin-top: 0.8rem;
      color: #555;
      font-size: 0.8rem;
    }
    .tip em {
      font-style: normal;
      color: #ffb800;
    }

    /* 光标闪烁 */
    @keyframes blink {
      0%, 50% { opacity: 1; }
      51%, 100% { opacity: 0; }
    }
    .cursor {
      display: inline-block;
      width: 8px; height: 15px;
      background: #00ff41;
      vertical-align: middle;
      animation: blink 1s step-end infinite;
      margin-left: 2px;
    }

    .sep {
      border: none;
      border-top: 1px dashed #1a1a1a;
      margin: 1rem 0;
    }

    .footer {
      text-align: center;
      color: #222;
      font-size: 0.7rem;
      padding: 1rem;
      letter-spacing: 1px;
    }
  </style>
</head>
<body>
  <div class="terminal">
    <div class="titlebar">
      <div class="dot r"></div>
      <div class="dot y"></div>
      <div class="dot g"></div>
      <span>github-proxy@cloudflare ~ </span>
    </div>
    <div class="screen">

      <pre class="ascii-title">
  _____ _ _   _   _       _        _____
 / ____(_) | | | | |     | |      |  __ \\
| |  __ _| |_| |_| |_   _| |__    | |__) | __ _____  ___   _
| | |_ | | __|  _  | | | | '_ \\   |  ___/ '__/ _ \\ \\/ / | | |
| |__| | | |_| | | | |_| | |_) |  | |   | | | (_) >  <| |_| |
 \\_____|_|\\__|_| |_|\\__,_|_.__/   |_|   |_|  \\___/_/\\_\\\\__, |
                                                        __/ |
                                                       |___/</pre>
      <div class="sys-info">[ GitHub 克隆加速器 // Cloudflare Worker // v1.0 ]</div>

      <!-- 转换 -->
      <div class="block">
        <div class="prompt"><span class="path">~/proxy</span> <span class="sym">$</span> convert &lt;粘贴 GitHub 链接&gt;</div>
        <div class="input-row">
          <span class="input-prefix">&gt;&nbsp;</span>
          <input type="text" id="url-input" placeholder="https://github.com/user/repo.git" />
          <button onclick="convert()">执行</button>
        </div>
        <div id="output"></div>
        <div id="toast">[剪贴板] 已复制</div>
      </div>

      <hr class="sep">

      <!-- 用法 -->
      <div class="block">
        <div class="prompt"><span class="path">~/proxy</span> <span class="sym">$</span> cat 使用说明.txt</div>
        <pre class="code"><span class="c"># 克隆仓库</span>
<span class="g">$</span> <span class="b">git clone</span> <span class="y">${origin}/github.com/user/repo.git</span>

<span class="c"># 下载 Release</span>
<span class="g">$</span> <span class="b">wget</span> <span class="y">${origin}/github.com/user/repo/releases/download/v1.0/file.zip</span>

<span class="c"># 下载 Raw 文件</span>
<span class="g">$</span> <span class="b">wget</span> <span class="y">${origin}/raw.githubusercontent.com/user/repo/main/README.md</span>

<span class="c"># 下载源码压缩包</span>
<span class="g">$</span> <span class="b">wget</span> <span class="y">${origin}/codeload.github.com/user/repo/zip/refs/heads/main</span></pre>
        <p class="tip">用法：将 <em>https://</em> 替换为 <em>${origin}/</em> 即可</p>
      </div>

      <hr class="sep">

      <!-- 域名 -->
      <div class="block">
        <div class="prompt"><span class="path">~/proxy</span> <span class="sym">$</span> cat /etc/允许代理的域名</div>
        <div class="hosts">
          <div>github.com</div>
          <div>raw.githubusercontent.com</div>
          <div>gist.github.com</div>
          <div>gist.githubusercontent.com</div>
          <div>objects.githubusercontent.com</div>
          <div>codeload.github.com</div>
          <div>github.githubassets.com</div>
        </div>
      </div>

      <hr class="sep">
      <div class="prompt"><span class="path">~/proxy</span> <span class="sym">$</span> <span class="cursor"></span></div>

    </div>
  </div>
  <div class="footer">安全连接 // CLOUDFLARE 边缘网络</div>

  <script>
    function convert() {
      const input = document.getElementById('url-input').value.trim();
      const output = document.getElementById('output');
      const toast = document.getElementById('toast');
      if (!input) return;
      try {
        const url = new URL(input);
        const proxied = '${origin}/' + url.host + url.pathname + url.search;
        output.textContent = proxied;
        output.style.display = 'block';
        navigator.clipboard?.writeText(proxied).then(() => {
          toast.style.display = 'block';
          setTimeout(() => toast.style.display = 'none', 2000);
        });
      } catch {
        output.textContent = '[错误] 无效的 URL';
        output.style.display = 'block';
        toast.style.display = 'none';
      }
    }
    document.getElementById('url-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') convert();
    });
  </script>
</body>
</html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
