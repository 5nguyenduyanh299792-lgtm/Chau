import { defineConfig, Plugin } from 'vite';
import { parseRoomCostWithAI } from './src/server/ai.js';

function aiApiPlugin(): Plugin {
  const handler = async (req: any, res: any) => {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }

    let body = '';
    req.on('data', (chunk: any) => {
      body += chunk;
    });

    req.on('end', async () => {
      try {
        const { text, currentMonth, currentYear } = JSON.parse(body || '{}');
        if (!text || typeof text !== 'string' || !text.trim()) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Vui lòng cung cấp nội dung hoặc nói để AI phân tích.' }));
          return;
        }

        const result = await parseRoomCostWithAI(text, currentMonth, currentYear);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      } catch (err: any) {
        console.error('API /api/ai-fill error:', err);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: err?.message || 'Lỗi khi gọi Gemini API' }));
      }
    });
  };

  return {
    name: 'ai-api-plugin',
    configureServer(server) {
      server.middlewares.use('/api/ai-fill', handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/ai-fill', handler);
    },
  };
}

export default defineConfig({
  plugins: [aiApiPlugin()],
  server: {
    port: 3000,
    host: '0.0.0.0',
    hmr: process.env.DISABLE_HMR !== 'true',
  },
  preview: {
    port: 3000,
    host: '0.0.0.0',
  },
});
