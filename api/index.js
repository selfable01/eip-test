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

const STEP1_SYSTEM = `You are a world-class short-form video ad strategist and creative director.
Your task is to analyze a reference video's transcript and infer its SUCCESS LOGIC — how it hooks, agitates pain, and showcases the product.

Since you only have the transcript (not the actual video), you must INFER the likely visual strategy from the rhythm, pacing, and content of the spoken words.

Return EXACTLY this JSON (no markdown fences):
{
  "hook_analysis": "How does the video open? What pattern-interrupt or attention-grab technique is used in the first 2-3 seconds?",
  "pain_analysis": "What pain points or problems does the video surface? How does it make the viewer feel the problem?",
  "show_analysis": "How does the video present/demonstrate the product? What proof or transformation does it show?",
  "flow_summary": "A 2-3 sentence summary of the overall ad flow: Hook → Pain → Show → CTA. What makes this video effective?",
  "visual_inference": "Based on transcript rhythm, what camera work, settings, and visual transitions are likely used?"
}

RULES:
- Be specific and actionable, not generic.
- Ground your analysis in what the transcript actually says.
- Infer visuals from pacing cues (short sentences = quick cuts, long descriptions = slow pans, etc.)
- Keep language warm, confident, and professional.`;

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

  const prompt = `Analyze this reference video transcript for ad creation purposes.

PRODUCT: ${productName}
PRODUCT DESCRIPTION: ${productDesc}

TRANSCRIPT:
${transcript}

Provide a detailed analysis of the video's success logic (Hook, Pain, Show, Flow).`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    sse(controller, 'error', { message: 'Gemini returned invalid JSON for analysis', raw: text.slice(0, 400) });
    return;
  }

  sse(controller, 'analysis', parsed);
  sse(controller, 'done', { message: 'Analysis complete' });
}

// ──────────────────────────────────────────────────────
//  STEP 2 — 10/10/10 Multimodal Menu
// ──────────────────────────────────────────────────────

const STEP2_SYSTEM = `You are a world-class short-form video ad strategist.
Target audience: 30–55 year olds.
Brand voice (3ZeBra): Warm, confident, benefit-first. Conversational and realistic.

RESTRICTIONS:
- NO false claims, NO clinical/medical jargon, NO Gen-Z slang.
- Keep everything honest, grounded, and compliant.

Generate EXACTLY 30 creative "Lego blocks" for a product ad, organized into 3 categories of 10 each.

Return EXACTLY this JSON (no markdown fences):
{
  "hooks": [
    {
      "id": "H1",
      "visual": "畫面內容: Camera angle, movement, and specific action described in detail.",
      "voiceover": "口播內容: The exact opening line to be spoken.",
      "text_overlay": "字卡設計: What text appears on screen."
    }
  ],
  "pains": [
    {
      "id": "P1",
      "visual": "畫面內容: Camera angle, movement, and specific action for the pain point scene.",
      "voiceover": "口播內容: The exact spoken line that surfaces the pain.",
      "text_overlay": "字卡設計: What text appears on screen."
    }
  ],
  "shows": [
    {
      "id": "S1",
      "visual": "畫面內容: Camera angle, movement, and specific action for the product display.",
      "voiceover": "口播內容: The exact spoken line showcasing the product.",
      "text_overlay": "字卡設計: What text appears on screen."
    }
  ]
}

RULES:
- Each category MUST have exactly 10 items (H1-H10, P1-P10, S1-S10).
- Each item MUST have all 3 fields: visual, voiceover, text_overlay.
- "visual" describes camera angle, movement, setting, and specific on-screen action.
- "voiceover" is the actual spoken line (conversational, natural, realistic).
- "text_overlay" is what text/graphics appear on screen during this beat.
- Every item must be DISTINCT — no repetition across items.
- Mirror the reference video's style and logic when analysis is provided.
- All content should be in the same language as the product description.`;

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
    sse(controller, 'error', { message: 'Gemini returned invalid JSON for 10/10/10', raw: text.slice(0, 400) });
    return;
  }

  for (const key of ['hooks', 'pains', 'shows']) {
    if (!Array.isArray(parsed[key]) || parsed[key].length === 0) {
      sse(controller, 'error', { message: `Missing or empty "${key}" in response` });
      return;
    }
  }

  sse(controller, 'result', parsed);
  sse(controller, 'done', { message: '10/10/10 complete' });
}

// ──────────────────────────────────────────────────────
//  STEP 3 — Final Assembly
// ──────────────────────────────────────────────────────

