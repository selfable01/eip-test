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
//  STAGE 1  –  Transcript → 10 Hooks / 10 Visuals / 10 CTAs
// ──────────────────────────────────────────────────────

const STAGE1_SYSTEM = `You are a world-class short-form video strategist.
Your tone is conversational, natural, and realistic — like a sharp creative director talking to a friend.

SAFETY RULES (non-negotiable):
- NEVER make medical, health, or scientific claims.
- NEVER use medical jargon or clinical language.
- NEVER promise specific results, cures, or outcomes.
- Keep everything honest, grounded, and compliant.

Given product/video context, produce EXACTLY this JSON (no markdown, no fences):
{
  "hooks": ["... 10 scroll-stopping opening lines ..."],
  "visuals": ["... 10 vivid scene descriptions (what the viewer sees on screen, 1-2 sentences each) ..."],
  "ctas": ["... 10 natural, non-pushy calls to action ..."],
  "context": "A 1-2 sentence summary of the product/content for downstream use."
}

Rules for each:
- Hooks: The first 2-3 seconds. Pattern-interrupt style. Questions, bold statements, relatable moments. No clickbait lies.
- Visuals: Describe camera angles, settings, actions, text overlays. Be specific and cinematic.
- CTAs: Conversational closers. No "BUY NOW" energy. Think "link in bio" casual.
- Every item must be distinct — no repetition.`;

async function runStage1(controller, contextText) {
  sse(controller, 'status', { message: 'Generating 10/10/10 with Gemini...' });

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      temperature: 0.9,
      responseMimeType: 'application/json',
    },
    systemInstruction: STAGE1_SYSTEM,
  });

  const result = await model.generateContent(contextText);
  const text = result.response.text();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    sse(controller, 'error', { message: 'Gemini returned invalid JSON', raw: text.slice(0, 400) });
    return;
  }

  // Validate arrays of 10
  for (const key of ['hooks', 'visuals', 'ctas']) {
    if (!Array.isArray(parsed[key]) || parsed[key].length === 0) {
      sse(controller, 'error', { message: `Missing or empty "${key}" in Gemini response` });
      return;
    }
  }

  sse(controller, 'result', parsed);
  sse(controller, 'done', { message: '10/10/10 complete' });
}

// ──────────────────────────────────────────────────────
//  STAGE 2  –  Selections → Final Timed Storyboard
// ──────────────────────────────────────────────────────

const STAGE2_SYSTEM = `You are a short-form video editor building a final production storyboard.
Tone: conversational, natural, realistic. No hype, no false claims, no medical jargon.

You will receive selected hooks, visuals, and CTAs. Weave them into a timed storyboard of 15-20 second intervals.

Return EXACTLY this JSON (no markdown, no fences):
{
  "storyboard": [
    {
      "time": "0:00-0:15",
      "visual": "Detailed description of what appears on screen during this interval.",
      "voiceover": "The exact spoken script for this interval."
    }
  ]
}

CRITICAL RULES:
- Each interval MUST be 15-20 seconds.
- The storyboard should flow naturally as one cohesive video.
- Open with the strongest hook as the first voiceover.
- Close the final segment with the best CTA.
- Visuals should be specific: camera angles, settings, transitions, text overlays.
- Voiceover must sound like a real person talking — not an ad read.
- Total video length: 45-90 seconds (3-6 intervals). Pick what fits the content best.
- NEVER invent health claims or product promises that weren't in the source material.`;

