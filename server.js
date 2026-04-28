require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager, FileState } = require('@google/generative-ai/server');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname), { redirect: false }));

const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);

const MODEL_NAME = 'gemini-2.0-flash-lite';

// ── Helpers ──

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1);
    if (u.hostname.includes('youtube.com')) {
      const shortsMatch = u.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]+)/);
      if (shortsMatch) return shortsMatch[1];
      return u.searchParams.get('v');
    }
  } catch { /* invalid url */ }
  return null;
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function downloadVideo(videoUrl) {
  return new Promise((resolve, reject) => {
    const videoId = extractVideoId(videoUrl) || Date.now().toString();
    const outputPath = path.join(TEMP_DIR, `${videoId}.mp4`);
    const ytdlpPath = path.join(__dirname, 'yt-dlp.exe');

    execFile(ytdlpPath, [
      '-f', 'worst[ext=mp4]/worstvideo[ext=mp4]+worstaudio[ext=m4a]/worst',
      '-S', 'res:480',
      '--merge-output-format', 'mp4',
      '-o', outputPath,
      '--no-playlist',
      '--socket-timeout', '30',
      videoUrl,
    ], { timeout: 120000 }, (err, stdout, stderr) => {
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
    throw new Error('Gemini file processing failed');
  }

  return file;
}

function cleanupFile(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* ignore cleanup errors */ }
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

const DETECTIVE_PROMPT = `Watch and listen to this video carefully. You are the sole researcher — no user-provided description will be given.

Identify:
1. The product being sold
2. Its brand name (if available)
3. The target audience
4. The "Magic Moment" (the primary benefit)

Based ONLY on your analysis of this video, generate a complete 10/10/10 Ad Menu in the high-energy 3ZeBra style.

Return the following JSON (no markdown fences):
{
  "product_name": "identified product name",
  "brand": "identified brand or 'Unknown'",
  "target_audience": "identified target audience",
  "magic_moment": "the primary benefit / transformation",
  "hooks": [
    { "id": "H1", "visual": "Camera angle, movement, specific on-screen action", "voiceover": "Exact opening line to say", "text_overlay": "Text shown on screen" }
  ],
  "pains": [
    { "id": "P1", "visual": "Camera angle, movement, specific on-screen action", "voiceover": "Exact pain-point line to say", "text_overlay": "Text shown on screen" }
  ],
  "shows": [
    { "id": "S1", "visual": "Camera angle, movement, specific on-screen action", "voiceover": "Exact product-show line to say", "text_overlay": "Text shown on screen" }
  ]
}

Rules:
- Exactly 10 items per category (H1-H10, P1-P10, S1-S10).
- Each item MUST have all 3 fields: visual, voiceover, text_overlay.
- "visual" describes camera angles, movements, scene setup, specific actions.
- "voiceover" is the actual spoken line — conversational, warm, confident, real.
- "text_overlay" is the on-screen text/graphics for this beat.
- Every item must be unique — no repeats.
- Target audience: 30-55 years old.
- Brand tone (3ZeBra): warm, confident, benefit-first. Conversational and authentic.
- NO false claims, NO medical/clinical terms, NO young internet slang.
- Stay honest, practical, compliant.`;

const SCRIPT_PROMPT = `You are a short-form ad editor assembling a final production script.

You will receive a product analysis and a 10/10/10 menu (hooks, pains, shows). Pick the STRONGEST angles and weave them into one seamless 30-second ad script.

Return the following JSON (no markdown fences):
{
  "product_name": "the product name",
  "script": [
    {
      "time": "0:00-0:03",
      "visual": "Detailed on-screen description",
      "voiceover": "Exact spoken line",
      "text_overlay": "On-screen text/graphics"
    }
  ],
  "total_duration": "30 seconds"
}

Rules:
- Open with the strongest hook.
- Build tension with the best pain point(s) in the middle.
- Close with the best product show / CTA.
- The script must flow naturally like one complete video — not stitched fragments.
- Visual descriptions must be specific: camera angles, scene setting, transitions, text cards.
- Voiceover must sound like a real person speaking — warm, confident, not reading ad copy.
- Text overlays should reinforce key points but NOT duplicate voiceover.
- Strictly 25-35 seconds total.
- Target audience: 30-55 years old.
- Brand tone (3ZeBra): warm, confident, benefit-first.
- NO false claims, NO medical terms, NO young internet slang.`;

// ── CORS ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ──────────────────────────────────────────────────────
//  SINGLE ENDPOINT — Full automated pipeline
// ──────────────────────────────────────────────────────

app.get('/api/generate', async (req, res) => {
  const videoUrl = req.query.url;

  if (!videoUrl) {
    return res.status(400).json({ error: 'Missing ?url= parameter' });
  }

  const videoId = extractVideoId(videoUrl);
  if (!videoId) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  sseHeaders(res);

  let localFilePath = null;

  try {
    // Step 1: Download video at 480p
    sse(res, 'status', { step: 1, message: 'Downloading video (480p)...' });
    localFilePath = await downloadVideo(videoUrl);

    // Step 2: Upload to Gemini File API
    sse(res, 'status', { step: 2, message: 'Uploading to Gemini...' });
    const geminiFile = await uploadToGemini(localFilePath);
    sse(res, 'status', { step: 2, message: 'File active. Starting analysis...' });

    // Step 3: "Detective" Analysis — extract product + generate 10/10/10
    sse(res, 'status', { step: 3, message: 'AI analyzing video (Detective Mode)...' });

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
      sse(res, 'error', { message: 'Analysis Failed: Please ensure the video has clear product demonstrations.', raw: analysisText.slice(0, 500) });
      return;
    }

    // Validate menu structure
    for (const key of ['hooks', 'pains', 'shows']) {
      if (!Array.isArray(menu[key]) || menu[key].length === 0) {
        sse(res, 'error', { message: 'Analysis Failed: Please ensure the video has clear product demonstrations.' });
        return;
      }
    }

    sse(res, 'menu', menu);

    // Step 4: Auto-generate 30-second production script
    sse(res, 'status', { step: 4, message: 'Generating 30-second ad script...' });

    const scriptModel = genAI.getGenerativeModel({
      model: MODEL_NAME,
      generationConfig: {
        temperature: 0.7,
        responseMimeType: 'application/json',
      },
    });

    const scriptPrompt = `${SCRIPT_PROMPT}

Product identified: ${menu.product_name || 'Unknown'}
Brand: ${menu.brand || 'Unknown'}
Target audience: ${menu.target_audience || '30-55 years old'}
Magic Moment: ${menu.magic_moment || 'N/A'}

10/10/10 Menu:
HOOKS:
${(menu.hooks || []).map(h => `[${h.id}] Visual: ${h.visual} | VO: ${h.voiceover} | Text: ${h.text_overlay}`).join('\n')}

PAINS:
${(menu.pains || []).map(p => `[${p.id}] Visual: ${p.visual} | VO: ${p.voiceover} | Text: ${p.text_overlay}`).join('\n')}

SHOWS:
${(menu.shows || []).map(s => `[${s.id}] Visual: ${s.visual} | VO: ${s.voiceover} | Text: ${s.text_overlay}`).join('\n')}

Pick the strongest angles and assemble a 25-35 second ad script.`;

    const scriptResult = await scriptModel.generateContent(scriptPrompt);
    const scriptText = scriptResult.response.text();

    let script;
    try {
      script = JSON.parse(scriptText);
    } catch {
      sse(res, 'error', { message: 'Analysis Failed: Please ensure the video has clear product demonstrations.', raw: scriptText.slice(0, 500) });
      return;
    }

    if (!Array.isArray(script.script) || script.script.length === 0) {
      sse(res, 'error', { message: 'Analysis Failed: Please ensure the video has clear product demonstrations.' });
      return;
    }

    sse(res, 'script', script);
    sse(res, 'done', { message: 'Complete' });

  } catch (err) {
    sse(res, 'error', {
      message: 'Analysis Failed: Please ensure the video has clear product demonstrations.',
      detail: err.message,
    });
  } finally {
    // Automatic cleanup
    if (localFilePath) cleanupFile(localFilePath);
    res.end();
  }
});

// ── Serve index.html ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`3ZeBra Auto-Mirror running at http://localhost:${PORT}`);
});
