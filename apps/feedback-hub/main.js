const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1';
const PORT = Number(process.env.BOUNDLESS_APP_PORT || 43120);
const INDEX_PATH = path.join(__dirname, 'index.html');
const SKILL_DIR = path.join(__dirname, 'skills', 'feedback-hub');
const FEEDBACK_API_PREFIX = '/api/feedback';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function send(res, statusCode, body, contentType) {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    ...corsHeaders()
  });
  res.end(body);
}

function sendJson(res, statusCode, payload) {
  send(res, statusCode, JSON.stringify(payload), 'application/json; charset=utf-8');
}

function sendText(res, statusCode, text, contentType) {
  send(res, statusCode, text, contentType);
}

function slugFromFileName(fileName) {
  return fileName.replace(/\.md$/i, '');
}

function readTitle(markdown, fallbackTitle) {
  const heading = markdown.match(/^#\s+(.+)$/m);
  return heading && heading[1] ? heading[1].trim() : fallbackTitle;
}

async function ensureSkillDir() {
  await fs.promises.mkdir(SKILL_DIR, { recursive: true });
}

async function listFeedback() {
  await ensureSkillDir();
  const entries = await fs.promises.readdir(SKILL_DIR, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name.toLowerCase() !== 'skill.md')
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  return Promise.all(files.map(async (fileName) => {
    const markdown = await fs.promises.readFile(path.join(SKILL_DIR, fileName), 'utf8');
    const slug = slugFromFileName(fileName);
    return {
      slug,
      title: readTitle(markdown, slug),
      fileName
    };
  }));
}

function toSafeSlug(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\-_.]/g, '');
}

async function readFeedback(slug) {
  const safeSlug = toSafeSlug(slug);
  if (!safeSlug) {
    return null;
  }
  const filePath = path.join(SKILL_DIR, `${safeSlug}.md`);
  try {
    const markdown = await fs.promises.readFile(filePath, 'utf8');
    return {
      slug: safeSlug,
      fileName: `${safeSlug}.md`,
      title: readTitle(markdown, safeSlug),
      markdown
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function serveIndex(res) {
  fs.readFile(INDEX_PATH, 'utf8', (error, content) => {
    if (error) {
      sendJson(res, 500, { error: 'Failed to load index.html' });
      return;
    }
    sendText(res, 200, content, 'text/html; charset=utf-8');
  });
}

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.method) {
    sendJson(res, 400, { error: 'Invalid request' });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    serveIndex(res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      service: 'feedback-hub',
      port: PORT
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/feedback') {
    try {
      const items = await listFeedback();
      sendJson(res, 200, { items });
    } catch (error) {
      console.error('[feedback-hub] Failed to list feedback:', error);
      sendJson(res, 500, { error: 'Failed to list skill markdown files' });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith(`${FEEDBACK_API_PREFIX}/`)) {
    const slug = decodeURIComponent(url.pathname.slice(`${FEEDBACK_API_PREFIX}/`.length));
    try {
      const item = await readFeedback(slug);
      if (!item) {
        sendJson(res, 404, { error: 'Feedback markdown not found' });
        return;
      }
      sendJson(res, 200, item);
    } catch (error) {
      console.error('[feedback-hub] Failed to load feedback:', error);
      sendJson(res, 500, { error: 'Failed to load skill markdown' });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[feedback-hub] Server listening on http://${HOST}:${PORT}`);
  console.log(`[feedback-hub] Reading markdown from ${SKILL_DIR}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