async function runStage2(controller, body) {
  sse(controller, 'status', { message: 'Building final storyboard...' });

  const prompt = `Here are the selected creative elements:

PRODUCT CONTEXT:
${body.context || 'General product video'}

SELECTED HOOKS:
${(body.hooks || []).map((h, i) => `${i + 1}. ${h}`).join('\n')}

SELECTED VISUALS:
${(body.visuals || []).map((v, i) => `${i + 1}. ${v}`).join('\n')}

SELECTED CTAs:
${(body.ctas || []).map((c, i) => `${i + 1}. ${c}`).join('\n')}

Now produce the timed storyboard. Use the best hook to open, the best CTA to close, and weave the visuals throughout.`;

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      temperature: 0.7,
      responseMimeType: 'application/json',
    },
    systemInstruction: STAGE2_SYSTEM,
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    sse(controller, 'error', { message: 'Gemini returned invalid JSON for storyboard', raw: text.slice(0, 400) });
    return;
  }

  if (!Array.isArray(parsed.storyboard) || parsed.storyboard.length === 0) {
    sse(controller, 'error', { message: 'Empty storyboard returned' });
    return;
  }

  sse(controller, 'result', parsed);
  sse(controller, 'done', { message: 'Storyboard complete' });
}

// ──────────────────────────────────────────────────────
//  HANDLER
// ──────────────────────────────────────────────────────

export default async function handler(req) {
  // CORS preflight
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
  const stage = url.searchParams.get('stage');
  const isFallback = url.searchParams.get('fallback') === 'true';

  const sseHeaders = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  };

  // ── STAGE 1: YouTube URL ──
  if (stage === '1' && !isFallback) {
    const videoUrl = url.searchParams.get('url');
    if (!videoUrl) {
      return new Response(JSON.stringify({ error: 'Missing ?url= parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
      return new Response(JSON.stringify({ error: 'Invalid YouTube URL' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const stream = new ReadableStream({
      async start(controller) {
        try {
          sse(controller, 'status', { message: 'Fetching transcript via Supadata...' });

          const transcriptRes = await fetch(
            `https://api.supadata.ai/v1/youtube/transcript?url=https://www.youtube.com/watch?v=${videoId}&text=true`,
            { headers: { 'x-api-key': process.env.SUPADATA_API_KEY } }
          );

          if (!transcriptRes.ok) {
            const errText = await transcriptRes.text();
            sse(controller, 'error', {
              message: `Transcript fetch failed — use the questionnaire instead.`,
              detail: errText,
              fallback: true,
            });
            controller.close();
            return;
          }

          const transcriptData = await transcriptRes.json();
          const transcript = transcriptData.content || '';

          if (!transcript || transcript.length < 20) {
            sse(controller, 'error', {
              message: 'No usable transcript found — use the questionnaire instead.',
              fallback: true,
            });
            controller.close();
            return;
          }

          sse(controller, 'status', { message: `Got transcript (${transcript.length} chars)` });

          const contextText = `Analyze this YouTube video transcript and generate the 10/10/10 creative breakdown:\n\n${transcript}`;
          await runStage1(controller, contextText);
        } catch (err) {
          sse(controller, 'error', { message: err.message || 'Unexpected error' });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, { headers: sseHeaders });
  }

  // ── STAGE 1: QUESTIONNAIRE FALLBACK ──
  if (stage === '1' && isFallback) {
    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const stream = new ReadableStream({
      async start(controller) {
        try {
          const contextText = `Generate a 10/10/10 creative breakdown for this product:

Product Name: ${body.name || 'Unknown'}
Description: ${body.what || 'N/A'}
Target Audience: ${body.audience || 'General'}
Key Benefits: ${body.benefits || 'N/A'}
Tone: ${body.tone || 'Conversational, natural'}`;

          await runStage1(controller, contextText);
        } catch (err) {
          sse(controller, 'error', { message: err.message || 'Unexpected error' });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, { headers: sseHeaders });
  }

  // ── STAGE 2: BUILD FINAL TABLE ──
  if (stage === '2') {
    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const stream = new ReadableStream({
      async start(controller) {
        try {
          await runStage2(controller, body);
        } catch (err) {
          sse(controller, 'error', { message: err.message || 'Unexpected error' });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, { headers: sseHeaders });
  }

  // ── UNKNOWN STAGE ──
  return new Response(JSON.stringify({ error: 'Unknown stage. Use ?stage=1 or ?stage=2' }), {
    status: 400,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
