const { sse, sseHeaders, setCors, runGenerateMenu } = require('../lib/pipeline');

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST method' });
  }

  const body = req.body;
  if (!body || !body.productName) {
    return res.status(400).json({ error: '請提供產品名稱' });
  }

  sseHeaders(res);

  try {
    await runGenerateMenu(res, body);
  } catch (err) {
    sse(res, 'error', {
      message: '生成失敗，請重試。',
      detail: err.message,
    });
  } finally {
    res.end();
  }
};
