const express = require('express');
const { chromium } = require('playwright');
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const LINKS_FILE = path.join(__dirname, 'links.json');

// 결과 저장소
let results = {};
let sseClients = [];
let browser = null;
let isChecking = false;
let pendingCheck = false;

app.use(express.static('public'));
app.use(express.json());

// SSE 엔드포인트 - 실시간 업데이트
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.push(res);

  // 현재 결과 즉시 전송
  sendToClient(res, { type: 'init', results });

  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

// 현재 결과 조회 API
app.get('/api/results', (req, res) => {
  res.json(results);
});

// 수동 재확인 API
app.post('/api/recheck', async (req, res) => {
  res.json({ message: '재확인 시작' });
  await processLinks();
});

// 특정 URL만 재확인
app.post('/api/recheck/:url', async (req, res) => {
  const url = decodeURIComponent(req.params.url);
  res.json({ message: `${url} 재확인 시작` });
  await testUrl(url);
});

function sendToClient(client, data) {
  client.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(data) {
  sseClients.forEach(client => sendToClient(client, data));
}

// URL 단일 테스트
async function testUrl(url) {
  const startTime = Date.now();

  results[url] = {
    status: 'checking',
    url,
    statusCode: null,
    title: null,
    loadTime: null,
    error: null,
    timestamp: new Date().toISOString(),
  };
  broadcast({ type: 'update', url, data: results[url] });

  let page = null;
  try {
    page = await browser.newPage();

    // 불필요한 리소스 차단으로 속도 향상
    await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,ico}', route => route.abort());

    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    const statusCode = response ? response.status() : null;
    const title = await page.title().catch(() => '(제목 없음)');
    const loadTime = Date.now() - startTime;
    const isSuccess = statusCode !== null && statusCode >= 200 && statusCode < 400;

    results[url] = {
      status: isSuccess ? 'success' : 'error',
      url,
      statusCode,
      title: title || '(제목 없음)',
      loadTime,
      error: null,
      timestamp: new Date().toISOString(),
    };

    console.log(`[${isSuccess ? 'OK' : 'FAIL'}] ${url} — ${statusCode} (${loadTime}ms)`);
  } catch (err) {
    const loadTime = Date.now() - startTime;
    results[url] = {
      status: 'error',
      url,
      statusCode: null,
      title: null,
      loadTime,
      error: err.message,
      timestamp: new Date().toISOString(),
    };
    console.log(`[ERR] ${url} — ${err.message}`);
  } finally {
    if (page) await page.close().catch(() => {});
  }

  broadcast({ type: 'update', url, data: results[url] });
}

// links.json 읽어서 모든 URL 테스트
async function processLinks() {
  if (isChecking) {
    pendingCheck = true;
    return;
  }
  isChecking = true;

  try {
    const content = fs.readFileSync(LINKS_FILE, 'utf8');
    let links;

    try {
      links = JSON.parse(content);
    } catch {
      console.error('links.json 파싱 오류: 유효한 JSON 배열이어야 합니다.');
      broadcast({ type: 'error', message: 'links.json 파싱 오류: 유효한 JSON 배열이어야 합니다.' });
      return;
    }

    if (!Array.isArray(links)) {
      console.error('links.json은 배열 형식이어야 합니다.');
      return;
    }

    const validLinks = links.filter(u => typeof u === 'string' && u.trim());

    if (validLinks.length === 0) {
      console.log('링크가 없습니다.');
      broadcast({ type: 'status', message: 'links.json에 링크가 없습니다.' });
      return;
    }

    console.log(`\n===== 링크 확인 시작: ${validLinks.length}개 =====`);
    broadcast({ type: 'status', message: `${validLinks.length}개 링크 확인 중...` });

    for (const url of validLinks) {
      await testUrl(url.trim());
    }

    const successCount = validLinks.filter(u => results[u]?.status === 'success').length;
    const errorCount = validLinks.filter(u => results[u]?.status === 'error').length;

    console.log(`===== 완료: 성공 ${successCount}개, 실패 ${errorCount}개 =====\n`);
    broadcast({
      type: 'done',
      message: `확인 완료 — 성공: ${successCount}개, 실패: ${errorCount}개`,
      successCount,
      errorCount,
    });
  } catch (err) {
    console.error('processLinks 오류:', err.message);
  } finally {
    isChecking = false;
    if (pendingCheck) {
      pendingCheck = false;
      await processLinks();
    }
  }
}

async function main() {
  // links.json 없으면 샘플로 생성
  if (!fs.existsSync(LINKS_FILE)) {
    fs.writeFileSync(
      LINKS_FILE,
      JSON.stringify(['https://example.com', 'https://google.com'], null, 2),
      'utf8'
    );
    console.log('links.json 샘플 파일 생성됨');
  }

  // Playwright 브라우저 실행
  console.log('브라우저 실행 중...');
  browser = await chromium.launch({ headless: true });
  console.log('브라우저 준비 완료');

  // 서버 시작
  app.listen(PORT, () => {
    console.log(`\n✅ 서버 실행 중: http://localhost:${PORT}`);
    console.log(`📄 links.json 파일을 수정하면 자동으로 링크를 확인합니다.\n`);
  });

  // 초기 링크 확인
  await processLinks();

  // links.json 파일 변경 감시
  const watcher = chokidar.watch(LINKS_FILE, {
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  watcher.on('change', () => {
    console.log('links.json 변경 감지 — 재확인 시작');
    broadcast({ type: 'status', message: 'links.json 변경 감지, 재확인 중...' });
    processLinks();
  });

  // 종료 처리
  process.on('SIGINT', async () => {
    console.log('\n종료 중...');
    if (browser) await browser.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('시작 오류:', err);
  process.exit(1);
});
