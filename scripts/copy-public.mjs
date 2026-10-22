import { copyFile, mkdir } from 'node:fs/promises';
await mkdir('dist/public', { recursive: true });
await Promise.all(['index.html', 'style.css'].map(file => copyFile(`client/${file}`, `dist/public/${file}`)));
