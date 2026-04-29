const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager, FileState } = require('@google/generative-ai/server');
const { execFile } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

const MODEL_NAME = 'gemini-2.5-pro';
const YTDLP_PATH = '/tmp/yt-dlp';
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
const TEMP_DIR = '/tmp';

let _genAI = null;
let _fileManager = null;

function getGenAI() {
  if (!_genAI) _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return _genAI;
}

function getFileManager() {
  if (!_fileManager) _fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);
  return _fileManager;
}

// ── yt-dlp binary ──

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      https.get(u, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return follow(response.headers.location);
        }
        if (response.statusCode !== 200) {
          return reject(new Error(`Download failed: ${response.statusCode}`));
        }
        const file = fs.createWriteStream(dest);
        response.pipe(file);
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
  if (fs.existsSync(YTDLP_PATH)) return;
  await downloadFile(YTDLP_URL, YTDLP_PATH);
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

function detectPlatform(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace('www.', '');
    if (host === 'youtu.be' || host.includes('youtube.com')) return 'YouTube';
    if (host.includes('facebook.com') || host.includes('fb.watch') || host.includes('fb.com')) return 'Facebook';
    if (host.includes('instagram.com')) return 'Instagram';
    return '未知';
  } catch {
    return '未知';
  }
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const COOKIES_PATH = '/tmp/cookies.txt';

function ensureCookies() {
  const header = '# Netscape HTTP Cookie File\n';
  const parts = [
    process.env.YT_COOKIES || '',
    process.env.FB_COOKIES || '',
    process.env.IG_COOKIES || '',
  ].filter(Boolean);
  if (parts.length > 0) {
    fs.writeFileSync(COOKIES_PATH, header + parts.join('\n'));
  }
}

function downloadVideo(videoUrl) {
  return new Promise((resolve, reject) => {
    const outputPath = path.join(TEMP_DIR, `${Date.now()}.mp4`);

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

    if (fs.existsSync(COOKIES_PATH)) {
      args.push('--cookies', COOKIES_PATH);
    }

    args.push(videoUrl);

    execFile(YTDLP_PATH, args, { timeout: 180000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`Download failed: ${stderr || err.message}`));
      if (!fs.existsSync(outputPath)) return reject(new Error('Download completed but file not found'));
      resolve(outputPath);
    });
  });
}

