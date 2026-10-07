/*
zipfs.js - ZIP indexing and lazy Emscripten MEMFS mounting for the web launcher
Copyright (C) 2026 Xash3D FWGS contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.
*/

// The user's game data arrives as one big ZIP (or a folder). We never unpack it up front:
//   1. readZipIndex() parses only the central directory (a few hundred KiB even for 400+ MiB zips),
//   2. loadPayloads() pulls the *compressed* bytes of the entries we need into memory,
//   3. mountLazy() creates MEMFS file nodes whose `contents` is a getter that inflates the entry
//      synchronously (fflate.inflateSync) the first time the engine reads it.
// `usedBytes` is set up front so stat()/fstat()/lseek(SEEK_END) work without inflating anything.
// Inflated buffers of closed files are kept in a small LRU and dropped when over budget.
//
// Verified against Emscripten 6.0.11 src/lib/libmemfs.js + libfs.js: every MEMFS path that touches
// file data (stream_ops.read/write/mmap/msync, getFileDataAsTypedArray, expand/resizeFileStorage,
// FS.readFile) goes through `node.contents`, getattr only uses `node.usedBytes`, and FS.open/close/
// dupStream call the optional stream_ops.open/close/dup hooks we use for reference counting.
//
// No dependencies: callers pass `inflateSync(src, { out })` (fflate >= 0.8). The same file is used
// by the browser launcher and by the node unit test.

const SIG_EOCD = 0x06054b50;
const SIG_Z64_LOCATOR = 0x07064b50;
const SIG_Z64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const EIO = 29; // Emscripten (WASI) errno values
const MiB = 1024 * 1024;

export class ZipError extends Error {
	constructor(message) {
		super(message);
		this.name = 'ZipError';
	}
}

// ---------------------------------------------------------------------------------------------
// random access readers: { size, read(offset, length) -> Promise<Uint8Array> }

export function blobReader(blob) {
	return {
		size: blob.size,
		async read(offset, length) {
			return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
		},
	};
}

export function bytesReader(bytes) {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	return {
		size: u8.length,
		async read(offset, length) {
			return u8.subarray(offset, offset + length);
		},
	};
}

// ---------------------------------------------------------------------------------------------
// names

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const utf8Loose = new TextDecoder('utf-8');
let cp437Table = null;

function decodeCP437(bytes) {
	if (!cp437Table) {
		const hi = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
		cp437Table = [];
		for (let i = 0; i < 128; i++) cp437Table.push(String.fromCharCode(i));
		for (const ch of hi) cp437Table.push(ch);
	}
	let s = '';
	for (const b of bytes) s += cp437Table[b];
	return s;
}

function decodeName(bytes, utf8Flag) {
	if (utf8Flag) return utf8Loose.decode(bytes);
	// without the language encoding flag the spec says CP437, but plenty of tools write UTF-8 anyway
	try {
		return utf8Strict.decode(bytes);
	} catch {
		return decodeCP437(bytes);
	}
}

// "a\\b/./c/" -> "a/b/c"; returns null for names that try to escape ("..")
export function normalizePath(name) {
	const parts = [];
	for (const seg of name.replace(/\\/g, '/').split('/')) {
		if (seg === '' || seg === '.') continue;
		if (seg === '..') return null;
		parts.push(seg);
	}
	return parts.join('/');
}

function dosDateTimeToMs(dosTime, dosDate) {
	if (!dosDate) return 0;
	return new Date(1980 + (dosDate >> 9), ((dosDate >> 5) & 15) - 1, dosDate & 31,
		dosTime >> 11, (dosTime >> 5) & 63, (dosTime & 31) * 2).getTime();
}

// ---------------------------------------------------------------------------------------------
// central directory

/**
 * Parses the ZIP central directory. Only the tail of the file and the central directory are read.
 * Handles ZIP64 (end records + extended information extra field), UTF-8 names (flag bit 11 and the
 * Info-ZIP unicode path field), backslash separators, archives with a prefix (self-extractors),
 * and data descriptors (sizes always come from the central directory).
 * @returns {Promise<{entries: object[], count: number}>}
 */