const STEP3_SYSTEM = `You are a short-form video ad editor assembling a final production script.
Target audience: 30–55 year olds.
Brand voice (3ZeBra): Warm, confident, benefit-first. Conversational and realistic.

RESTRICTIONS:
- NO false claims, NO clinical/medical jargon, NO Gen-Z slang.
- Total video length: STRICTLY 25–35 seconds.
- Each beat should be 15–20 seconds interval.

You will receive selected creative blocks (Hooks, Pain Points, Product Displays).
Weave them into ONE cohesive, flowing ad script.

Return EXACTLY this JSON (no markdown fences):
{
  "script": [
    {
      "time": "0:00–0:05",
      "visual": "Detailed description of what appears on screen.",
      "voiceover": "The exact spoken script.",
      "text_overlay": "Text/graphics that appear on screen."
    }
  ],
  "total_duration": "30 seconds"
}

RULES:
- The script must flow naturally as ONE cohesive video — not a collage of disconnected beats.
- Open with the strongest hook.
- Build tension with pain points in the middle.
- Close with the best product display / CTA.
- Visuals must be specific: camera angles, settings, transitions, text overlays.
- Voiceover must sound like a real person talking — warm, confident, not an ad read.
- Text overlays should reinforce key points without being redundant.
- STRICTLY 25–35 seconds total.
- All content should match the language of the selected blocks.`;

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

  const prompt = `Assemble a final ad script from these selected creative blocks:

PRODUCT: ${body.productName || 'Product'}
DESCRIPTION: ${body.productDesc || ''}

SELECTED HOOKS (影片鉤子):
${selectedHooks || 'None selected'}

SELECTED PAIN POINTS (痛點分鏡):
${selectedPains || 'None selected'}

SELECTED PRODUCT DISPLAYS (展示分鏡):
${selectedShows || 'None selected'}

REFERENCE ANALYSIS:
${body.analysisContext || 'No reference analysis available'}

Create a cohesive 25-35 second ad script. Use the best hook to open, pain points for tension, and product displays to close.`;

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
    sse(controller, 'error', { message: 'Gemini returned invalid JSON for final script', raw: text.slice(0, 400) });
    return;
  }

  if (!Array.isArray(parsed.script) || parsed.script.length === 0) {
    sse(controller, 'error', { message: 'Empty script returned' });
    return;
  }

  sse(controller, 'result', parsed);
  sse(controller, 'done', { message: 'Script assembly complete' });
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
      return new Response(JSON.stringify({ error: 'Missing ?url= parameter' }), { status: 400, headers: corsJson });
    }

    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
      return new Response(JSON.stringify({ error: 'Invalid YouTube URL' }), { status: 400, headers: corsJson });
    }

    const stream = new ReadableStream({
      async start(controller) {
        try {
          sse(controller, 'status', { message: '正在抓取字幕...' });

          let transcript = '';
          let transcriptFailed = false;

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
            // Supadata request failed entirely
          }

          if (!transcript || transcript.length < 20) {
            // No usable transcript — return error so frontend triggers manual form
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
          sse(controller, 'error', { message: err.message || 'Unexpected error' });
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
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: corsJson });
    }

    const stream = new ReadableStream({
      async start(controller) {
        try {
          let contextText;

          if (body.transcript && body.analysis) {
            // From video analysis path
            contextText = `Generate a 10/10/10 creative breakdown for this product ad.

PRODUCT: ${body.productName || 'Unknown'}
DESCRIPTION: ${body.productDesc || 'N/A'}

REFERENCE VIDEO TRANSCRIPT:
${body.transcript}

REFERENCE LOGIC ANALYSIS:
Hook Strategy: ${body.analysis.hook_analysis || ''}
Pain Strategy: ${body.analysis.pain_analysis || ''}
Show Strategy: ${body.analysis.show_analysis || ''}
Flow: ${body.analysis.flow_summary || ''}
Visual Inference: ${body.analysis.visual_inference || ''}

Mirror the reference video's style and logic. Generate 10 Hooks, 10 Pain Points, and 10 Product Displays tailored to this product.`;
          } else {
            // Manual product entry path (no video reference)
            contextText = `Generate a 10/10/10 creative breakdown for this product ad.
You have NO reference video. Use your internal knowledge of high-converting ads for this niche to create compelling blocks.

Product Name: ${body.productName || 'Unknown'}
Product Type: ${body.productType || 'N/A'}
Core Benefit (the "Magic Moment"): ${body.coreBenefit || 'N/A'}
Target Audience: ${body.targetAudience || '30-55 year olds'}

Generate 10 Hooks, 10 Pain Points, and 10 Product Displays tailored to this product.
Base your creative direction on proven high-converting ad patterns for the "${body.productType || 'general'}" category targeting ${body.targetAudience || '30-55 year olds'}.`;
          }

          await runStep2Menu(controller, contextText);
        } catch (err) {
          sse(controller, 'error', { message: err.message || 'Unexpected error' });
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
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: corsJson });
    }

    const stream = new ReadableStream({
      async start(controller) {
        try {
          await runStep3Assembly(controller, body);
        } catch (err) {
          sse(controller, 'error', { message: err.message || 'Unexpected error' });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, { headers: sseHeaders });
  }

  return new Response(JSON.stringify({ error: 'Unknown step. Use ?step=1, ?step=2, or ?step=3' }), {
    status: 400,
    headers: corsJson,
  });
}
