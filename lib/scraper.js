const axios = require("axios");


async function askDeepSeek(msg) {
  const html = await axios.get('https://deep-seek.ai/chat', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/150' }
  });
  
  const cookies = {};
  (html.headers['set-cookie'] || []).forEach(c => {
    const [k, v] = c.split(';')[0].split('=');
    if (k && v) cookies[k.trim()] = v.trim();
  });

  const $ = cheerio.load(html.data);
  let csrf = $('meta[name="csrf-token"]').attr('content') || cookies['XSRF-TOKEN'];
  if (!csrf) {
    const script = $('script').toArray().find(s => $(s).html().includes('csrfToken'));
    csrf = script ? $(script).html().match(/csrfToken["']?\s*[:=]\s*["']([^"']+)["']/)?.[1] : null;
  }
  if (!csrf) throw new Error('No CSRF token');

  // Kirim request
  const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const payload = { model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: msg }] };

  const res = await axios({
    method: 'POST',
    url: 'https://deep-seek.ai/api/chat',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/150',
      'Content-Type': 'application/json',
      'Cookie': cookieStr,
      'X-CSRF-Token': csrf,
      'Origin': 'https://deep-seek.ai',
      'Referer': 'https://deep-seek.ai/chat'
    },
    data: payload,
    responseType: 'stream',
    timeout: 120000
  });

  let answer = '', buffer = '';
  return new Promise((resolve, reject) => {
    res.data.on('data', chunk => {
      buffer += chunk.toString();
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const p of parts) {
        for (const line of p.split('\n')) {
          if (line.startsWith('data: ')) {
            const json = line.slice(6).trim();
            if (json === '[DONE]') continue;
            try {
              const d = JSON.parse(json);
              if (d.choices?.[0]?.delta?.content) answer += d.choices[0].delta.content;
              if (d.choices?.[0]?.finish_reason === 'stop') resolve(answer);
            } catch (_) {}
          }
        }
      }
    });
    res.data.on('end', () => resolve(answer));
    res.data.on('error', reject);
  });
}

module.exports = { askDeepSeek };