export async function readZipIndex(reader) {
	const size = reader.size;
	if (size < 22) throw new ZipError('Not a ZIP archive (file too small)');

	const tailLen = Math.min(size, 0xffff + 22 + 20 + 56);
	const tailOff = size - tailLen;
	const tail = await reader.read(tailOff, tailLen);
	const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

	let eocd = -1;
	for (let i = tail.length - 22; i >= 0; i--) {
		if (tv.getUint32(i, true) === SIG_EOCD && i + 22 + tv.getUint16(i + 20, true) <= tail.length) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new ZipError('Not a ZIP archive (end of central directory record not found)');

	let count = tv.getUint16(eocd + 10, true);
	let cdSize = tv.getUint32(eocd + 12, true);
	let cdOffset = tv.getUint32(eocd + 16, true);
	let cdEnd = tailOff + eocd; // absolute position where the central directory must end

	const loc = eocd - 20;
	if (loc >= 0 && tv.getUint32(loc, true) === SIG_Z64_LOCATOR) {
		const z64Off = Number(tv.getBigUint64(loc + 8, true));
		const z64 = await reader.read(z64Off, 56);
		const zv = new DataView(z64.buffer, z64.byteOffset, z64.byteLength);
		if (z64.length < 56 || zv.getUint32(0, true) !== SIG_Z64_EOCD) {
			if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
				throw new ZipError('Corrupt ZIP64 archive (end of central directory record missing)');
		} else {
			count = Number(zv.getBigUint64(32, true));
			cdSize = Number(zv.getBigUint64(40, true));
			cdOffset = Number(zv.getBigUint64(48, true));
			cdEnd = z64Off;
		}
	} else if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
		throw new ZipError('Corrupt ZIP64 archive (locator missing)');
	}

	// > 0 when something was prepended to the archive (SFX stub), offsets are relative to the zip start
	const bias = cdEnd - cdSize - cdOffset;
	if (bias < 0 || cdOffset + bias + cdSize > size) throw new ZipError('Corrupt ZIP archive (bad central directory location)');

	const cd = await reader.read(cdOffset + bias, cdSize);
	const v = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
	const entries = [];
	let p = 0;
	for (let n = 0; n < count; n++) {
		if (p + 46 > cd.length || v.getUint32(p, true) !== SIG_CENTRAL)
			throw new ZipError(`Corrupt ZIP central directory (entry ${n} of ${count})`);
		const flags = v.getUint16(p + 8, true);
		const method = v.getUint16(p + 10, true);
		const dosTime = v.getUint16(p + 12, true);
		const dosDate = v.getUint16(p + 14, true);
		const crc = v.getUint32(p + 16, true);
		let csize = v.getUint32(p + 20, true);
		let usize = v.getUint32(p + 24, true);
		const nameLen = v.getUint16(p + 28, true);
		const extraLen = v.getUint16(p + 30, true);
		const commentLen = v.getUint16(p + 32, true);
		const madeBy = v.getUint16(p + 4, true) >> 8;
		const extAttr = v.getUint32(p + 38, true);
		let offset = v.getUint32(p + 42, true);
		const nameStart = p + 46, extraStart = nameStart + nameLen, next = extraStart + extraLen + commentLen;
		if (next > cd.length) throw new ZipError(`Corrupt ZIP central directory (entry ${n} truncated)`);

		const rawName = cd.subarray(nameStart, extraStart);
		let name = null;
		for (let x = extraStart, xe = extraStart + extraLen; x + 4 <= xe;) {
			const id = v.getUint16(x, true), len = v.getUint16(x + 2, true), body = x + 4;
			if (body + len > xe) break;
			if (id === 0x0001) {
				// ZIP64 extended information: only the saturated fields are present, in this order
				let q = body;
				const end = body + len;
				if (usize === 0xffffffff && q + 8 <= end) { usize = Number(v.getBigUint64(q, true)); q += 8; }
				if (csize === 0xffffffff && q + 8 <= end) { csize = Number(v.getBigUint64(q, true)); q += 8; }
				if (offset === 0xffffffff && q + 8 <= end) { offset = Number(v.getBigUint64(q, true)); q += 8; }
			} else if (id === 0x7075 && len > 5 && cd[body] === 1) {
				// Info-ZIP unicode path: version, CRC32 of the raw name, UTF-8 name
				name = utf8Loose.decode(cd.subarray(body + 5, body + len));
			}
			x = body + len;
		}
		if (name === null) name = decodeName(rawName, flags & 0x800);

		const path = normalizePath(name);
		const isDir = /[\\/]$/.test(name) || (madeBy === 0 && (extAttr & 0x10) !== 0) ||
			(madeBy === 3 && ((extAttr >>> 16) & 0o170000) === 0o040000);
		entries.push({
			name,
			path, // normalized, null if unsafe
			isDir,
			method,
			encrypted: (flags & 1) !== 0,
			crc,
			csize,
			usize,
			offset: offset + bias, // local header position in the file
			mtime: dosDateTimeToMs(dosTime, dosDate),
			data: null, // compressed bytes, filled in by loadPayloads()
		});
		p = next;
	}
	return { entries, count };
}

