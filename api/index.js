import { GoogleGenerativeAI } from '@google/generative-ai';

export const config = { runtime: 'edge' };

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL_NAME = 'gemini-2.0-flash-lite';

const corsJson = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
const sseHeaders = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'Access-Control-Allow-Origin': '*',
};

function sse(controller, event, data) {
  const encoder = new TextEncoder();
  controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

// ── Prompts (Traditional Chinese) ──

const DETECTIVE_PROMPT_TRANSCRIPT = `你是唯一的研究員——不會提供任何使用者描述。
你會收到一段影片的字幕。請從字幕內容推斷：

1. 正在銷售的產品
2. 品牌名稱（如有）
3. 目標受眾
4. 「Magic Moment」（核心賣點）

僅根據字幕分析，以高能量 3ZeBra 風格生成完整的 10/10/10 廣告選單。

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

const DETECTIVE_PROMPT_VIDEO = `仔細觀看並聆聽這支影片。你是唯一的研究員——不會提供任何使用者描述。

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
- 每個項目必須獨特——不可重複。
- 目標受眾：30-55 歲。
- 品牌語氣（3ZeBra）：溫暖、有自信、以好處為先。
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
- 品牌語氣（3ZeBra）：溫暖、有自信、以好處為先。
- 禁止虛假宣稱、禁止醫療術語、禁止年輕人網路用語。
- 所有內容必須使用繁體中文。`;

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

// ── Script generation (shared) ──

async function generateScript(controller, menu) {
  sse(controller, 'status', { step: 4, message: '正在生成 30 秒廣告腳本...' });

  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: { temperature: 0.7, responseMimeType: 'application/json' },
  });

  const prompt = `${SCRIPT_PROMPT}

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

  const result = await model.generateContent(prompt);
  const text = result.response.text();

  let script;
  try {
    script = JSON.parse(text);
  } catch {
    sse(controller, 'error', { message: '分析失敗：腳本生成格式錯誤。' });
    return;
  }

  if (!Array.isArray(script.script) || script.script.length === 0) {
    sse(controller, 'error', { message: '分析失敗：腳本內容為空。' });
    return;
  }

  sse(controller, 'script', script);
  sse(controller, 'done', { message: '完成' });
}

// ──────────────────────────────────────────────────────
//  /api/generate — URL-based (YouTube uses transcript, FB/IG not supported on Vercel)
// ──────────────────────────────────────────────────────

async function handleGenerate(req) {
  const url = new URL(req.url);
  const videoUrl = url.searchParams.get('url');

  if (!videoUrl) {
    return new Response(JSON.stringify({ error: '缺少 ?url= 參數' }), { status: 400, headers: corsJson });
  }

  if (!isSupportedUrl(videoUrl)) {
    return new Response(JSON.stringify({ error: '不支援的網址。請使用 YouTube、Facebook 或 Instagram 連結。' }), { status: 400, headers: corsJson });
  }

  const videoId = extractVideoId(videoUrl);

  // On Vercel we can only use transcript for YouTube (no yt-dlp available)
  // For Facebook/Instagram, we need local server
  if (!videoId) {
    return new Response(JSON.stringify({
      error: 'Vercel 雲端版僅支援 YouTube 網址。Facebook / Instagram 請使用本機版（npm start）或直接上傳 MP4。'
    }), { status: 400, headers: corsJson });
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Step 1: Fetch transcript
        sse(controller, 'status', { step: 1, message: '正在抓取影片字幕...' });

        let transcript = '';
        try {
          const transcriptRes = await fetch(
            `https://api.supadata.ai/v1/youtube/transcript?url=https://www.youtube.com/watch?v=${videoId}&text=true`,
            { headers: { 'x-api-key': process.env.SUPADATA_API_KEY || '' } }
          );
          if (transcriptRes.ok) {
            const data = await transcriptRes.json();
            transcript = data.content || '';
          }
        } catch { /* transcript fetch failed */ }

        if (!transcript || transcript.length < 20) {
          sse(controller, 'error', {
            message: '無法取得影片字幕。請改用「上傳 MP4」功能，或在本機版執行。',
          });
          controller.close();
          return;
        }

        sse(controller, 'status', { step: 1, message: `已取得字幕（${transcript.length} 字元）` });

        // Step 2+3: Detective analysis with transcript
        sse(controller, 'status', { step: 3, message: 'AI 偵探正在分析字幕...' });

        const model = genAI.getGenerativeModel({
          model: MODEL_NAME,
          generationConfig: { temperature: 0.8, responseMimeType: 'application/json' },
        });

        const result = await model.generateContent(
          `${DETECTIVE_PROMPT_TRANSCRIPT}\n\n以下是影片字幕內容（可能為英文，但請用繁體中文回答）：\n${transcript}`
        );

        const analysisText = result.response.text();
        let menu;
        try {
          menu = JSON.parse(analysisText);
        } catch {
          sse(controller, 'error', { message: '分析失敗：請確認影片中有清楚的產品展示。' });
          controller.close();
          return;
        }

        for (const key of ['hooks', 'pains', 'shows']) {
          if (!Array.isArray(menu[key]) || menu[key].length === 0) {
            sse(controller, 'error', { message: '分析失敗：請確認影片中有清楚的產品展示。' });
            controller.close();
            return;
          }
        }

        sse(controller, 'menu', menu);

        // Step 4: Generate script
        await generateScript(controller, menu);
      } catch (err) {
        sse(controller, 'error', { message: '分析失敗：' + (err.message || '發生未預期的錯誤') });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: sseHeaders });
}