function getVideoTitle(videoUrl, ytdlpPath) {
  return new Promise((resolve) => {
    ensureCookies();
    const args = ['--print', 'title', '--no-download', '--socket-timeout', '15'];
    if (fs.existsSync(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);
    args.push(videoUrl);
    execFile(ytdlpPath || YTDLP_PATH, args, { timeout: 20000 }, (err, stdout) => {
      if (err) return resolve('');
      resolve(stdout.trim());
    });
  });
}

async function uploadToGemini(filePath) {
  const fm = getFileManager();
  const uploadResult = await fm.uploadFile(filePath, {
    mimeType: 'video/mp4',
    displayName: path.basename(filePath),
  });

  let file = uploadResult.file;

  while (file.state === FileState.PROCESSING) {
    await new Promise(r => setTimeout(r, 3000));
    file = (await fm.getFile(file.name)).file || await fm.getFile(file.name);
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

// ── Prompts ──

const ANALYSIS_PROMPT = `仔細觀看並聆聽這支影片。你是唯一的研究員——不會提供任何使用者描述。

請執行一次完整的深度分析，提取以下所有資訊：

A) 影片基本資訊與產品情報
B) 影片鉤子分析（前5-10秒的開場為什麼有效，分成2-3個重點深入分析）
C) 行銷重點分析（影片中使用的行銷策略，分成2-4個重點深入分析）
D) 影片分鏡設計（逐場景拆解影片的完整時間軸）
E) 逐字稿

請回傳以下 JSON 格式（不要加 markdown 標記）：
{
  "video_title": "從影片內容推測的影片標題或主題",
  "product_name": "辨識出的產品名稱",
  "brand": "辨識出的品牌名稱或「未知」",
  "target_audience": "詳細目標受眾描述",
  "age_range": "具體年齡範圍",
  "gender": "目標性別",
  "niche": "利基市場類別",
  "pain_points_summary": "目標受眾的核心痛點摘要（2-3句）",
  "magic_moment": "核心賣點／轉變",
  "hook_sections": [
    {
      "title": "重點標題（例如：生活情境劇切入痛點）",
      "content": "詳細分析段落（至少3-5句），解釋這個開場手法為什麼有效"
    }
  ],
  "marketing_sections": [
    {
      "title": "重點標題（例如：解決痛點：仿真人手感與全身覆蓋）",
      "content": "詳細分析段落（至少3-5句），解釋這個行銷策略如何運作"
    }
  ],
  "storyboard": [
    {
      "time": "0-6秒",
      "visual": "• 重點畫面描述1\\n• 重點畫面描述2\\n• 重點畫面描述3",
      "voiceover": "實際的口播內容",
      "text_overlay": "螢幕上的字卡內容",
      "scene_label": "精彩分鏡標籤，例如：檢查配件 01"
    }
  ],
  "visual_description": "影片的視覺風格完整描述（至少3句）",
  "transcript": [
    { "time": "0:00", "text": "逐字稿內容" }
  ]
}

規則：
- hook_sections 必須包含 2-3 個重點，每個重點的 content 至少 3-5 句，深入分析前5-10秒的開場為什麼有效、使用了什麼技巧、目標受眾是誰、為什麼能吸引注意力。
- marketing_sections 必須包含 2-4 個重點，每個重點的 content 至少 3-5 句，分析影片的行銷策略。
- storyboard 的 visual 欄位必須使用「•」符號開頭的重點條列（bullet points），每個場景至少 2-3 個重點描述。
- storyboard 必須逐場景拆解「這支影片實際的分鏡」，場景數量根據影片長度而定。
- transcript 必須包含影片中所有可辨識的語音，按時間順序排列。
- 所有內容必須使用繁體中文。`;

const MENU_PROMPT = `你是一位短影音廣告創意總監。你會收到一支「參考影片」的完整分析報告，以及用戶要推廣的「產品資訊」。

你的任務是：以參考影片的風格與手法為靈感，為用戶的產品創作全新的廣告素材。

請產出：
- 10 個不同的「影片鉤子 Hooks」分鏡（前3-5秒吸睛開場）
- 10 個不同的「痛點」分鏡（痛點渲染與情境）
- 10 個不同的「展示」分鏡（產品展示與功能亮點）

請回傳以下 JSON 格式（不要加 markdown 標記）：
{
  "hooks": [
    { "id": "H1", "visual": "具體的畫面內容描述（鏡頭角度、場景、演員動作）", "voiceover": "實際要說的開場台詞", "text_overlay": "螢幕上顯示的字卡文字" }
  ],
  "pains": [
    { "id": "P1", "visual": "具體的畫面內容描述", "voiceover": "實際要說的痛點台詞", "text_overlay": "螢幕上顯示的字卡文字" }
  ],
  "shows": [
    { "id": "S1", "visual": "具體的畫面內容描述", "voiceover": "實際要說的產品展示台詞", "text_overlay": "螢幕上顯示的字卡文字" }
  ]
}

規則：
- 每個類別恰好 10 個項目（H1-H10、P1-P10、S1-S10）。
- visual 描述要具體：包含鏡頭角度、場景設定、演員動作。
- voiceover 要像真人在說話——溫暖、自然、口語化，不像在念廣告稿。
- text_overlay 要簡潔有力，強化重點但不重複口播。
- 所有素材都是「全新創作」，參考影片的風格但針對用戶的產品量身打造。
- 每個項目必須獨特——不可重複。
- 品牌語氣：溫暖、有自信、以好處為先。
- 禁止虛假宣稱、禁止醫療／臨床術語、禁止年輕人網路用語。
- 所有內容必須使用繁體中文。`;

const SCRIPT_PROMPT = `你是一位短影片廣告剪輯師，正在組裝最終的製作腳本。

你會收到產品分析和用戶選擇的素材（鉤子、痛點、展示）。請挑選最強的角度，編織成一個流暢的 45-60 秒廣告腳本。

請回傳以下 JSON 格式（不要加 markdown 標記）：
{
  "product_name": "產品名稱",
  "script": [
    {
      "time": "0:00-0:03",
      "visual": "• 具體畫面描述1\\n• 具體畫面描述2",
      "voiceover": "實際的口播台詞",
      "text_overlay": "螢幕上顯示的文字／圖形"
    }
  ],
  "total_duration": "45-60 秒"
}

規則：
- 用最強的鉤子開場。
- 中段用痛點製造緊張感。
- 結尾用最好的產品展示 / CTA 收尾。
- 腳本必須自然流暢，像一支完整的影片——不是拼湊的片段。
- 畫面描述使用「•」bullet points 條列重點。
- 口播必須像真人在說話——溫暖、有自信，不像在念廣告稿。
- 字卡應強化重點但不重複口播內容。
- 嚴格控制在 45-60 秒。
- 品牌語氣：溫暖、有自信、以好處為先。
- 禁止虛假宣稱、禁止醫療術語、禁止年輕人網路用語。
- 所有內容必須使用繁體中文。`;

// ── Step 1: Analyze video → return analysis (no 10/10/10) ──

async function runAnalysis(res, geminiFile) {
  const genAI = getGenAI();

  sse(res, 'status', { step: 3, message: 'AI 正在深度分析影片...' });

  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: { temperature: 0.8, responseMimeType: 'application/json' },
  });

  const result = await model.generateContent([
    ANALYSIS_PROMPT,
    { fileData: { mimeType: geminiFile.mimeType, fileUri: geminiFile.uri } },
  ]);

  const text = result.response.text();
  let analysis;
  try {
    analysis = JSON.parse(text);
  } catch {
    sse(res, 'error', { message: '分析失敗：請確認影片中有清楚的產品展示。' });
    return;
  }

  if (!Array.isArray(analysis.storyboard) || analysis.storyboard.length === 0) {
    sse(res, 'error', { message: '分析失敗：無法辨識影片內容，請確認影片中有清楚的產品展示。' });
    return;
  }

  sse(res, 'analysis', analysis);
  sse(res, 'done', { message: '分析完成' });
}

// ── Step 2: Generate 10/10/10 menu based on user's product ──

async function runGenerateMenu(res, body) {
  const genAI = getGenAI();

  sse(res, 'status', { message: '正在根據您的產品生成廣告素材...' });

  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: { temperature: 0.8, responseMimeType: 'application/json' },
  });

  // Build reference video summary
  const refSummary = `
參考影片標題：${body.videoTitle || '未知'}
參考影片產品：${body.refProductName || '未知'}
參考影片品牌：${body.refBrand || '未知'}
參考影片目標受眾：${body.refTargetAudience || '未知'}
參考影片核心賣點：${body.refMagicMoment || '未知'}

影片鉤子分析：
${(body.hookSections || []).map((s, i) => `${i + 1}. ${s.title}\n${s.content}`).join('\n\n')}

行銷重點分析：
${(body.marketingSections || []).map((s, i) => `${i + 1}. ${s.title}\n${s.content}`).join('\n\n')}
`.trim();

  const prompt = `${MENU_PROMPT}

## 參考影片分析報告

${refSummary}

## 用戶的產品資訊

產品名稱：${body.productName || '未提供'}
產品描述：${body.productDesc || '未提供'}

請根據參考影片的風格，為上述產品創作 10/10/10 廣告素材。`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();

  let menu;
  try {
    menu = JSON.parse(text);
  } catch {
    sse(res, 'error', { message: '生成失敗，請重試。' });
    return;
  }

  for (const key of ['hooks', 'pains', 'shows']) {
    if (!Array.isArray(menu[key]) || menu[key].length === 0) {
      sse(res, 'error', { message: '生成失敗：無法產生足夠的廣告素材，請重試。' });
      return;
    }
  }

  sse(res, 'menu', menu);
  sse(res, 'done', { message: '生成完成' });
}