// ---------------------------------------------------------------------------------------------
// folder input (<input webkitdirectory> or a dropped directory)

/** @param {Iterable<File>|FileList} files with webkitRelativePath set, or {file, path} pairs */
export function entriesFromFiles(files) {
	const entries = [];
	for (const item of files) {
		const file = item instanceof Blob ? item : item.file;
		const rel = item instanceof Blob ? (file.webkitRelativePath || file.name) : item.path;
		const path = normalizePath(rel);
		if (!path) continue;
		entries.push({
			name: rel, path, isDir: false, method: METHOD_STORE, encrypted: false, crc: null,
			csize: file.size, usize: file.size, offset: -1, mtime: file.lastModified || 0, file, data: null,
		});
	}
	return { entries, count: entries.length };
}

/** Walks a dropped directory (DataTransferItem.webkitGetAsEntry()) and returns {file, path} pairs. */
export async function filesFromDirectoryEntry(rootEntry) {
	const out = [];
	const walk = async (entry, prefix) => {
		if (entry.isFile) {
			const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
			out.push({ file, path: prefix + entry.name });
		} else if (entry.isDirectory) {
			const reader = entry.createReader();
			for (;;) {
				const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
				if (!batch.length) break;
				for (const child of batch) await walk(child, prefix + entry.name + '/');
			}
		}
	};
	await walk(rootEntry, '');
	return out;
}

// ---------------------------------------------------------------------------------------------
// filtering and game detection

const NATIVE_RE = /\.(dll|exe|so|dylib|asi|pdb)$|\.so(\.\d+)+$/i;
const JUNK_RE = /(^|\/)(__MACOSX|\.git|\.svn)(\/|$)|(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$|(^|\/)\._[^/]*$/i;

/** Why a file is not mounted: 'native' (platform binaries), 'junk' (OS metadata) or null. */
export function skipReason(path) {
	if (JUNK_RE.test(path)) return 'junk';
	if (NATIVE_RE.test(path)) return 'native';
	return null;
}

const MARKER_RE = /^(liblist\.gam|gameinfo\.txt)$/i;

/**
 * Finds game directories: any folder that contains liblist.gam or gameinfo.txt. Tolerates wrapping
 * folders ("Half-Life/valve/...") and case differences ("Valve/"). When several roots exist, the one
 * containing valve wins, then the one with most games, then the shallowest.
 * @returns {{root: string|null, games: {id: string, dirs: string[], liblist: object|null, gameinfo: object|null}[], hint: string|null}}
 */
export function detectGames(entries) {
	const roots = new Map(); // root -> Map(id -> game)
	let looseMarker = false;
	for (const e of entries) {
		if (e.isDir || !e.path) continue;
		const segs = e.path.split('/');
		const base = segs[segs.length - 1];
		if (!MARKER_RE.test(base) || JUNK_RE.test(e.path)) continue;
		if (segs.length < 2) {
			looseMarker = true;
			continue;
		}
		const dir = segs[segs.length - 2];
		const root = segs.slice(0, -2).join('/');
		if (!roots.has(root)) roots.set(root, new Map());
		const games = roots.get(root);
		const id = dir.toLowerCase();
		if (!games.has(id)) games.set(id, { id, dirs: [], liblist: null, gameinfo: null });
		const g = games.get(id);
		if (!g.dirs.includes(dir)) g.dirs.push(dir);
		if (/^liblist\.gam$/i.test(base)) g.liblist ??= e;
		else g.gameinfo ??= e;
	}

	let best = null;
	for (const [root, games] of roots) {
		if (best === null) { best = root; continue; }
		const a = roots.get(best);
		const score = (r, g) => [g.has('valve') ? 1 : 0, g.size, -r.split('/').filter(Boolean).length];
		const sa = score(best, a), sb = score(root, games);
		for (let i = 0; i < 3; i++) {
			if (sb[i] !== sa[i]) {
				if (sb[i] > sa[i]) best = root;
				break;
			}
		}
	}

	if (best === null) {
		return {
			root: null, games: [],
			hint: looseMarker ? 'loose-gamedir' : 'no-games',
		};
	}
	const games = [...roots.get(best).values()].sort((a, b) => a.id.localeCompare(b.id));
	return { root: best, games, hint: null };
}

/**
 * Lists the files of one game directory (any case variant of `id`) under `root`, relative to it.
 * @returns {{files: {rel: string, entry: object}[], skipped: {native: number, junk: number, unsupported: string[]}}}
 */
export function gameFiles(entries, root, id) {
	const prefix = root ? root + '/' : '';
	const files = [];
	const skipped = { native: 0, junk: 0, unsupported: [] };
	for (const e of entries) {
		if (e.isDir || !e.path || !e.path.startsWith(prefix)) continue;
		const rest = e.path.slice(prefix.length);
		const slash = rest.indexOf('/');
		if (slash <= 0 || rest.slice(0, slash).toLowerCase() !== id) continue;
		const rel = rest.slice(slash + 1);
		const why = skipReason(rel);
		if (why) {
			skipped[why]++;
			continue;
		}
		if (e.encrypted || (e.method !== METHOD_STORE && e.method !== METHOD_DEFLATE)) {
			skipped.unsupported.push(e.path);
			continue;
		}
		files.push({ rel, entry: e });
	}
	return { files, skipped };
}

/** liblist.gam / gameinfo.txt: `key "value"` lines -> object with lowercase keys */
export function parseGameInfo(text) {
	const kv = {};
	for (const m of text.matchAll(/^[ \t]*([A-Za-z_][\w]*)[ \t]+"([^"\r\n]*)"/gm)) {
		const k = m[1].toLowerCase();
		if (!(k in kv)) kv[k] = m[2];
	}
	return kv;
}

