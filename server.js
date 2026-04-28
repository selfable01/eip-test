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

const MODEL_NAME = 'gemini-2.0-flash-lite';

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

function downloadVideo(videoUrl) {
  return new Promise((resolve, reject) => {
    const outputPath = path.join(TEMP_DIR, `${Date.now()}.mp4`);
    const ytdlpPath = getYtdlpPath();

    execFile(ytdlpPath, [
      '-f', 'worst[ext=mp4]/worstvideo[ext=mp4]+worstaudio[ext=m4a]/worst',
      '-S', 'res:480',
      '--merge-output-format', 'mp4',
      '-o', outputPath,
      '--no-playlist',
      '--socket-timeout', '30',
      '--js-runtimes', 'nodejs',
      '--extractor-args', 'youtube:player_client=mediaconnect',
      videoUrl,
    ], { timeout: 180000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`下載失敗：${stderr || err.message}`));
      if (!fs.existsSync(outputPath)) return reject(new Error('下載完成但找不到檔案'));
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

const DETECTIVE_PROMPT = `仔細觀看並聆聽這支影片。你是唯一的研究員——不會提供任何使用者描述。

請辨識：
1. 正在銷售的產品
2. 品牌名稱（如有）
3. 目標受眾
4. 「Magic Moment」（核心賣點）

僅根據你對此影片的分析，以高能量 3ZeBra 風格生成完整的 10/10/10 廣告選單。

請回傳以下 JSON 格式（不要加 markdown 標記）：
{
  "product_name": "辨識出的產品名稱",
  "brand": "辨識出的品牌名稱或「未知」",
  "target_audience": "辨識出的目標受眾",
  "magic_moment": "核心賣點 / 轉變",
  "hooks": [
    { "id": "H1", "visual": "鏡頭角度、運動方式、具體畫面動作", "voiceover": "實際要說的開場台詞", "text_overlay": "螢幕上顯示的文字" }
  ],
  "pains": [
    { "id": "P1", "visual": "鏡頭角度、運動方式、具體畫面動作", "voiceover": "實際要說的痛點台詞", "text_overlay": "螢幕上顯示的文字" }
  ],
  "shows": [
    { "id": "S1", "visual": "鏡頭角度、運動方式、具體畫面動作", "voiceover": "實際要說的產品展示台詞", "text_overlay": "螢幕上顯示的文字" }
  ]
}

規則：
- 每個類別恰好 10 個項目（H1-H10、P1-P10、S1-S10）。
- 每個項目必須包含所有 3 個欄位：visual、voiceover、text_overlay。
- 「visual」描述鏡頭角度、運動方式、場景設定、具體動作。
- 「voiceover」是實際要說的台詞——口語化、溫暖、有自信、真實。
- 「text_overlay」是該節拍中螢幕上顯示的文字/圖形。
- 每個項目必須獨特——不可重複。
- 目標受眾：30-55 歲。
- 品牌語氣（3ZeBra）：溫暖、有自信、以好處為先。口語化且真實。
- 禁止虛假宣稱、禁止醫療/臨床術語、禁止年輕人網路用語。
- 保持誠實、務實、合規。
- 所有內容必須使用繁體中文。`;

const SCRIPT_PROMPT = `你是一位短影片廣告剪輯師，正在組裝最終的製作腳本。

你會收到產品分析和 10/10/10 選單（鉤子、痛點、展示）。請挑選最強的角度，編織成一個流暢的 30 秒廣告腳本。

請回傳以下 JSON 格式（不要加 markdown 標記）：
{
  "product_name": "產品名稱",
  "script": [
    {
      "time": "0:00-0:03",
      "visual": "詳細的畫面描述",
      "voiceover": "實際的口播台詞",
      "text_overlay": "螢幕上顯示的文字/圖形"
    }
  ],
  "total_duration": "30 秒"
}

規則：
- 用最強的鉤子開場。
- 中段用痛點製造緊張感。
- 結尾用最好的產品展示 / CTA 收尾。
- 腳本必須自然流暢，像一支完整的影片——不是拼湊的片段。
- 畫面描述必須具體：鏡頭角度、場景設定、轉場、字卡。
- 口播必須像真人在說話——溫暖、有自信，不像在念廣告稿。
- 字卡應強化重點但不重複口播內容。
- 嚴格控制在 25-35 秒。
- 目標受眾：30-55 歲。
- 品牌語氣（3ZeBra）：溫暖、有自信、以好處為先。
- 禁止虛假宣稱、禁止醫療術語、禁止年輕人網路用語。
- 所有內容必須使用繁體中文。`;

// ── CORS ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Shared AI pipeline ──

async function runPipeline(res, geminiFile) {
  sse(res, 'status', { step: 3, message: 'AI 偵探正在分析影片...' });

  const analysisModel = genAI.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: {
      temperature: 0.8,
      responseMimeType: 'application/json',
    },
  });

  const analysisResult = await analysisModel.generateContent([
    DETECTIVE_PROMPT,
    {
      fileData: {
        mimeType: geminiFile.mimeType,
        fileUri: geminiFile.uri,
      },
    },
  ]);

  const analysisText = analysisResult.response.text();
  let menu;
  try {
    menu = JSON.parse(analysisText);
  } catch {
    sse(res, 'error', { message: '分析失敗：請確認影片中有清楚的產品展示。', raw: analysisText.slice(0, 500) });
    return;
  }

  for (const key of ['hooks', 'pains', 'shows']) {
    if (!Array.isArray(menu[key]) || menu[key].length === 0) {
      sse(res, 'error', { message: '分析失敗：請確認影片中有清楚的產品展示。' });
      return;
    }
  }

  sse(res, 'menu', menu);
  sse(res, 'status', { step: 4, message: '正在生成 30 秒廣告腳本...' });

  const scriptModel = genAI.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: {
      temperature: 0.7,
      responseMimeType: 'application/json',
    },
  });

  const scriptPrompt = `${SCRIPT_PROMPT}

辨識出的產品：${menu.product_name || '未知'}
品牌：${menu.brand || '未知'}
目標受眾：${menu.target_audience || '30-55 歲'}
核心賣點：${menu.magic_moment || '無'}

10/10/10 選單：
鉤子：
${(menu.hooks || []).map(h => `[${h.id}] 畫面: ${h.visual} | 口播: ${h.voiceover} | 字卡: ${h.text_overlay}`).join('\n')}

痛點：
${(menu.pains || []).map(p => `[${p.id}] 畫面: ${p.visual} | 口播: ${p.voiceover} | 字卡: ${p.text_overlay}`).join('\n')}

展示：
${(menu.shows || []).map(s => `[${s.id}] 畫面: ${s.visual} | 口播: ${s.voiceover} | 字卡: ${s.text_overlay}`).join('\n')}

請挑選最強的角度，組裝一個 25-35 秒的廣告腳本。`;

  const scriptResult = await scriptModel.generateContent(scriptPrompt);
  const scriptText = scriptResult.response.text();

  let script;
  try {
    script = JSON.parse(scriptText);
  } catch {
    sse(res, 'error', { message: '分析失敗：請確認影片中有清楚的產品展示。', raw: scriptText.slice(0, 500) });
    return;
  }

  if (!Array.isArray(script.script) || script.script.length === 0) {
    sse(res, 'error', { message: '分析失敗：請確認影片中有清楚的產品展示。' });
    return;
  }

  sse(res, 'script', script);
  sse(res, 'done', { message: '完成' });
}

