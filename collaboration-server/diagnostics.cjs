const { appendFile, rename, rm, stat } = require('node:fs/promises');

function createDiagnostics(path, { maxBytes = 1024 * 1024, archives = 3 } = {}) {
  let pending = Promise.resolve(), size;
  return {
    write(entry) {
      const line = JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n';
      pending = pending.then(async () => {
        size ??= await stat(path).then(info => info.size, () => 0);
        const bytes = Buffer.byteLength(line);
        if (size && size + bytes > maxBytes) {
          await rm(path + '.' + archives, { force: true });
          for (let index = archives - 1; index >= 1; index--) await rename(path + '.' + index, path + '.' + (index + 1)).catch(error => { if (error.code !== 'ENOENT') throw error; });
          await rename(path, path + '.1'); size = 0;
        }
        await appendFile(path, line); size += bytes;
      }).catch(() => {});
    },
    flush() { return pending; },
  };
}
module.exports = { createDiagnostics };