// ---------------------------------------------------------------------------------------------
// payload loading

/**
 * Loads the compressed bytes of `entries` into `entry.data` (zero-copy views into a few large
 * buffers). Neighbouring entries are fetched with one coalesced read; big gaps (skipped files) are
 * not read. Folder entries (entry.file) are read whole.
 * @param reader blobReader/bytesReader of the zip, may be null for folder entries
 */
export async function loadPayloads(reader, entries, { chunkBytes = 32 * MiB, maxGap = 256 * 1024, onProgress, signal } = {}) {
	const todo = entries.filter((e) => e.data === null);
	const total = todo.reduce((s, e) => s + e.csize, 0);
	let done = 0;
	const report = () => onProgress?.(done, total);

	const fromFiles = todo.filter((e) => e.file);
	const fromZip = todo.filter((e) => !e.file).sort((a, b) => a.offset - b.offset);

	// folder entries: a handful of parallel reads
	let next = 0;
	const worker = async () => {
		while (next < fromFiles.length) {
			signal?.throwIfAborted();
			const e = fromFiles[next++];
			e.data = new Uint8Array(await e.file.arrayBuffer());
			if (e.data.length !== e.usize) throw new ZipError(`${e.name} changed while reading`);
			done += e.csize;
			report();
		}
	};
	await Promise.all(Array.from({ length: Math.min(8, fromFiles.length) }, worker));

	// local header (30) + name + extra; the local extra field can differ from the central one,
	// so read some slack and fall back to a separate read if it was not enough
	const span = (e) => 30 + Math.max(e.name.length * 3, 64) + 512 + e.csize;
	for (let i = 0; i < fromZip.length;) {
		signal?.throwIfAborted();
		const start = fromZip[i].offset;
		let end = start + span(fromZip[i]);
		let j = i + 1;
		while (j < fromZip.length) {
			const e = fromZip[j];
			const eEnd = e.offset + span(e);
			if (e.offset - end > maxGap || eEnd - start > chunkBytes) break;
			end = Math.max(end, eEnd);
			j++;
		}
		end = Math.min(end, reader.size);
		const buf = await reader.read(start, end - start);
		for (let k = i; k < j; k++) {
			const e = fromZip[k];
			e.data = await sliceLocal(reader, buf, e.offset - start, e);
			done += e.csize;
		}
		report();
		i = j;
	}
	report();
}

