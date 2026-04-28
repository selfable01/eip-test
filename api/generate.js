const {
  ensureYtdlp, isSupportedUrl, sse, sseHeaders, setCors,
  downloadVideo, uploadToGemini, cleanupFile, runPipeline,
} = require('../lib/pipeline');

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const videoUrl = req.query.url;

  if (!videoUrl) {
    return res.status(400).json({ error: '缺少 ?url= 參數' });
  }

  if (!isSupportedUrl(videoUrl)) {
    return res.status(400).json({ error: '不支援的網址。請使用 YouTube、Facebook 或 Instagram 連結。' });
  }

  sseHeaders(res);

  let localFilePath = null;

  try {
    sse(res, 'status', { step: 1, message: '正在準備下載工具...' });
    await ensureYtdlp();

    sse(res, 'status', { step: 1, message: '正在下載影片（480p）...' });
    localFilePath = await downloadVideo(videoUrl);

    sse(res, 'status', { step: 2, message: '正在上傳至 Gemini...' });
    const geminiFile = await uploadToGemini(localFilePath);
    sse(res, 'status', { step: 2, message: '檔案已就緒，開始分析...' });

    await runPipeline(res, geminiFile);
  } catch (err) {
    sse(res, 'error', {
      message: '分析失敗：請確認影片網址正確且影片中有清楚的產品展示。',
      detail: err.message,
    });
  } finally {
    if (localFilePath) cleanupFile(localFilePath);
    res.end();
  }
};