// ── Step 3: Assemble script from user-selected items ──

async function runAssemble(res, body) {
  const genAI = getGenAI();

  sse(res, 'status', { message: '正在組裝最終腳本...' });

  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: { temperature: 0.7, responseMimeType: 'application/json' },
  });

  const hooksText = (body.hooks || []).map(h =>
    `[${h.id}] 畫面: ${h.visual} | 口播: ${h.voiceover} | 字卡: ${h.text_overlay}`
  ).join('\n');
  const painsText = (body.pains || []).map(p =>
    `[${p.id}] 畫面: ${p.visual} | 口播: ${p.voiceover} | 字卡: ${p.text_overlay}`
  ).join('\n');
  const showsText = (body.shows || []).map(s =>
    `[${s.id}] 畫面: ${s.visual} | 口播: ${s.voiceover} | 字卡: ${s.text_overlay}`
  ).join('\n');

  const prompt = `${SCRIPT_PROMPT}

產品名稱：${body.productName || '未知'}
產品描述：${body.productDesc || ''}
目標受眾：${body.targetAudience || '30-55 歲'}
核心賣點：${body.magicMoment || '無'}

用戶選擇的鉤子：
${hooksText || '未選擇'}

用戶選擇的痛點：
${painsText || '未選擇'}

用戶選擇的展示：
${showsText || '未選擇'}

請根據用戶選擇的素材，組裝一個 45-60 秒的廣告腳本。`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();

  let script;
  try {
    script = JSON.parse(text);
  } catch {
    sse(res, 'error', { message: '腳本生成失敗，請重試。' });
    return;
  }

  if (!Array.isArray(script.script) || script.script.length === 0) {
    sse(res, 'error', { message: '腳本生成失敗，請重試。' });
    return;
  }

  sse(res, 'script', script);
  sse(res, 'done', { message: '完成' });
}

module.exports = {
  ensureYtdlp,
  isSupportedUrl,
  detectPlatform,
  sse,
  sseHeaders,
  setCors,
  downloadVideo,
  getVideoTitle,
  uploadToGemini,
  cleanupFile,
  runAnalysis,
  runGenerateMenu,
  runAssemble,
  TEMP_DIR,
};