async function sliceLocal(reader, buf, at, e) {
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	if (at + 30 > buf.length || dv.getUint32(at, true) !== SIG_LOCAL)
		throw new ZipError(`Corrupt ZIP archive (bad local header for ${e.name})`);
	const dataAt = at + 30 + dv.getUint16(at + 26, true) + dv.getUint16(at + 28, true);
	if (dataAt + e.csize <= buf.length) return buf.subarray(dataAt, dataAt + e.csize);
	// the local extra field was bigger than our slack: read this entry on its own
	const own = await reader.read(e.offset + (dataAt - at), e.csize);
	if (own.length !== e.csize) throw new ZipError(`Corrupt ZIP archive (${e.name} is truncated)`);
	return own;
}

/** Synchronously decompresses one loaded entry. */
export function inflateEntry(entry, inflateSync) {
	if (entry.data === null) throw new ZipError(`${entry.name} was not loaded`);
	if (entry.usize === 0) return new Uint8Array(0);
	if (entry.method === METHOD_STORE) {
		if (entry.data.length !== entry.usize) throw new ZipError(`${entry.name}: size mismatch`);
		return entry.data;
	}
	if (entry.method === METHOD_DEFLATE) {
		const out = inflateSync(entry.data, { out: new Uint8Array(entry.usize) });
		if (out.length !== entry.usize) throw new ZipError(`${entry.name}: inflated ${out.length} of ${entry.usize} bytes`);
		return out;
	}
	throw new ZipError(`${entry.name}: unsupported compression method ${entry.method}`);
}

export function readText(entry, inflateSync) {
	return utf8Loose.decode(inflateEntry(entry, inflateSync));
}

let crcTable = null;
export function crc32(u8) {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let i = 0; i < 256; i++) {
			let c = i;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[i] = c >>> 0;
		}
	}
	let c = 0xffffffff;
	for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 255] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------------------------
// lazy MEMFS mount

/**
 * Returns the existing spelling of an absolute directory path, matching every component
 * case-insensitively, and creates the components that do not exist yet ("/rodir/Valve/MAPS" ->
 * "/rodir/valve/maps" when /rodir/valve exists).
 */
export function resolveDirCI(FS, absDir) {
	let cur = '';
	for (const seg of absDir.split('/')) {
		if (!seg) continue;
		const parent = cur || '/';
		let found = null;
		try {
			const want = seg.toLowerCase();
			for (const n of FS.readdir(parent)) {
				if (n.toLowerCase() === want) {
					found = n;
					if (n === seg) break;
				}
			}
		} catch {
			// parent missing: mkdir below reports it
		}
		cur += '/' + (found ?? seg);
		if (found === null) FS.mkdir(cur);
	}
	return cur || '/';
}

/**
 * Creates lazy file nodes for `files` ([{path, entry}], path relative to `mountPoint`) in MEMFS.
 * Directories are merged case-insensitively with what already exists; later duplicates of a path
 * (ignoring case) are skipped. Files are created read-only (0444).
 *
 * @param FS          Emscripten FS object
 * @param mountPoint  e.g. "/rodir"
 * @param inflateSync fflate.inflateSync
 * @param options     cacheBytes: budget for inflated data of *closed* files (LRU),
 *                    verifyCrc: check CRC32 after inflating, onError(path, err)
 */
