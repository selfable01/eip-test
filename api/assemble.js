const { sse, sseHeaders, setCors, runAssemble } = require('../lib/pipeline');

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST method' });
  }

  const body = req.body;
  if (!body || (!body.hooks?.length && !body.pains?.length && !body.shows?.length)) {
    return res.status(400).json({ error: '請至少選擇一個項目' });
  }

  sseHeaders(res);

  try {
    await runAssemble(res, body);
  } catch (err) {
    sse(res, 'error', {
      message: '腳本生成失敗，請重試。',
      detail: err.message,
    });
  } finally {
    res.end();
  }
};
