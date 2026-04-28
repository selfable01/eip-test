const {
  sse, sseHeaders, setCors, runAnalysis,
} = require('../lib/pipeline');

// Browser sends Gemini file URI + mimeType after uploading directly to Gemini
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST method' });
  }

  const { fileUri, mimeType } = req.body || {};

  if (!fileUri) {
    return res.status(400).json({ error: 'Missing fileUri' });
  }

  sseHeaders(res);

  try {
    sse(res, 'status', { step: 2, message: '檔案已就緒，開始分析...' });

    const geminiFile = { uri: fileUri, mimeType: mimeType || 'video/mp4' };

    await runAnalysis(res, geminiFile);
  } catch (err) {
    sse(res, 'error', {
      message: '分析失敗：請確認影片中有清楚的產品展示。',
      detail: err.message,
    });
  } finally {
    res.end();
  }
};