export function mountLazy(FS, mountPoint, files, inflateSync, { cacheBytes = 64 * MiB, verifyCrc = false, onError } = {}) {
	const stats = { files: 0, dirs: 0, duplicates: 0, inflated: 0, inflatedBytes: 0, evicted: 0, cachedBytes: 0, errors: 0 };
	const closed = new Map(); // node -> bytes, in least recently closed order

	const forget = (node) => {
		const bytes = closed.get(node);
		if (bytes !== undefined) {
			closed.delete(node);
			stats.cachedBytes -= bytes;
		}
	};
	const park = (node) => {
		const z = node.lazyZip;
		if (z.cache === null || z.dirty || z.opens > 0) return;
		forget(node);
		closed.set(node, z.cache.length);
		stats.cachedBytes += z.cache.length;
		for (const [old, bytes] of closed) {
			if (stats.cachedBytes <= cacheBytes) break;
			closed.delete(old);
			stats.cachedBytes -= bytes;
			old.lazyZip.cache = null;
			stats.evicted++;
		}
	};

	const accessor = {
		configurable: true,
		enumerable: true,
		get() {
			const z = this.lazyZip;
			const data = z.cache;
			if (data !== null) {
				if (z.opens === 0 && closed.has(this)) {
					forget(this);
					park(this); // refresh the LRU position
				}
				return data;
			}
			if (z.failed) throw new FS.ErrnoError(EIO); // reported once already
			let fresh;
			try {
				fresh = inflateEntry(z.entry, inflateSync);
				if (verifyCrc && z.entry.crc !== null && crc32(fresh) !== z.entry.crc)
					throw new ZipError(`${z.entry.name}: CRC mismatch`);
			} catch (err) {
				z.failed = true;
				stats.errors++;
				onError?.(FS.getPath(this), err);
				throw new FS.ErrnoError(EIO);
			}
			z.cache = fresh;
			stats.inflated++;
			stats.inflatedBytes += fresh.length;
			if (z.opens === 0) park(this); // touched without an open stream (e.g. from JS)
			return fresh; // park() may already have dropped it again if it is bigger than the budget
		},
		set(value) {
			// MEMFS replaces contents on write/truncate; keep the new data for good
			const z = this.lazyZip;
			forget(this);
			z.cache = value;
			z.dirty = true;
		},
	};

	let streamOps = null; // shared by all nodes of this mount
	const makeStreamOps = (base) => Object.assign(Object.create(base), {
		open(stream) {
			const z = stream.node.lazyZip;
			if (z) {
				z.opens++;
				forget(stream.node);
			}
			base.open?.(stream);
		},
		dup(stream) {
			const z = stream.node.lazyZip;
			if (z) z.opens++;
			base.dup?.(stream);
		},
		close(stream) {
			try {
				base.close?.(stream);
			} finally {
				const z = stream.node.lazyZip;
				if (z && z.opens > 0 && --z.opens === 0) park(stream.node);
			}
		},
	});

	// lower-case absolute path -> actual absolute path, seeded from existing directory listings
	const actual = new Map();
	const scanned = new Set();
	const scan = (dir) => {
		if (scanned.has(dir)) return;
		scanned.add(dir);
		let names = [];
		try {
			names = FS.readdir(dir);
		} catch {
			return;
		}
		for (const n of names) {
			if (n === '.' || n === '..') continue;
			const full = dir === '/' ? '/' + n : dir + '/' + n;
			const key = full.toLowerCase();
			if (!actual.has(key)) actual.set(key, full);
		}
	};
	const resolveDir = (abs) => {
		// abs uses the zip's spelling; returns the existing/created spelling
		const key = abs.toLowerCase();
		const hit = actual.get(key);
		if (hit) return hit;
		const cut = abs.lastIndexOf('/');
		const parent = cut <= 0 ? '/' : resolveDir(abs.slice(0, cut));
		scan(parent);
		const again = actual.get(key);
		if (again) return again;
		const name = abs.slice(cut + 1);
		const full = parent === '/' ? '/' + name : parent + '/' + name;
		FS.mkdir(full);
		stats.dirs++;
		actual.set(key, full);
		scanned.add(full);
		return full;
	};

	const root = mountPoint.replace(/\/+$/, '') || '/';
	FS.mkdirTree(root);
	actual.set(root.toLowerCase(), root);

	for (const { path, entry } of files) {
		let node, full;
		try {
			const cut = path.lastIndexOf('/');
			const dir = cut < 0 ? root : resolveDir(root + '/' + path.slice(0, cut));
			scan(dir);
			full = dir + '/' + path.slice(cut + 1);
			if (actual.has(full.toLowerCase())) {
				stats.duplicates++;
				continue;
			}
			node = FS.create(full, 0o444);
		} catch (err) {
			// e.g. "a" is a file in one place and a directory in another
			stats.errors++;
			onError?.(root + '/' + path, err);
			continue;
		}
		actual.set(full.toLowerCase(), full);
		node.lazyZip = { entry, cache: null, opens: 0, dirty: false, failed: false };
		Object.defineProperty(node, 'contents', accessor);
		node.usedBytes = entry.usize;
		node.atime = node.mtime = node.ctime = entry.mtime || Date.now();
		streamOps ??= makeStreamOps(node.stream_ops);
		node.stream_ops = streamOps;
		stats.files++;
	}

	return {
		stats,
		/** drops all inflated data of closed files */
		trim() {
			for (const node of [...closed.keys()]) {
				forget(node);
				node.lazyZip.cache = null;
				stats.evicted++;
			}
		},
	};
}
