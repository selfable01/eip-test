import { GoogleGenerativeAI } from '@google/generative-ai';

export const config = { runtime: 'edge' };

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1);
    if (u.hostname.includes('youtube.com')) return u.searchParams.get('v');
  } catch { /* invalid url */ }
  return null;
}

function sse(controller, event, data) {
  const encoder = new TextEncoder();
  controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

// ──────────────────────────────────────────────────────
//  STEP 1 — Context & Analysis (Reference Logic)
// ──────────────────────────────────────────────────────

const STEP1_SYSTEM = `你是一位世界級的短影片廣告策略師與創意總監。
你的任務是分析參考影片的字幕，推斷其成功邏輯 — 如何吸引注意力（Hook）、激發痛點（Pain）、展示產品（Show）。

因為你只有字幕（沒有實際影片），你必須從語言節奏、語速、內容來推斷可能的視覺策略。

請回傳以下 JSON 格式（不要加 markdown 標記）：
{
  "hook_analysis": "影片如何開場？前 2-3 秒使用了什麼吸引注意力的技巧？",
  "pain_analysis": "影片揭露了哪些痛點或問題？如何讓觀眾感受到問題的嚴重性？",
  "show_analysis": "影片如何呈現/展示產品？展示了什麼證據或轉變？",
  "flow_summary": "用 2-3 句話總結整體廣告流程：Hook → 痛點 → 展示 → CTA。這支影片為什麼有效？",
  "visual_inference": "根據字幕節奏，推斷可能使用了什麼鏡頭運動、場景設定和視覺轉場？"
}

規則：
- 回答必須使用繁體中文。
- 具體且可執行，不要泛泛而談。
- 根據字幕的實際內容進行分析。
- 從語速線索推斷視覺（短句 = 快速剪接，長描述 = 慢鏡頭等）。
- 語氣溫暖、有自信、專業。`;

async function runStep1Analysis(controller, transcript, productName, productDesc) {
  sse(controller, 'status', { message: '正在分析影片邏輯...' });

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      temperature: 0.7,
      responseMimeType: 'application/json',
    },
    systemInstruction: STEP1_SYSTEM,
  });

  const prompt = `請分析以下參考影片字幕，用於廣告創作。

產品名稱：${productName}
產品描述：${productDesc}

字幕內容（可能為英文，但請用繁體中文回答）：
${transcript}

請詳細分析影片的成功邏輯（Hook、痛點、展示、整體流程）。所有回答必須使用繁體中文。`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    sse(controller, 'error', { message: 'Gemini 回傳的 JSON 格式無效', raw: text.slice(0, 400) });
    return;
  }

  sse(controller, 'analysis', parsed);
  sse(controller, 'done', { message: '分析完成' });
}

// ──────────────────────────────────────────────────────
//  STEP 2 — 10/10/10 Multimodal Menu
// ──────────────────────────────────────────────────────

const STEP2_SYSTEM = `你是一位世界級的短影片廣告策略師。
目標受眾：30–55 歲。
品牌語氣（3ZeBra）：溫暖、有自信、以好處為先。口語化且真實。

限制：
- 禁止虛假宣稱、禁止醫療/臨床術語、禁止年輕人網路用語。
- 保持誠實、務實、合規。

請生成恰好 30 個創意「積木」，分為 3 個類別，每類 10 個。

請回傳以下 JSON 格式（不要加 markdown 標記）：
{
  "hooks": [
    {
      "id": "H1",
      "visual": "畫面內容：詳細描述鏡頭角度、運動方式和具體動作。",
      "voiceover": "口播內容：實際要說的開場台詞。",
      "text_overlay": "字卡設計：螢幕上顯示的文字。"
    }
  ],
  "pains": [
    {
      "id": "P1",
      "visual": "畫面內容：痛點場景的鏡頭角度、運動方式和具體動作。",
      "voiceover": "口播內容：揭露痛點的實際台詞。",
      "text_overlay": "字卡設計：螢幕上顯示的文字。"
    }
  ],
  "shows": [
    {
      "id": "S1",
      "visual": "畫面內容：產品展示的鏡頭角度、運動方式和具體動作。",
      "voiceover": "口播內容：展示產品的實際台詞。",
      "text_overlay": "字卡設計：螢幕上顯示的文字。"
    }
  ]
}

規則：
- 每個類別必須恰好有 10 個項目（H1-H10、P1-P10、S1-S10）。
- 每個項目必須包含所有 3 個欄位：visual、voiceover、text_overlay。
- "visual" 描述鏡頭角度、運動方式、場景設定和具體的畫面動作。
- "voiceover" 是實際要說的台詞（口語化、自然、真實）。
- "text_overlay" 是這個節拍中螢幕上顯示的文字/圖形。
- 每個項目必須獨特 — 不可重複。
- 有參考影片分析時，需模仿其風格和邏輯。
- 所有內容必須使用繁體中文。`;

