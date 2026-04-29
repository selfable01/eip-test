const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager, FileState } = require('@google/generative-ai/server');
const { execFile } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

const MODEL_NAME = 'gemini-2.5-flash';
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
  // Always rewrite - don't cache stale cookies
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

const DETECTIVE_PROMPT = `仔細觀看並聆聽這支影片。你是唯一的研究員——不會提供任何使用者描述。

請執行一次完整的深度分析，提取以下所有資訊：

A) 產品與受眾情報
B) 影片鉤子分析（詳細段落，描述影片前幾秒如何吸引注意力、使用了什麼畫面/字卡/台詞、目標受眾是誰、為什麼有效）
C) 行銷重點分析（詳細段落，分析影片的行銷策略：如何降低使用門檻、字卡策略、展示手法、收納/功能亮點、如何傳達核心價值）
D) 影片分鏡設計（逐場景拆解影片的時間軸、畫面內容、口播內容、字卡、精彩分鏡標籤）
E) 10/10/10 廣告選單（受此影片啟發的全新創作）

請回傳以下 JSON 格式（不要加 markdown 標記）：
{
  "product_name": "辨識出的產品名稱",
  "brand": "辨識出的品牌名稱或「未知」",
  "target_audience": "詳細目標受眾描述",
  "age_range": "具體年齡範圍",
  "gender": "目標性別",
  "niche": "利基市場類別",
  "pain_points_summary": "目標受眾的核心痛點摘要（2-3 句）",
  "magic_moment": "核心賣點 / 轉變",
  "video_hook_analysis": "影片鉤子的詳細段落分析（至少 5-8 句）：影片開頭幾秒做了什麼、用了什麼字卡和畫面切入、這是什麼類型的影片（教學/廣告/開箱等）、目標受眾精準定位在哪裡、為什麼這個開場有效。",
  "marketing_insights": "行銷重點的詳細段落分析（至少 5-8 句）：影片如何降低使用門檻、字卡策略（列出具體字卡內容）、如何搭配真人手部特寫一步步展示、如何強調產品的多功能與實用性、如何透過展示不同場景傳達產品能力、收納設計或獨特功能的展示手法、如何傳達核心價值（便攜、防塵、不佔空間等）。",
  "storyboard": [
    {
      "time": "0-22秒",
      "visual": "詳細的畫面內容描述",
      "voiceover": "實際的口播內容",
      "text_overlay": "螢幕上的字卡內容",
      "scene_label": "精彩分鏡標籤，例如：檢查配件 01"
    }
  ],
  "visual_description": "影片的視覺風格完整描述，至少 3-5 句。",
  "transcript": [
    { "time": "0:00", "text": "逐字稿內容" }
  ],
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
- video_hook_analysis 和 marketing_insights 必須是詳細的段落分析（不是條列式），至少各 5-8 句。
- storyboard 必須逐場景拆解「這支影片實際的分鏡」，每個場景包含具體的時間軸、畫面、口播、字卡、精彩分鏡標籤。
- transcript 陣列必須包含影片中所有可辨識的語音，按時間順序排列。
- 10/10/10 選單的 hooks/pains/shows 是「全新創作」，受影片啟發但不是複製。
- 每個類別恰好 10 個項目（H1-H10、P1-P10、S1-S10）。
- 每個項目必須包含所有 3 個欄位：visual、voiceover、text_overlay。
- 每個項目必須獨特——不可重複。
- 品牌語氣：溫暖、有自信、以好處為先。口語化且真實。
- 禁止虛假宣稱、禁止醫療/臨床術語、禁止年輕人網路用語。
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
- 品牌語氣：溫暖、有自信、以好處為先。
- 禁止虛假宣稱、禁止醫療術語、禁止年輕人網路用語。
- 所有內容必須使用繁體中文。`;

// ── Step 1: Analyze video → return 10/10/10 menu ──

async function runAnalysis(res, geminiFile) {
  const genAI = getGenAI();

  sse(res, 'status', { step: 3, message: 'AI 偵探正在分析影片...' });

  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: { temperature: 0.8, responseMimeType: 'application/json' },
  });

  const result = await model.generateContent([
    DETECTIVE_PROMPT,
    { fileData: { mimeType: geminiFile.mimeType, fileUri: geminiFile.uri } },
  ]);

  const text = result.response.text();
  let menu;
  try {
    menu = JSON.parse(text);
  } catch {
    sse(res, 'error', { message: '分析失敗：請確認影片中有清楚的產品展示。' });
    return;
  }

  for (const key of ['hooks', 'pains', 'shows']) {
    if (!Array.isArray(menu[key]) || menu[key].length === 0) {
      sse(res, 'error', { message: '分析失敗：請確認影片中有清楚的產品展示。' });
      return;
    }
  }

  sse(res, 'menu', menu);
  sse(res, 'done', { message: '分析完成' });
}

// ── Step 2: Assemble script from user-selected items ──

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

辨識出的產品：${body.productName || '未知'}
品牌：${body.brand || '未知'}
目標受眾：${body.targetAudience || '30-55 歲'}
核心賣點：${body.magicMoment || '無'}

用戶選擇的鉤子：
${hooksText || '未選擇'}

用戶選擇的痛點：
${painsText || '未選擇'}

用戶選擇的展示：
${showsText || '未選擇'}

請根據用戶選擇的素材，組裝一個 25-35 秒的廣告腳本。`;

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
  sse,
  sseHeaders,
  setCors,
  downloadVideo,
  uploadToGemini,
  cleanupFile,
  runAnalysis,
  runAssemble,
  TEMP_DIR,
};
