import { storeProjectDirect } from './library.mjs';

self.onmessage = async ({ data }) => {
  try { await storeProjectDirect(data); self.postMessage({ ok: true }); }
  catch (error) { self.postMessage({ ok: false, message: error.message }); }
};