async function runStep2Menu(controller, contextText) {
  sse(controller, 'status', { message: '正在生成 10/10/10 創意選單...' });

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      temperature: 0.9,
      responseMimeType: 'application/json',
    },
    systemInstruction: STEP2_SYSTEM,
  });

  const result = await model.generateContent(contextText);
  const text = result.response.text();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    sse(controller, 'error', { message: 'Gemini 回傳的 10/10/10 JSON 格式無效', raw: text.slice(0, 400) });
    return;
  }

  for (const key of ['hooks', 'pains', 'shows']) {
    if (!Array.isArray(parsed[key]) || parsed[key].length === 0) {
      sse(controller, 'error', { message: `回應中缺少或為空的欄位：「${key}」` });
      return;
    }
  }

  sse(controller, 'result', parsed);
  sse(controller, 'done', { message: '10/10/10 生成完成' });
}

// ──────────────────────────────────────────────────────
//  STEP 3 — Final Assembly
// ──────────────────────────────────────────────────────

const STEP3_SYSTEM = `你是一位短影片廣告剪輯師，正在組裝最終的製作腳本。
目標受眾：30–55 歲。
品牌語氣（3ZeBra）：溫暖、有自信、以好處為先。口語化且真實。

限制：
- 禁止虛假宣稱、禁止醫療/臨床術語、禁止年輕人網路用語。
- 影片總長度：嚴格控制在 25–35 秒。
- 每個節拍間隔為 15–20 秒。

你會收到用戶選擇的創意積木（鉤子、痛點、展示）。
請將它們編織成一個完整、流暢的廣告腳本。

請回傳以下 JSON 格式（不要加 markdown 標記）：
{
  "script": [
    {
      "time": "0:00–0:05",
      "visual": "螢幕上顯示的詳細畫面描述。",
      "voiceover": "實際的口播台詞。",
      "text_overlay": "螢幕上顯示的文字/圖形。"
    }
  ],
  "total_duration": "30 秒"
}

規則：
- 腳本必須自然流暢，像一支完整的影片 — 不是拼湊的片段。
- 用最強的鉤子開場。
- 中段用痛點製造緊張感。
- 結尾用最好的產品展示 / CTA 收尾。
- 畫面描述必須具體：鏡頭角度、場景設定、轉場、字卡。
- 口播必須像真人在說話 — 溫暖、有自信，不像在念廣告稿。
- 字卡應強化重點但不重複口播內容。
- 嚴格控制在 25–35 秒。
- 所有內容必須使用繁體中文。`;

async function runStep3Assembly(controller, body) {
  sse(controller, 'status', { message: '正在組裝最終腳本...' });

  const selectedHooks = (body.hooks || []).map(h =>
    `[${h.id}] 畫面: ${h.visual} | 口播: ${h.voiceover} | 字卡: ${h.text_overlay}`
  ).join('\n');
  const selectedPains = (body.pains || []).map(p =>
    `[${p.id}] 畫面: ${p.visual} | 口播: ${p.voiceover} | 字卡: ${p.text_overlay}`
  ).join('\n');
  const selectedShows = (body.shows || []).map(s =>
    `[${s.id}] 畫面: ${s.visual} | 口播: ${s.voiceover} | 字卡: ${s.text_overlay}`
  ).join('\n');

  const prompt = `請從以下選定的創意積木組裝最終廣告腳本：

產品名稱：${body.productName || '產品'}
產品描述：${body.productDesc || ''}

已選鉤子（影片鉤子）：
${selectedHooks || '未選擇'}

已選痛點（痛點分鏡）：
${selectedPains || '未選擇'}

已選展示（展示分鏡）：
${selectedShows || '未選擇'}

參考分析：
${body.analysisContext || '無參考分析'}

請組裝一個 25-35 秒的完整廣告腳本。用最強的鉤子開場，用痛點製造緊張感，用產品展示收尾。所有內容必須使用繁體中文。`;

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      temperature: 0.7,
      responseMimeType: 'application/json',
    },
    systemInstruction: STEP3_SYSTEM,
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    sse(controller, 'error', { message: 'Gemini 回傳的最終腳本 JSON 格式無效', raw: text.slice(0, 400) });
    return;
  }

  if (!Array.isArray(parsed.script) || parsed.script.length === 0) {
    sse(controller, 'error', { message: '回傳的腳本為空' });
    return;
  }

  sse(controller, 'result', parsed);
  sse(controller, 'done', { message: '腳本組裝完成' });
}

