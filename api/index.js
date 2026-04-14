export const config = { runtime: 'edge' };

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1);
    if (u.hostname.includes('youtube.com')) return u.searchParams.get('v');
  } catch {
    return null;
  }
  return null;
}

function buildIntervals(totalSeconds) {
  const intervals = [];
  let start = 0;
  while (start < totalSeconds) {
    const remaining = totalSeconds - start;
    let duration;
    if (remaining <= 20) {
      duration = remaining;
    } else if (remaining < 35) {
      duration = Math.ceil(remaining / 2);
    } else {
      duration = 15 + Math.floor(Math.random() * 6); // 15-20
    }
    const end = start + duration;
    intervals.push({ start, end: Math.min(end, totalSeconds) });
    start = Math.min(end, totalSeconds);
  }
  return intervals;
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function assignTranscriptToIntervals(transcript, intervals) {
  const lines = Array.isArray(transcript) ? transcript : [];
  return intervals.map(({ start, end }) => {
    const matched = lines.filter(
      (l) => l.offset != null && l.offset / 1000 >= start && l.offset / 1000 < end
    );
    return {
      time: `${formatTime(start)}-${formatTime(end)}`,
      startSec: start,
      endSec: end,
      voiceover: matched.map((l) => l.text).join(' ').trim() || '[no dialogue in this segment]',
    };
  });
}

function sse(controller, event, data) {
  const encoder = new TextEncoder();
  controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

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

  const SUPADATA_API_KEY = process.env.SUPADATA_API_KEY;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // --- Step 1: Fetch transcript from Supadata ---
        sse(controller, 'status', { step: 'transcript', message: 'Fetching transcript via Supadata...' });

        const transcriptRes = await fetch(
          `https://api.supadata.ai/v1/youtube/transcript?url=https://www.youtube.com/watch?v=${videoId}&text=false`,
          { headers: { 'x-api-key': SUPADATA_API_KEY } }
        );

        if (!transcriptRes.ok) {
          const err = await transcriptRes.text();
          sse(controller, 'error', { message: `Supadata error: ${err}` });
          controller.close();
          return;
        }

        const transcriptData = await transcriptRes.json();
        const lines = transcriptData.content || transcriptData || [];

        if (!Array.isArray(lines) || lines.length === 0) {
          sse(controller, 'error', { message: 'No transcript data returned' });
          controller.close();
          return;
        }

        sse(controller, 'status', { step: 'transcript_done', message: `Got ${lines.length} transcript segments` });

        // --- Step 2: Calculate total duration and build 15-20s intervals ---
        const lastLine = lines[lines.length - 1];
        const totalMs = (lastLine.offset || 0) + (lastLine.dur || 3000);
        const totalSeconds = Math.ceil(totalMs / 1000);
        const intervals = buildIntervals(totalSeconds);
        const segments = assignTranscriptToIntervals(lines, intervals);

        sse(controller, 'status', {
          step: 'intervals',
          message: `Built ${segments.length} intervals across ${formatTime(totalSeconds)}`,
          intervals: segments.map((s) => s.time),
        });

        // --- Step 3: Send to Gemini 2.5 Flash for visual inference ---
        sse(controller, 'status', { step: 'gemini', message: 'Sending to Gemini 2.5 Flash for visual & copy generation...' });

        const segmentBlock = segments
          .map(
            (s, i) =>
              `Segment ${i + 1} [${s.time}]:\nVoiceover: "${s.voiceover}"`
          )
          .join('\n\n');

        const geminiPrompt = `You are a viral video strategist and storyboard director.

Given a YouTube transcript broken into timed segments, produce a JSON object with:

1. "viral_logic": A short paragraph explaining why this content has viral potential and the psychological hooks at play.
2. "product_copy": A punchy 1-2 sentence marketing tagline for the video.
3. "storyboard": An array where each element corresponds to one of the segments below. Each element must have:
   - "time": The exact timestamp range provided.
   - "visual": A detailed, vivid description (2-3 sentences) of what should appear on screen — camera angles, graphics, text overlays, transitions, b-roll ideas. Be specific and cinematic.
   - "voiceover": The exact transcript text provided for that segment.

CRITICAL RULES:
- The storyboard array MUST have exactly ${segments.length} elements, one per segment.
- Each element's "time" field MUST match the timestamp range given.
- Do NOT merge, split, or skip any segments.
- Output ONLY valid JSON, no markdown fences, no explanation outside the JSON.

Here are the ${segments.length} segments:

${segmentBlock}`;

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: geminiPrompt }] }],
              generationConfig: {
                temperature: 0.7,
                responseMimeType: 'application/json',
              },
            }),
          }
        );

        if (!geminiRes.ok) {
          const err = await geminiRes.text();
          sse(controller, 'error', { message: `Gemini error: ${err}` });
          controller.close();
          return;
        }

        const geminiData = await geminiRes.json();

        const rawText =
          geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';

        sse(controller, 'status', { step: 'parsing', message: 'Parsing Gemini response...' });

        let result;
        try {
          result = JSON.parse(rawText);
        } catch {
          sse(controller, 'error', { message: 'Failed to parse Gemini JSON output', raw: rawText.slice(0, 500) });
          controller.close();
          return;
        }

        // --- Step 4: Validate storyboard intervals ---
        if (result.storyboard && Array.isArray(result.storyboard)) {
          result.storyboard = result.storyboard.map((item, i) => ({
            ...item,
            time: segments[i]?.time || item.time,
            voiceover: segments[i]?.voiceover || item.voiceover,
          }));
        }

        // --- Step 5: Stream final result ---
        sse(controller, 'result', result);
        sse(controller, 'done', { message: 'Storyboard generation complete' });
      } catch (err) {
        sse(controller, 'error', { message: err.message || 'Unexpected error' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
