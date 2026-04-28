const { setCors } = require('../lib/pipeline');

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  res.json({ apiKey: process.env.GEMINI_API_KEY });
};
