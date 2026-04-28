const fs = require('fs');
const path = require('path');
const {
  sse, sseHeaders, setCors,
  uploadToGemini, cleanupFile, runPipeline, TEMP_DIR,
} = require('../lib/pipeline');

// Disable Vercel's default body parsing so we can read raw binary
module.exports = handler;
module.exports.config = {
  api: {
    bodyParser: false,
  },
};

async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: '請使用 POST 方法' });
  }

  // Read raw body
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
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
}
