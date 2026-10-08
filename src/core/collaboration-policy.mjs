export function collaborationConnectSources(additionalOrigins = '') {
  const sources = new Set(["'self'", 'ws:', 'wss:', 'http://127.0.0.1:*/collab/media/', 'http://localhost:*/collab/media/', 'https://*.trycloudflare.com/collab/media/']);
  for (const value of additionalOrigins.split(/[\s,]+/).filter(Boolean)) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.hostname.includes('*')) throw new Error('RPE_MEDIA_ORIGINS 只能填写明确的 HTTP/HTTPS 源地址');
    sources.add(`${url.origin}/collab/media/`);
  }
  return [...sources].join(' ');
}
