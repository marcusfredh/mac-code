// Image attachments on repo notes: pure validation helpers.
//
// No Electron, no I/O, so it is unit-testable. main.js owns the folder in userData and
// the file reads and writes; this module only decides which ids, extensions, file names
// and bytes are acceptable. File names are always `${id}.${ext}`, built from parts that
// passed these checks — never from anything the renderer sends as a whole name.
'use strict';

const ID_RE = /^[a-z0-9-]{8,40}$/;
const NAME_RE = /^[a-z0-9-]{8,40}\.(png|jpg|gif|webp)$/;
const EXTS = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const MAX_BYTES = 10 * 1024 * 1024;

function isValidId(id) { return typeof id === 'string' && ID_RE.test(id); }
function isValidExt(ext) { return typeof ext === 'string' && Object.prototype.hasOwnProperty.call(EXTS, ext); }

// image/jpeg -> 'jpg'; null for anything not in EXTS.
function extForMediaType(mediaType) {
  if (typeof mediaType !== 'string') return null;
  for (const [ext, mt] of Object.entries(EXTS)) if (mt === mediaType) return ext;
  return null;
}

// { id, ext } from the renderer -> 'id.ext', or null when either part is invalid.
function imageFileName(ref) {
  if (!ref || typeof ref !== 'object') return null;
  if (!isValidId(ref.id) || !isValidExt(ref.ext)) return null;
  return ref.id + '.' + ref.ext;
}

function isImageFileName(name) { return typeof name === 'string' && NAME_RE.test(name); }

function startsWith(buf, bytes, offset = 0) {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[offset + i] !== bytes[i]) return false;
  return true;
}
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));

// Do the leading bytes match the declared extension?
function magicMatches(buf, ext) {
  if (!Buffer.isBuffer(buf)) return false;
  switch (ext) {
    case 'png': return startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'jpg': return startsWith(buf, [0xff, 0xd8, 0xff]);
    case 'gif': return startsWith(buf, ascii('GIF87a')) || startsWith(buf, ascii('GIF89a'));
    case 'webp': return startsWith(buf, ascii('RIFF')) && startsWith(buf, ascii('WEBP'), 8);
    default: return false;
  }
}

// Validate a save request. -> { ok:true, ext, buf } | { ok:false, error }
function checkImageData(base64, mediaType) {
  const ext = extForMediaType(mediaType);
  if (!ext) return { ok: false, error: 'unsupported image type' };
  if (typeof base64 !== 'string') return { ok: false, error: 'invalid image data' };
  const buf = Buffer.from(base64, 'base64');
  if (buf.length === 0) return { ok: false, error: 'empty image' };
  if (buf.length > MAX_BYTES) return { ok: false, error: 'image is too large (max 10 MB)' };
  if (!magicMatches(buf, ext)) return { ok: false, error: 'image data does not match its type' };
  return { ok: true, ext, buf };
}

module.exports = {
  ID_RE, NAME_RE, EXTS, MAX_BYTES,
  isValidId, isValidExt, extForMediaType, imageFileName, isImageFileName, magicMatches, checkImageData
};