// ──────────────────────────────────────────────────────
//  HANDLER
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
  const step = url.searchParams.get('step');

  const sseHeaders = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  };

  const corsJson = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  // ── STEP 1: Analyze reference video ──
  if (step === '1') {
    const videoUrl = url.searchParams.get('url');
    const productName = url.searchParams.get('product') || '';
    const productDesc = url.searchParams.get('desc') || '';

    if (!videoUrl) {
      return new Response(JSON.stringify({ error: '缺少 ?url= 參數' }), { status: 400, headers: corsJson });
    }

    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
      return new Response(JSON.stringify({ error: '無效的 YouTube 網址' }), { status: 400, headers: corsJson });
    }

    const stream = new ReadableStream({
      async start(controller) {
        try {
          sse(controller, 'status', { message: '正在抓取字幕...' });

          let transcript = '';

          try {
            const transcriptRes = await fetch(
              `https://api.supadata.ai/v1/youtube/transcript?url=https://www.youtube.com/watch?v=${videoId}&text=true`,
              { headers: { 'x-api-key': process.env.SUPADATA_API_KEY } }
            );

            if (transcriptRes.ok) {
              const transcriptData = await transcriptRes.json();
              transcript = transcriptData.content || '';
            }
          } catch {
            // Supadata 請求失敗
          }

          if (!transcript || transcript.length < 20) {
            // 無可用字幕 — 回傳錯誤讓前端觸發手動輸入表單
            sse(controller, 'error', {
              status: 'error',
              message: 'TRANSCRIPT_NOT_FOUND',
              fallback: true,
            });
            controller.close();
            return;
          }

          sse(controller, 'status', { message: `取得字幕 (${transcript.length} 字元)，開始分析...` });
          sse(controller, 'transcript', { content: transcript });

          await runStep1Analysis(controller, transcript, productName, productDesc);
        } catch (err) {
          sse(controller, 'error', { message: err.message || '發生未預期的錯誤' });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, { headers: sseHeaders });
  }

  // ── STEP 2: Generate 10/10/10 menu ──
  if (step === '2') {
    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: '無效的 JSON 格式' }), { status: 400, headers: corsJson });
    }

    const stream = new ReadableStream({
      async start(controller) {
        try {
          let contextText;

          if (body.transcript && body.analysis) {
            // 有影片分析的路徑
            contextText = `請為以下產品廣告生成 10/10/10 創意分解。

產品名稱：${body.productName || '未知'}
產品描述：${body.productDesc || '無'}

參考影片字幕（可能為英文，但請用繁體中文生成所有內容）：
${body.transcript}

參考邏輯分析：
鉤子策略：${body.analysis.hook_analysis || ''}
痛點策略：${body.analysis.pain_analysis || ''}
展示策略：${body.analysis.show_analysis || ''}
整體流程：${body.analysis.flow_summary || ''}
視覺推斷：${body.analysis.visual_inference || ''}

請模仿參考影片的風格和邏輯，為此產品量身打造 10 個鉤子、10 個痛點、10 個展示。所有內容必須使用繁體中文。`;
          } else {
            // 手動輸入路徑（無影片參考）
            contextText = `請為以下產品廣告生成 10/10/10 創意分解。
你沒有參考影片。請運用你對高轉換率廣告的知識來創作。

產品名稱：${body.productName || '未知'}
產品類型：${body.productType || '無'}
核心賣點（「Magic Moment」）：${body.coreBenefit || '無'}
目標受眾：${body.targetAudience || '30-55 歲'}

請為此產品量身打造 10 個鉤子、10 個痛點、10 個展示。
根據「${body.productType || '一般'}」品類、針對${body.targetAudience || '30-55 歲'}受眾的高轉換率廣告模式來創作。所有內容必須使用繁體中文。`;
          }

          await runStep2Menu(controller, contextText);
        } catch (err) {
          sse(controller, 'error', { message: err.message || '發生未預期的錯誤' });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, { headers: sseHeaders });
  }

  // ── STEP 3: Final assembly ──
  if (step === '3') {
    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: '無效的 JSON 格式' }), { status: 400, headers: corsJson });
    }

    const stream = new ReadableStream({
      async start(controller) {
        try {
          await runStep3Assembly(controller, body);
        } catch (err) {
          sse(controller, 'error', { message: err.message || '發生未預期的錯誤' });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, { headers: sseHeaders });
  }

  return new Response(JSON.stringify({ error: '未知的步驟。請使用 ?step=1、?step=2 或 ?step=3' }), {
    status: 400,
    headers: corsJson,
  });
}