// ──────────────────────────────────────────────────────
//  /api/upload — Direct MP4 upload (Vercel has ~4.5MB body limit)
// ──────────────────────────────────────────────────────

async function handleUpload(req) {
  let bodyBytes;
  try {
    bodyBytes = await req.arrayBuffer();
  } catch {
    return new Response(JSON.stringify({ error: '無法讀取上傳資料' }), { status: 400, headers: corsJson });
  }

  if (bodyBytes.byteLength === 0) {
    return new Response(JSON.stringify({ error: '未收到檔案資料' }), { status: 400, headers: corsJson });
  }

  // Convert to base64 for inline Gemini call
  const base64Data = btoa(String.fromCharCode(...new Uint8Array(bodyBytes)));

  const stream = new ReadableStream({
    async start(controller) {
      try {
        sse(controller, 'status', { step: 1, message: '已收到影片檔案' });
        sse(controller, 'status', { step: 3, message: 'AI 偵探正在分析影片...' });

        const model = genAI.getGenerativeModel({
          model: MODEL_NAME,
          generationConfig: { temperature: 0.8, responseMimeType: 'application/json' },
        });

        const result = await model.generateContent([
          DETECTIVE_PROMPT_VIDEO,
          {
            inlineData: {
              mimeType: 'video/mp4',
              data: base64Data,
            },
          },
        ]);

        const analysisText = result.response.text();
        let menu;
        try {
          menu = JSON.parse(analysisText);
        } catch {
          sse(controller, 'error', { message: '分析失敗：請確認影片中有清楚的產品展示。' });
          controller.close();
          return;
        }

        for (const key of ['hooks', 'pains', 'shows']) {
          if (!Array.isArray(menu[key]) || menu[key].length === 0) {
            sse(controller, 'error', { message: '分析失敗：請確認影片中有清楚的產品展示。' });
            controller.close();
            return;
          }
        }

        sse(controller, 'menu', menu);
        await generateScript(controller, menu);
      } catch (err) {
        sse(controller, 'error', {
          message: '分析失敗：' + (err.message || '發生未預期的錯誤'),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: sseHeaders });
}

// ──────────────────────────────────────────────────────
//  MAIN HANDLER
// ──────────────────────────────────────────────────────

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  const url = new URL(req.url);
  const pathname = url.pathname;

  // New routes
  if (pathname === '/api/generate' || pathname === '/api/generate/') {
    return handleGenerate(req);
  }

  if (pathname === '/api/upload' || pathname === '/api/upload/') {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: '請使用 POST 方法' }), { status: 405, headers: corsJson });
    }
    return handleUpload(req);
  }

  return new Response(JSON.stringify({ error: '找不到此路由。請使用 /api/generate 或 /api/upload' }), {
    status: 404,
    headers: corsJson,
  });
}
