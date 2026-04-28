require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { execFile } = require('child_process');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager, FileState } = require('@google/generative-ai/server');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_VERCEL = !!process.env.VERCEL;
const IS_WIN = process.platform === 'win32';

// Skip JSON parsing for upload route
app.use((req, res, next) => {
  if (req.path === '/api/upload') return next();
  express.json({ limit: '10mb' })(req, res, next);
});

app.use(express.static(path.join(__dirname), { redirect: false }));

// Temp dir: /tmp on Vercel, ./temp locally
const TEMP_DIR = IS_VERCEL ? '/tmp' : path.join(__dirname, 'temp');
if (!IS_VERCEL && !fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);

const MODEL_NAME = 'gemini-3.1-pro-preview';

// ── yt-dlp binary management ──

const YTDLP_LOCAL = path.join(__dirname, 'yt-dlp.exe');
const YTDLP_LINUX = '/tmp/yt-dlp';
const YTDLP_DOWNLOAD_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';

function getYtdlpPath() {
  return IS_WIN ? YTDLP_LOCAL : YTDLP_LINUX;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return follow(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`下載失敗，狀態碼：${res.statusCode}`));
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          fs.chmodSync(dest, '755');
          resolve();
        });
        file.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

async function ensureYtdlp() {
  if (IS_WIN) return; // Use bundled yt-dlp.exe
  if (fs.existsSync(YTDLP_LINUX)) return; // Already cached in /tmp

  console.log('Downloading yt-dlp Linux binary...');
  await downloadFile(YTDLP_DOWNLOAD_URL, YTDLP_LINUX);
  console.log('yt-dlp downloaded successfully.');
}

// ── Helpers ──

function isSupportedUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace('www.', '');
    if (host === 'youtu.be' || host.includes('youtube.com')) return true;
    if (host.includes('facebook.com') || host.includes('fb.watch') || host.includes('fb.com')) return true;
    if (host.includes('instagram.com')) return true;
    return false;
  } catch {
    return false;
  }
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function getCookiesPath() {
  if (IS_WIN) return path.join(__dirname, 'cookies.txt');
  return '/tmp/cookies.txt';
}

function ensureCookies() {
  const cookiesPath = getCookiesPath();
  // Always rewrite - don't cache stale cookies
  const header = '# Netscape HTTP Cookie File\n';
  const parts = [
    process.env.YT_COOKIES || '',
    process.env.FB_COOKIES || '',
    process.env.IG_COOKIES || '',
  ].filter(Boolean);
  if (parts.length > 0) {
    fs.writeFileSync(cookiesPath, header + parts.join('\n'));
  }
}

function downloadVideo(videoUrl) {
  return new Promise((resolve, reject) => {
    const outputPath = path.join(TEMP_DIR, `${Date.now()}.mp4`);
    const ytdlpPath = getYtdlpPath();
    const cookiesPath = getCookiesPath();

    ensureCookies();

    const args = [
      '-f', 'worst[ext=mp4]/worstvideo[ext=mp4]+worstaudio[ext=m4a]/worst',
      '-S', 'res:480',
      '--merge-output-format', 'mp4',
      '-o', outputPath,
      '--no-playlist',
      '--socket-timeout', '30',
      '--js-runtimes', 'node',
    ];

    if (fs.existsSync(cookiesPath)) {
      args.push('--cookies', cookiesPath);
    }

    args.push(videoUrl);

    execFile(ytdlpPath, args, { timeout: 180000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`Download failed: ${stderr || err.message}`));
      if (!fs.existsSync(outputPath)) return reject(new Error('Download completed but file not found'));
      resolve(outputPath);
    });
  });
}

async function uploadToGemini(filePath) {
  const uploadResult = await fileManager.uploadFile(filePath, {
    mimeType: 'video/mp4',
    displayName: path.basename(filePath),
  });

  let file = uploadResult.file;

  while (file.state === FileState.PROCESSING) {
    await new Promise(r => setTimeout(r, 3000));
    file = (await fileManager.getFile(file.name)).file || await fileManager.getFile(file.name);
  }

  if (file.state === FileState.FAILED) {
    throw new Error('Gemini 檔案處理失敗');
  }

  return file;
}

function cleanupFile(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* ignore */ }
}

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
}

// ── Prompts ──

// Use shared functions from lib/pipeline.js
const { runAnalysis: runSharedAnalysis, runAssemble: runSharedAssemble } = require('./lib/pipeline');

// ── CORS ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Route 1: URL-based (YouTube / Facebook / Instagram) ──

app.get('/api/generate', async (req, res) => {
  const videoUrl = req.query.url;

  if (!videoUrl) return res.status(400).json({ error: '缺少 ?url= 參數' });
  if (!isSupportedUrl(videoUrl)) return res.status(400).json({ error: '不支援的網址。' });

  sseHeaders(res);
  let localFilePath = null;

  try {
    sse(res, 'status', { step: 1, message: '正在準備下載工具...' });
    await ensureYtdlp();
    sse(res, 'status', { step: 1, message: '正在下載影片（480p）...' });
    localFilePath = await downloadVideo(videoUrl);
    sse(res, 'status', { step: 2, message: '正在上傳至 Gemini...' });
    const geminiFile = await uploadToGemini(localFilePath);
    await runSharedAnalysis(res, geminiFile);
  } catch (err) {
    sse(res, 'error', { message: '分析失敗：請確認影片網址正確。', detail: err.message });
  } finally {
    if (localFilePath) cleanupFile(localFilePath);
    res.end();
  }
});

// ── Route 2: Upload config ──

app.get('/api/upload-config', (req, res) => {
  res.json({ apiKey: process.env.GEMINI_API_KEY });
});

// ── Route 3: Analyze uploaded file ──

app.post('/api/upload', async (req, res) => {
  const { fileUri, mimeType } = req.body || {};
  if (!fileUri) return res.status(400).json({ error: 'Missing fileUri' });

  sseHeaders(res);
  try {
    sse(res, 'status', { step: 2, message: '檔案已就緒，開始分析...' });
    await runSharedAnalysis(res, { uri: fileUri, mimeType: mimeType || 'video/mp4' });
  } catch (err) {
    sse(res, 'error', { message: '分析失敗。', detail: err.message });
  } finally {
    res.end();
  }
});

// ── Route 4: Assemble script from user selections ──

app.post('/api/assemble', async (req, res) => {
  const body = req.body;
  if (!body || (!body.hooks?.length && !body.pains?.length && !body.shows?.length)) {
    return res.status(400).json({ error: '請至少選擇一個項目' });
  }

  sseHeaders(res);
  try {
    await runSharedAssemble(res, body);
  } catch (err) {
    sse(res, 'error', { message: '腳本生成失敗。', detail: err.message });
  } finally {
    res.end();
  }
});

// ── Serve index.html ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Local dev
if (!IS_VERCEL) {
  app.listen(PORT, () => {
    console.log(`3ZeBra Auto-Mirror running at http://localhost:${PORT}`);
  });
}

// Export for Vercel
module.exports = app;