// ── Route 1: URL-based (YouTube / Facebook / Instagram) ──

app.get('/api/generate', async (req, res) => {
  const videoUrl = req.query.url;

  if (!videoUrl) {
    return res.status(400).json({ error: '缺少 ?url= 參數' });
  }

  if (!isSupportedUrl(videoUrl)) {
    return res.status(400).json({ error: '不支援的網址。請使用 YouTube、Facebook 或 Instagram 連結。' });
  }

  sseHeaders(res);

  let localFilePath = null;

  try {
    // Ensure yt-dlp binary is ready (downloads on Vercel cold start)
    sse(res, 'status', { step: 1, message: '正在準備下載工具...' });
    await ensureYtdlp();

    sse(res, 'status', { step: 1, message: '正在下載影片（480p）...' });
    localFilePath = await downloadVideo(videoUrl);

    sse(res, 'status', { step: 2, message: '正在上傳至 Gemini...' });
    const geminiFile = await uploadToGemini(localFilePath);
    sse(res, 'status', { step: 2, message: '檔案已就緒，開始分析...' });

    await runPipeline(res, geminiFile);
  } catch (err) {
    sse(res, 'error', {
      message: '分析失敗：請確認影片網址正確且影片中有清楚的產品展示。',
      detail: err.message,
    });
  } finally {
    if (localFilePath) cleanupFile(localFilePath);
    res.end();
  }
});

// ── Route 2: Direct MP4 upload ──

app.post('/api/upload', async (req, res) => {
  const chunks = [];
  let totalSize = 0;
  const MAX_SIZE = 200 * 1024 * 1024; // 200MB

  req.on('data', chunk => {
    totalSize += chunk.length;
    if (totalSize <= MAX_SIZE) {
      chunks.push(chunk);
    }
  });

  req.on('end', async () => {
    if (totalSize > MAX_SIZE) {
      return res.status(413).json({ error: '檔案過大，請上傳 200MB 以內的影片' });
    }

    const buffer = Buffer.concat(chunks);

    if (buffer.length === 0) {
      return res.status(400).json({ error: '未收到檔案資料' });
    }

    sseHeaders(res);

    const localFilePath = path.join(TEMP_DIR, `upload_${Date.now()}.mp4`);

    try {
      sse(res, 'status', { step: 1, message: '正在儲存上傳的影片...' });
      fs.writeFileSync(localFilePath, buffer);

      sse(res, 'status', { step: 2, message: '正在上傳至 Gemini...' });
      const geminiFile = await uploadToGemini(localFilePath);
      sse(res, 'status', { step: 2, message: '檔案已就緒，開始分析...' });

      await runPipeline(res, geminiFile);
    } catch (err) {
      sse(res, 'error', {
        message: '分析失敗：請確認影片中有清楚的產品展示。',
        detail: err.message,
      });
    } finally {
      cleanupFile(localFilePath);
      res.end();
    }
  });
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
