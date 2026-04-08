const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1';
const PORT = Number(process.env.BOUNDLESS_APP_PORT || 3000);
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const HISTORY_LIMIT = 20;
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders()
  });
  res.end(JSON.stringify(payload));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

function sendNoContent(res) {
  res.writeHead(204, corsHeaders());
  res.end();
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function ensureHistoryStore() {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.promises.access(HISTORY_FILE);
  } catch {
    await fs.promises.writeFile(HISTORY_FILE, '[]', 'utf8');
  }
}

async function readHistory() {
  await ensureHistoryStore();
  const raw = await fs.promises.readFile(HISTORY_FILE, 'utf8');
  const data = JSON.parse(raw);
  return Array.isArray(data) ? data : [];
}

async function writeHistory(items) {
  await ensureHistoryStore();
  await fs.promises.writeFile(HISTORY_FILE, JSON.stringify(items, null, 2), 'utf8');
}

function normalizeHistoryEntry(payload) {
  const problem = typeof payload.problem === 'string' ? payload.problem.trim() : '';
  const answers = Array.isArray(payload.answers) ? payload.answers.map(item => String(item ?? '').trim()) : [];
  const analysisResult = payload.analysisResult && typeof payload.analysisResult === 'object'
    ? payload.analysisResult
    : null;

  if (!problem || answers.length !== 5 || answers.some(item => !item) || !analysisResult) {
    return null;
  }

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    problem,
    answers,
    analysisResult
  };
}

async function analyzeWithDeepSeek(problem, answers) {
  if (!DEEPSEEK_API_KEY) {
    throw new Error('DeepSeek API key not configured');
  }

  const whysChain = answers.map((answer, index) => `Why ${index + 1}: ${answer}`).join('\n');

  const prompt = `作为一位资深问题分析专家，请基于以下"5个为什么"分析，识别根本原因并提供解决方案。

初始问题: ${problem}

${whysChain}

请用JSON格式返回以下结构:
{
  "rootCause": "识别出的根本原因（简洁明确）",
  "analysis": "详细的分析说明",
  "solutions": [
    {
      "title": "解决方案标题",
      "description": "详细说明",
      "priority": "high/medium/low"
    }
  ],
  "prevention": "如何预防此类问题再次发生的建议"
}

只返回JSON，不要其他文字。`;

  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: '你是一个专业的问题分析和解决方案专家。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 2000
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`DeepSeek API error: ${error}`);
  }

  const data = await response.json();
  const content = data.choices[0]?.message?.content;

  if (!content) {
    throw new Error('Empty response from DeepSeek API');
  }

  // Extract JSON from response
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Invalid response format from DeepSeek API');
  }

  return JSON.parse(jsonMatch[0]);
}

function serveIndexHtml(res) {
  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, 'utf8', (err, content) => {
    if (err) {
      sendError(res, 500, 'Failed to load index.html');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      ...corsHeaders()
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.method) {
    sendError(res, 400, 'Invalid request');
    return;
  }

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    sendNoContent(res);
    return;
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  // Health check
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      service: 'five-whys',
      port: PORT,
      deepseekConfigured: !!DEEPSEEK_API_KEY
    });
    return;
  }

  // Serve index.html
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    serveIndexHtml(res);
    return;
  }

  // History list
  if (req.method === 'GET' && url.pathname === '/api/history') {
    try {
      const items = await readHistory();
      sendJson(res, 200, { items });
    } catch (error) {
      console.error('[five-whys] History read error:', error);
      sendError(res, 500, 'Failed to read history');
    }
    return;
  }

  // Add history item
  if (req.method === 'POST' && url.pathname === '/api/history') {
    try {
      const payload = await parseJsonBody(req);
      const entry = normalizeHistoryEntry(payload);

      if (!entry) {
        sendError(res, 400, 'Invalid request: problem, 5 answers, and analysisResult required');
        return;
      }

      const current = await readHistory();
      const next = [entry, ...current].slice(0, HISTORY_LIMIT);
      await writeHistory(next);
      sendJson(res, 201, entry);
    } catch (error) {
      console.error('[five-whys] History write error:', error);
      sendError(res, 500, error.message || 'Failed to write history');
    }
    return;
  }

  // Clear history
  if (req.method === 'DELETE' && url.pathname === '/api/history') {
    try {
      await writeHistory([]);
      sendNoContent(res);
    } catch (error) {
      console.error('[five-whys] History clear error:', error);
      sendError(res, 500, 'Failed to clear history');
    }
    return;
  }

  // Analyze endpoint
  if (req.method === 'POST' && url.pathname === '/api/analyze') {
    try {
      const data = await parseJsonBody(req);
      const { problem, answers } = data;

      if (!problem || !Array.isArray(answers) || answers.length !== 5) {
        sendError(res, 400, 'Invalid request: problem and 5 answers required');
        return;
      }

      const result = await analyzeWithDeepSeek(problem, answers);
      sendJson(res, 200, result);
    } catch (error) {
      console.error('[five-whys] Analysis error:', error);
      sendError(res, 500, error.message || 'Analysis failed');
    }
    return;
  }

  // 404
  sendError(res, 404, 'Not found');
});

ensureHistoryStore()
  .catch(error => {
    console.error('[five-whys] Failed to initialize history store:', error);
  })
  .finally(() => {
    server.listen(PORT, HOST, () => {
      console.log(`[five-whys] Server listening on http://${HOST}:${PORT}`);
      console.log(`[five-whys] DeepSeek API: ${DEEPSEEK_API_KEY ? 'configured' : 'NOT configured'}`);
      console.log(`[five-whys] History file: ${HISTORY_FILE}`);
    });
  });

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
