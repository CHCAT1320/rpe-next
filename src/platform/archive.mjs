const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_BYTES = 256 * 1024 * 1024;
const crcTable = Uint32Array.from({ length: 256 }, (unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function checkPath(name) {
  if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0') || name.includes(':') || name.split('/').includes('..')) {
    throw new Error(`ZIP 包含不安全路径：${name}`);
  }
}

export async function readZip(buffer) {
  if (buffer.byteLength > MAX_BYTES) throw new Error('压缩包超过 256 MiB 限制');
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let trailer = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) { trailer = offset; break; }
  }
  if (trailer < 0) throw new Error('无效 ZIP/PEZ 目录');
  const count = view.getUint16(trailer + 10, true);
  if (view.getUint16(trailer + 4, true) || view.getUint16(trailer + 6, true) || count > 10000) throw new Error('不支持分卷、ZIP64 或超过 10000 个文件的包');
  const files = new Map();
  let offset = view.getUint32(trailer + 16, true);
  let totalSize = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > trailer || view.getUint32(offset, true) !== 0x02014b50) throw new Error('ZIP 目录损坏');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const checksum = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameSize = view.getUint16(offset + 28, true);
    const extraSize = view.getUint16(offset + 30, true);
    const commentSize = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    if (flags & 1 || size === 0xffffffff || compressedSize === 0xffffffff) throw new Error('不支持加密 ZIP 或 ZIP64');
    totalSize += size;
    if (totalSize > MAX_BYTES) throw new Error('解压后总大小超过 256 MiB 限制');
    if (offset + 46 + nameSize + extraSize + commentSize > trailer) throw new Error('ZIP 文件名越界');
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameSize);
    const name = (flags & 0x800 ? decoder : new TextDecoder('gb18030')).decode(nameBytes);
    checkPath(name);
    if (files.has(name)) throw new Error(`ZIP 重复文件名：${name}`);
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('ZIP 文件头损坏');
    const dataOffset = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    if (dataOffset + compressedSize > offset) throw new Error('ZIP 文件内容越界');
    let contents = bytes.slice(dataOffset, dataOffset + compressedSize);
    if (method === 8) {
      const reader = new Blob([contents]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
      const chunks = [];
      let length = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > size) { await reader.cancel(); throw new Error('ZIP 解压大小与目录不一致'); }
        chunks.push(chunk.value);
      }
      contents = new Uint8Array(length);
      let cursor = 0;
      for (const chunk of chunks) { contents.set(chunk, cursor); cursor += chunk.length; }
    } else if (method !== 0) throw new Error(`不支持 ZIP 压缩方式 ${method}`);
    if (contents.length !== size || crc32(contents) !== checksum) throw new Error(`ZIP 校验失败：${name}`);
    files.set(name, contents);
    offset += 46 + nameSize + extraSize + commentSize;
  }
  return files;
}

export function writeZip(files) {
  if (files.size > 10000) throw new Error('文件数量超出限制');
  const records = [];
  const directories = [];
  let offset = 0;
  for (const [name, contents] of files) {
    checkPath(name);
    const nameBytes = encoder.encode(name);
    if (nameBytes.length > 65535) throw new Error('ZIP 文件名过长');
    const record = new Uint8Array(30 + nameBytes.length + contents.length);
    const view = new DataView(record.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x800, true);
    view.setUint32(14, crc32(contents), true);
    view.setUint32(18, contents.length, true);
    view.setUint32(22, contents.length, true);
    view.setUint16(26, nameBytes.length, true);
    record.set(nameBytes, 30);
    record.set(contents, 30 + nameBytes.length);
    const directory = new Uint8Array(46 + nameBytes.length);
    const central = new DataView(directory.buffer);
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    directory.set(record.subarray(4, 30), 6);
    central.setUint32(42, offset, true);
    directory.set(nameBytes, 46);
    records.push(record);
    directories.push(directory);
    offset += record.length;
    if (offset > MAX_BYTES) throw new Error('导出包超过 256 MiB 限制');
  }
  const trailer = new Uint8Array(22);
  const view = new DataView(trailer.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, files.size, true);
  view.setUint16(10, files.size, true);
  view.setUint32(12, directories.reduce((total, entry) => total + entry.length, 0), true);
  view.setUint32(16, offset, true);
  return new Blob([...records, ...directories, trailer], { type: 'application/zip' });
}
