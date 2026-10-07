/*
launcher.js - web launcher for the Xash3D FWGS Emscripten port
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

// Flow: manifest.json (written by scripts/emscripten/assemble.py) lists the engine files and the
// per-game wasm libraries. The user supplies a zip (or folder) with valve/ (+ cstrike/). On Play we
//   1. pull the compressed bytes of the needed game dirs into memory (zipfs.loadPayloads),
//   2. download engine/* and games/<dir>/* with progress,
//   3. create the MODULARIZE'd engine (engine/xash.js -> createXash) and in preRun:
//      mount IDBFS on /xash, mount the zip lazily under /rodir, place our files with
//      FS.createPreloadedFile (.so files get compiled asynchronously by Emscripten), set ENV,
//   4. callMain(['-game', dir, '-ref', renderer, ...]).
// The engine keeps running from requestAnimationFrame; it can not be restarted in-page, so quitting
// or a fatal error offers a page reload.
//
// Dev/test hooks: ?zip=<same-origin url>  ?game=<dir>  &autostart=1  &dev=1  &renderer=<name>  &args=<engine args>

import * as Z from './zipfs.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const MiB = 1024 * 1024;

const GAME_MARKS = { valve: 'HL', cstrike: 'CS', gearbox: 'OF', bshift: 'BS', dmc: 'DMC', czero: 'CZ', tfc: 'TFC', ricochet: 'RC', dod: 'DOD' };
const ENGINE_SKIP_RE = /(^|\/)xash\.(js|wasm)$|\.(js|mjs|wasm|map|symbols|html?)$/i;

function fmtSize(bytes) {
	if (bytes >= 1024 * MiB) return (bytes / 1024 / MiB).toFixed(2) + ' GB';
	if (bytes >= 10 * MiB) return (bytes / MiB).toFixed(0) + ' MB';
	if (bytes >= MiB) return (bytes / MiB).toFixed(1) + ' MB';
	if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
	return bytes + ' B';
}
const fmtCount = (n) => n.toLocaleString('en-US');
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function splitArgs(text) {
	const out = [];
	for (const m of (text || '').matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
	return out;
}

// defaults: ['-dll', '@yapb', ...] from the manifest; an option the user passes replaces the default
// (the engine only looks at the first occurrence of an option)
function mergeArgs(defaults, user) {
	const isOpt = (a) => /^[-+]/.test(a);
	const userOpts = new Set(user.filter((a) => a.startsWith('-')).map((a) => a.toLowerCase()));
	const out = [];
	for (let i = 0; i < defaults.length;) {
		let j = i + 1;
		while (j < defaults.length && !isOpt(defaults[j])) j++;
		if (!userOpts.has(defaults[i].toLowerCase())) out.push(...defaults.slice(i, j));
		i = j;
	}
	return [...out, ...user];
}

// ---------------------------------------------------------------------------------------------
// preferences (per browser, never required)

const prefs = {
	get(key, fallback) {
		try {
			const v = localStorage.getItem('xash-web:' + key);
			return v === null ? fallback : JSON.parse(v);
		} catch {
			return fallback;
		}
	},
	set(key, value) {
		try {
			localStorage.setItem('xash-web:' + key, JSON.stringify(value));
		} catch {
			// private mode or storage disabled: settings just won't stick
		}
	},
};

// ---------------------------------------------------------------------------------------------
// remembered zip (IndexedDB; the engine's own /xash data lives in IDBFS's "/xash" database)

const savedZip = (() => {
	const DB = 'xash-web-launcher', STORE = 'files', KEY = 'zip';
	let dbp = null;
	const open = () => dbp ??= new Promise((resolve, reject) => {
		const req = indexedDB.open(DB, 1);
		req.onupgradeneeded = () => req.result.createObjectStore(STORE);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
		req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
	});
	const run = async (mode, fn) => {
		const db = await open();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(STORE, mode);
			const req = fn(tx.objectStore(STORE));
			tx.oncomplete = () => resolve(req?.result);
			tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
		});
	};
	return {
		available: typeof indexedDB !== 'undefined',
		async get() {
			try {
				const rec = await run('readonly', (s) => s.get(KEY));
				return rec && rec.blob instanceof Blob ? rec : null;
			} catch {
				return null;
			}
		},
		put: (blob, name) => run('readwrite', (s) => s.put({ blob, name, size: blob.size, savedAt: Date.now() }, KEY)),
		clear: () => run('readwrite', (s) => s.delete(KEY)),
	};
})();

// ---------------------------------------------------------------------------------------------
// log drawer

const logView = (() => {
	const MAX = 5000;
	const lines = [];
	let rendered = 0; // how many of `lines` are in the DOM (from the end)
	let dirty = false;
	let errors = 0;
	const body = $('log-body'), panel = $('log');

	const flush = () => {
		dirty = false;
		$('log-count').textContent = fmtCount(lines.length) + ' lines';
		if (panel.hidden) return;
		const stick = body.scrollTop + body.clientHeight >= body.scrollHeight - 24;
		const frag = document.createDocumentFragment();
		const start = Math.max(0, lines.length - rendered);
		for (let i = start; i < lines.length; i++) {
			const [text, cls] = lines[i];
			const span = document.createElement('span');
			if (cls) span.className = cls;
			span.textContent = text + '\n';
			frag.append(span);
		}
		rendered = 0;
		body.append(frag);
		while (body.childNodes.length > MAX) body.firstChild.remove();
		if (stick) body.scrollTop = body.scrollHeight;
	};
	const add = (text, cls = '') => {
		lines.push([String(text), cls]);
		rendered++;
		if (lines.length > MAX * 2) lines.splice(0, lines.length - MAX);
		if (cls === 'e') {
			errors++;
			$('log-badge').hidden = !panel.hidden;
		}
		if (!dirty) {
			dirty = true;
			requestAnimationFrame(flush);
		}
	};
	const open = (show = true) => {
		panel.hidden = !show;
		$('log-toggle').hidden = show;
		if (show) {
			$('log-badge').hidden = true;
			body.textContent = '';
			rendered = Math.min(lines.length, MAX);
			flush();
			body.scrollTop = body.scrollHeight;
		}
	};
	const text = () => lines.map((l) => l[0]).join('\n') + '\n';
	return { add, open, text, get errors() { return errors; }, toggle: () => open(panel.hidden) };
})();

const say = (msg, cls = 'i') => {
	logView.add('[launcher] ' + msg, cls);
	(cls === 'e' ? console.error : cls === 'w' ? console.warn : console.info)('[launcher] ' + msg);
};

// ---------------------------------------------------------------------------------------------
// progress overlay

const progress = (() => {
	const box = $('progress'), list = $('stages'), fill = $('bar-fill'), bar = fill.parentElement, detail = $('progress-detail');
	let items = new Map();
	return {
		show(title, stages) {
			$('progress-title').textContent = title;
			list.textContent = '';
			items = new Map();
			for (const [id, label] of stages) {
				const li = document.createElement('li');
				li.textContent = label;
				const extra = document.createElement('span');
				extra.className = 'stage-extra';
				li.append(extra);
				list.append(li);
				items.set(id, { li, extra });
			}
			this.set(null, '');
			box.hidden = false;
		},
		enter(id, text = '') {
			let seen = false;
			for (const [key, it] of items) {
				if (key === id) {
					seen = true;
					it.li.className = 'active';
				} else if (!seen && it.li.className !== 'skipped') {
					it.li.className = 'done';
				}
			}
			this.set(null, text);
		},
		skip(id) {
			const it = items.get(id);
			if (it) it.li.className = 'skipped';
		},
		extra(id, text) {
			const it = items.get(id);
			if (it) it.extra.textContent = text;
		},
		set(fraction, text) {
			if (fraction === null || !Number.isFinite(fraction)) {
				bar.classList.add('indeterminate');
				fill.style.width = '';
				bar.removeAttribute('aria-valuenow');
			} else {
				const pct = Math.max(0, Math.min(100, fraction * 100));
				bar.classList.remove('indeterminate');
				fill.style.width = pct.toFixed(1) + '%';
				bar.setAttribute('aria-valuenow', pct.toFixed(0));
			}
			if (text !== undefined) detail.textContent = text || ' ';
		},
		hide() {
			box.hidden = true;
		},
	};
})();

// ---------------------------------------------------------------------------------------------
// state

const state = {
	manifest: null,
	manifestError: null,
	renderers: [],
	source: null, // { kind, name, size, reader, blob, bytes, index, det, info: Map(id -> liblist kv) }
	busy: false,
	engineCreated: false,
	running: false,
	ready: false,
	exited: false,
	module: null,
	idbMounted: false,
	lastEngineError: '',
};

// ---------------------------------------------------------------------------------------------
// error overlay

function showError(title, message, err, { neutral = false } = {}) {
	progress.hide();
	$('error-title').textContent = title;
	$('error-message').textContent = message || '';
	$('error').querySelector('.panel').classList.toggle('neutral', neutral);
	const stack = err?.stack ? String(err.stack) : '';
	const details = err ? [err.message && !stack.includes(err.message) ? err.message : '', stack || String(err)].filter(Boolean).join('\n') : '';
	$('error-details').textContent = details;
	$('error-details-box').hidden = !details;
	// before the engine exists we can go back to the launcher, afterwards only a reload helps
	$('error-back').textContent = state.engineCreated ? 'Back to launcher' : 'Back';
	$('error').hidden = false;
	$('error-reload').focus();
	if (err) say(`${title}: ${message}${err ? ' (' + (err.message || err) + ')' : ''}`, 'e');
}

function launcherUrl() {
	const u = new URL(location.href);
	u.searchParams.delete('autostart');
	return u.href;
}

$('error-reload').addEventListener('click', () => location.reload());
$('error-back').addEventListener('click', () => {
	if (state.engineCreated) {
		location.href = launcherUrl();
		return;
	}
	$('error').hidden = true;
	leaveStage();
});
$('error-log').addEventListener('click', () => logView.open(true));

// ---------------------------------------------------------------------------------------------
// manifest

async function loadManifest() {
	try {
		const res = await fetch('manifest.json', { cache: 'no-cache' });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const m = await res.json();
		if (!m || !m.engine || !Array.isArray(m.engine.files) || typeof m.games !== 'object') throw new Error('unexpected format');
		state.manifest = m;
		const names = new Set(m.engine.files.map((f) => f.path));
		if (!names.has('xash.js') || !names.has('xash.wasm')) throw new Error('engine/xash.js or engine/xash.wasm is missing from the build');
		state.renderers = m.engine.renderers ?? m.engine.files.map((f) => /^libref_(.+)\.so$/.exec(f.path)?.[1]).filter(Boolean);
		const date = m.generated ? new Date(m.generated) : null;
		$('build-info').textContent = `Engine build: ${date && !isNaN(date) ? date.toLocaleString() : 'unknown date'} · ` +
			`games: ${Object.keys(m.games).join(', ') || 'none'} · renderers: ${state.renderers.join(', ') || 'none'}`;
	} catch (err) {
		state.manifestError = `manifest.json could not be loaded (${err.message}). Build the engine and run scripts/emscripten/assemble.py.`;
		$('build-info').textContent = state.manifestError;
		say(state.manifestError, 'e');
	}
	setupRendererChoice();
}

function setupRendererChoice() {
	const sel = $('renderer');
	sel.textContent = '';
	const preferred = params.get('renderer') || prefs.get('renderer', 'webgl2');
	const list = state.renderers.length ? state.renderers : ['webgl2'];
	for (const r of list) sel.append(new Option(r === 'webgl2' ? 'WebGL 2 (hardware)' : r === 'soft' ? 'Software' : r, r));
	sel.value = list.includes(preferred) ? preferred : list.includes('webgl2') ? 'webgl2' : list[0];
	$('renderer-field').hidden = list.length < 2;
}

// ---------------------------------------------------------------------------------------------
// sources: zip file / zip bytes / folder

async function useSource(src) {
	if (state.busy) return;
	state.busy = true;
	try {
		const t0 = performance.now();
		const index = src.index ?? await Z.readZipIndex(src.reader);
		const det = Z.detectGames(index.entries);
		const markers = det.games.flatMap((g) => [g.liblist, g.gameinfo]).filter(Boolean);
		await Z.loadPayloads(src.reader, markers);
		const info = new Map();
		for (const g of det.games) {
			try {
				const kv = {};
				if (g.gameinfo) Object.assign(kv, Z.parseGameInfo(Z.readText(g.gameinfo, fflate.inflateSync)));
				if (g.liblist) Object.assign(kv, Z.parseGameInfo(Z.readText(g.liblist, fflate.inflateSync)));
				info.set(g.id, kv);
			} catch (err) {
				say(`could not read ${g.id}/liblist.gam: ${err.message}`, 'w');
				info.set(g.id, {});
			}
		}
		state.source = { ...src, index, det, info };
		say(`${src.name}: ${fmtCount(index.count)} entries, games: ${det.games.map((g) => g.id).join(', ') || 'none'} (${(performance.now() - t0).toFixed(0)} ms)`);
		renderSource();
		renderGames();
		if (src.kind === 'zip' && !src.saved && !src.fromUrl && $('remember').checked) rememberSource();
		return true;
	} catch (err) {
		showError('Could not read the game data', err instanceof Z.ZipError ? err.message : 'The file could not be opened as a zip archive.', err);
		return false;
	} finally {
		state.busy = false;
	}
}

function useZipFile(blob, extra = {}) {
	return useSource({ kind: 'zip', name: blob.name || extra.name || 'game data.zip', size: blob.size, reader: Z.blobReader(blob), blob, ...extra });
}

function useFolder(files, name) {
	const index = Z.entriesFromFiles(files);
	const size = index.entries.reduce((s, e) => s + e.usize, 0);
	return useSource({ kind: 'folder', name, size, reader: null, index });
}

async function fetchZip(url) {
	const u = new URL(url, location.href);
	if (u.origin !== location.origin) throw new Error(`?zip= must point to this site (${location.origin})`);
	progress.show('Loading game data', [['read', 'Downloading zip'], ['index', 'Indexing']]);
	progress.enter('read', u.pathname);
	const res = await fetch(u);
	if (!res.ok) throw new Error(`${u.pathname}: HTTP ${res.status}`);
	const total = Number(res.headers.get('content-length')) || 0;
	const name = decodeURIComponent(u.pathname.split('/').pop() || 'game data.zip');
	let got = 0, last = 0;
	const tick = () => {
		const now = performance.now();
		if (now - last < 100) return;
		last = now;
		progress.set(total ? got / total : null, total ? `${fmtSize(got)} of ${fmtSize(total)}` : fmtSize(got));
	};
	// read straight into one buffer when the size is known (no second copy), else collect a Blob
	let bytes = total && res.body ? new Uint8Array(total) : null;
	const chunks = [];
	const reader = res.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (bytes && got + value.length <= bytes.length) {
			bytes.set(value, got);
		} else {
			if (bytes) { // content-encoding made the body bigger than content-length
				chunks.push(bytes.subarray(0, got));
				bytes = null;
			}
			chunks.push(value);
		}
		got += value.length;
		tick();
	}
	progress.enter('index');
	if (bytes) return { name, bytes: bytes.subarray(0, got) };
	return { name, blob: new Blob(chunks, { type: 'application/zip' }) };
}

async function rememberSource() {
	const src = state.source;
	if (!src || src.kind !== 'zip' || src.saved || !savedZip.available) return;
	const chip = $('save-state');
	chip.hidden = false;
	chip.className = 'chip';
	chip.textContent = 'Saving…';
	try {
		await savedZip.put(src.blob ?? new Blob([src.bytes], { type: 'application/zip' }), src.name);
		src.saved = true;
		chip.className = 'chip ok';
		chip.textContent = 'Saved for next time';
		navigator.storage?.persist?.().catch(() => {});
		refreshSaved();
	} catch (err) {
		chip.className = 'chip err';
		chip.textContent = 'Could not save';
		say(`saving the zip in the browser failed: ${err.message || err}`, 'e');
	}
}

async function refreshSaved() {
	const rec = savedZip.available ? await savedZip.get() : null;
	$('saved').hidden = !rec;
	if (rec) {
		const when = new Date(rec.savedAt);
		$('saved-meta').textContent = `${rec.name} · ${fmtSize(rec.size)} · saved ${when.toLocaleDateString()}`;
		$('use-saved').textContent = `Use saved data (${fmtSize(rec.size)})`;
	}
	return rec;
}

async function useSaved() {
	const rec = await savedZip.get();
	if (!rec) {
		refreshSaved();
		return false;
	}
	return useZipFile(rec.blob, { name: rec.name, saved: true });
}

// ---------------------------------------------------------------------------------------------
// rendering

function renderSource() {
	const src = state.source;
	$('source-info').hidden = !src;
	if (!src) return;
	$('source-name').textContent = src.name;
	const kind = src.kind === 'folder' ? 'folder' : src.saved ? 'saved zip' : 'zip';
	$('source-meta').textContent = `${kind} · ${fmtSize(src.size)} · ${fmtCount(src.index.count)} files`;
	const chip = $('save-state');
	if (src.saved) {
		chip.hidden = false;
		chip.className = 'chip ok';
		chip.textContent = 'Saved on this device';
	} else {
		chip.hidden = true;
	}
}

function gameStatus(id) {
	const det = state.source?.det;
	const m = state.manifest?.games?.[id];
	const present = !!det?.games.some((g) => g.id === id);
	if (!m) return { kind: 'nobuild', present };
	if (!present) return { kind: 'missing', present };
	const missing = (m.requires ?? []).filter((r) => !det.games.some((g) => g.id === r));
	if (missing.length) return { kind: 'needs', missing, present };
	return { kind: 'ready', present };
}

function gameTitle(id) {
	return state.manifest?.games?.[id]?.title || state.source?.info.get(id)?.game || id;
}

function renderGames() {
	const det = state.source?.det;
	const list = $('game-list');
	list.textContent = '';
	$('games').hidden = !det;
	if (!det) return;

	const manifestIds = Object.keys(state.manifest?.games ?? {});
	const others = det.games.map((g) => g.id).filter((id) => !manifestIds.includes(id));
	const wanted = params.get('game')?.toLowerCase();

	for (const id of manifestIds) {
		const st = gameStatus(id);
		const card = document.createElement('div');
		card.className = 'game ' + (st.kind === 'ready' ? 'ready' : 'unavailable') + (id === wanted ? ' selected' : '');
		card.setAttribute('role', 'listitem');
		card.dataset.mark = GAME_MARKS[id] ?? id.slice(0, 3).toUpperCase();

		const head = document.createElement('div');
		const title = document.createElement('div');
		title.className = 'game-title';
		title.textContent = gameTitle(id);
		const sub = document.createElement('div');
		sub.className = 'game-sub';
		const dirChip = document.createElement('span');
		dirChip.className = 'chip';
		dirChip.textContent = id + '/';
		sub.append(dirChip);
		const note = document.createElement('div');
		note.className = 'game-note';
		if (st.kind === 'ready') {
			const chip = document.createElement('span');
			chip.className = 'chip ok';
			chip.textContent = 'Ready';
			sub.append(chip);
			const req = state.manifest.games[id].requires ?? [];
			const bots = (state.manifest.games[id].args ?? []).includes('@yapb');
			note.textContent = [req.length ? `Uses ${req.map(gameTitle).join(', ')} from the same zip.` : '',
				bots ? 'Bots included (YaPB).' : ''].filter(Boolean).join(' ');
		} else if (st.kind === 'needs') {
			note.textContent = `Needs ${st.missing.map((r) => `${gameTitle(r)} (${r}/)`).join(', ')} in the same zip or folder.`;
		} else {
			note.textContent = `Not found in ${state.source.name}.`;
		}
		head.append(title, sub);
		card.append(head);
		if (note.textContent) card.append(note);

		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'btn ' + (st.kind === 'ready' ? 'primary' : 'ghost');
		btn.disabled = st.kind !== 'ready';
		btn.innerHTML = '<svg class="play-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>';
		btn.append(document.createTextNode(st.kind === 'ready' ? 'Play' : 'Unavailable'));
		btn.setAttribute('aria-label', `Play ${gameTitle(id)}`);
		btn.addEventListener('click', () => start(id));
		card.append(btn);
		list.append(card);
		if (id === wanted && st.kind === 'ready') queueMicrotask(() => btn.focus());
	}

	const note = $('games-note');
	const parts = [];
	if (!manifestIds.length) parts.push(state.manifestError || 'This build does not include any games.');
	if (others.length) parts.push(`Also found: ${others.map((id) => id + '/').join(', ')} (not available in this web build).`);
	if (!det.games.length) {
		parts.push(det.hint === 'loose-gamedir'
			? 'This zip contains the contents of a game folder. Zip the folder itself (for example valve/), not just what is inside it.'
			: 'No game folders were found. A game folder contains liblist.gam or gameinfo.txt, for example valve/.');
	}
	note.textContent = parts.join(' ');
	note.hidden = !parts.length;
}

// ---------------------------------------------------------------------------------------------
// starting a game

function planFiles(gameId, chain, renderer) {
	const m = state.manifest;
	const ver = (f) => (f.sha1 ? f.sha1.slice(0, 12) : String(f.size ?? ''));
	const plan = { wasm: null, script: null, files: [], chain };
	for (const f of m.engine.files) {
		const url = `engine/${encodePath(f.path)}?v=${ver(f)}`;
		if (f.path === 'xash.wasm') plan.wasm = { url, size: f.size, dest: null };
		else if (f.path === 'xash.js') plan.script = url;
		else if (!ENGINE_SKIP_RE.test(f.path)) {
			const base = f.path.split('/').pop();
			const r = /^libref_(.+)\.so$/.exec(base);
			if (r && r[1] !== renderer) continue;
			// waf may install extras.pk3 into a game subdirectory; the engine gets its path from ENV
			plan.files.push({ url, size: f.size, dest: '/engine/' + (base === 'extras.pk3' ? base : f.path) });
		}
	}
	for (const dir of chain) {
		for (const f of m.games[dir]?.files ?? []) {
			if (dir !== gameId && /\.so$/i.test(f.path)) continue; // base game's own libraries are not used
			plan.files.push({ url: `games/${encodePath(dir)}/${encodePath(f.path)}?v=${ver(f)}`, size: f.size, dest: `/rodir/${dir}/${f.path}` });
		}
	}
	return plan;
}

async function fetchWithProgress(url, onBytes, signal) {
	const res = await fetch(url, { signal });
	if (!res.ok) throw new Error(`${url.replace(/\?.*$/, '')}: HTTP ${res.status}`);
	if (!res.body) {
		const b = new Uint8Array(await res.arrayBuffer());
		onBytes(b.length);
		return b;
	}
	const reader = res.body.getReader();
	const chunks = [];
	let got = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		got += value.length;
		onBytes(value.length);
	}
	if (chunks.length === 1) return chunks[0];
	const out = new Uint8Array(got);
	let o = 0;
	for (const c of chunks) {
		out.set(c, o);
		o += c.length;
	}
	return out;
}

async function downloadAll(items, onProgress) {
	const total = items.reduce((s, it) => s + (it.size || 0), 0);
	let got = 0, next = 0;
	const ctrl = new AbortController();
	const worker = async () => {
		while (next < items.length) {
			const it = items[next++];
			it.bytes = await fetchWithProgress(it.url, (n) => {
				got += n;
				onProgress(got, total);
			}, ctrl.signal);
		}
	};
	try {
		await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
	} catch (err) {
		ctrl.abort();
		throw err;
	}
}

function loadEngineFactory(url) {
	return new Promise((resolve, reject) => {
		const s = document.createElement('script');
		s.src = url;
		s.async = true;
		s.onerror = () => reject(new Error(`Failed to load ${url.replace(/\?.*$/, '')}`));
		s.onload = async () => {
			if (typeof globalThis.createXash === 'function') return resolve(globalThis.createXash);
			try { // -sEXPORT_ES6 builds
				const mod = await import(new URL(url, location.href).href);
				const f = mod.default ?? mod.createXash;
				if (typeof f === 'function') return resolve(f);
			} catch (err) {
				return reject(err);
			}
			reject(new Error('engine/xash.js does not define createXash (expected -sMODULARIZE=1 -sEXPORT_NAME=createXash)'));
		};
		document.head.append(s);
	});
}

function enterStage() {
	document.body.classList.add('playing');
	$('stage').hidden = false;
	logView.open(false);
}

function leaveStage() {
	if (state.engineCreated) return;
	document.body.classList.remove('playing');
	$('stage').hidden = true;
	progress.hide();
}

async function start(gameId) {
	if (state.busy || state.engineCreated) return;
	const st = gameStatus(gameId);
	if (st.kind !== 'ready') {
		showError('Cannot start ' + gameTitle(gameId), st.kind === 'needs'
			? `${gameTitle(gameId)} also needs ${st.missing.join(', ')}/ in the same zip.`
			: st.kind === 'missing' ? `${gameId}/ was not found in ${state.source?.name ?? 'the game data'}.`
				: state.manifestError || `This build has no web libraries for ${gameId}.`);
		return;
	}
	state.busy = true;
	prefs.set('lastGame', gameId);
	const src = state.source;
	const m = state.manifest;
	const chain = [...new Set([...(m.games[gameId].requires ?? []), gameId])];
	const renderer = $('renderer').value || 'webgl2';
	const user = splitArgs($('args').value);
	if ($('devmode').checked) user.unshift('-dev', '1', '-console');
	// -windowed: the engine window must follow the canvas (SDL resizes it to the canvas' CSS size);
	// "fullscreen" would size it to the whole screen. Browser fullscreen is the HUD button.
	const args = ['-game', gameId, '-ref', renderer, ...mergeArgs(['-windowed', ...(m.games[gameId].args ?? [])], user)];

	enterStage();
	progress.show(`Starting ${gameTitle(gameId)}`, [
		['read', 'Reading game files'], ['download', 'Downloading engine'], ['compile', 'Compiling'], ['start', 'Starting'],
	]);

	try {
		// 1. compressed game data into memory
		const mount = [];
		let skipped = 0;
		for (const dir of chain) {
			const r = Z.gameFiles(src.index.entries, src.det.root, dir);
			for (const f of r.files) mount.push({ path: dir + '/' + f.rel, entry: f.entry });
			skipped += r.skipped.native + r.skipped.junk;
			if (r.skipped.unsupported.length) say(`skipping ${r.skipped.unsupported.length} entries with unsupported compression or encryption, e.g. ${r.skipped.unsupported[0]}`, 'w');
		}
		say(`${chain.join(' + ')}: ${fmtCount(mount.length)} files (${fmtCount(skipped)} platform binaries / OS metadata skipped)`);
		progress.enter('read', src.kind === 'folder' ? 'Reading folder…' : 'Reading zip…');
		const t0 = performance.now();
		await Z.loadPayloads(src.reader, mount.map((f) => f.entry), {
			onProgress: (d, t) => progress.set(t ? d / t : null, `${fmtSize(d)} of ${fmtSize(t)}`),
		});
		progress.extra('read', fmtSize(mount.reduce((s, f) => s + f.entry.csize, 0)));
		say(`game data ready in ${(performance.now() - t0).toFixed(0)} ms`);

		// 2. engine + game libraries
		progress.enter('download');
		const plan = planFiles(gameId, chain, renderer);
		const items = [plan.wasm, ...plan.files];
		let lastTick = 0;
		await downloadAll(items, (got, total) => {
			const now = performance.now();
			if (now - lastTick < 80 && got < total) return;
			lastTick = now;
			progress.set(total ? got / total : null, `${fmtSize(got)} of ${fmtSize(total)}`);
		});
		progress.extra('download', fmtSize(items.reduce((s, it) => s + it.bytes.length, 0)));

		// 3. compile + instantiate (main module streaming from memory, side modules via preload plugin)
		progress.enter('compile', 'Loading engine…');
		const createXash = await loadEngineFactory(plan.script);
		const instance = await createEngine(createXash, { gameId, mount, plan });

		// 4. run
		progress.enter('start', 'Initializing engine…');
		progress.set(null);
		await sleep(30); // let the overlay paint before main() blocks the thread for a while
		say('callMain ' + JSON.stringify(args));
		state.running = true;
		try {
			instance.callMain(args);
		} catch (err) {
			if (!state.exited) throw err;
		}
		if (!state.exited && !state.ready) onEngineReady();
	} catch (err) {
		state.running = false;
		showError(state.engineCreated ? 'The engine failed to start' : 'Could not start the game', err?.message || String(err), err);
	} finally {
		state.busy = false;
	}
}

function createEngine(factory, { mount, plan }) {
	const canvas = $('canvas');
	let maxDeps = 0;
	const Module = {
		canvas,
		noInitialRun: true,
		wasmBinary: plan.wasm.bytes,
		locateFile: (path) => new URL('engine/' + path, location.href).href,
		print: (text) => {
			logView.add(text);
			console.log(text);
		},
		printErr: (text) => {
			logView.add(text, 'e');
			console.warn(text);
		},
		setStatus: () => {},
		monitorRunDependencies: (left) => {
			maxDeps = Math.max(maxDeps, left);
			if (!state.ready && maxDeps > 1) progress.set((maxDeps - left) / maxDeps, left ? `Compiling libraries (${maxDeps - left} of ${maxDeps})…` : 'Linking…');
		},
		onAbort: (what) => engineFailed(`The engine aborted: ${what}`),
		onExit: (code) => onEngineExit(code),
		xash: {
			onReady: () => onEngineReady(),
			onExit: (code, reason) => onEngineExit(code, reason),
			onError: (text) => { state.lastEngineError = String(text || '').trim(); },
			onFsWrite: () => schedulePersist(),
		},
		preRun: [(M) => {
			try {
				setupFilesystem(M, mount, plan);
			} catch (err) {
				engineFailed('Setting up the virtual filesystem failed', err);
				throw err;
			}
		}],
	};
	state.module = Module;
	state.engineCreated = true;
	plan.wasm.bytes = null;
	return factory(Module);
}

function setupFilesystem(M, mount, plan) {
	const FS = M.FS;
	if (!FS) throw new Error('the engine build does not export FS');
	for (const d of ['/rodir', '/engine', '/xash']) FS.mkdirTree(d);

	// The engine only accepts -game <dir> when <dir> also exists in its writable root (it checks
	// rodir entries relative to the cwd), so create /xash/<dir> for the games we start. This has to
	// happen after the IndexedDB load: syncfs(true) removes local entries the database lacks.
	const makeGameDirs = () => {
		for (const dir of plan.chain) {
			try {
				FS.mkdirTree('/xash/' + dir);
			} catch (err) {
				say(`cannot create /xash/${dir}: ${err.message || err}`, 'w');
			}
		}
	};

	// engine root: config, saves, screenshots; persisted in IndexedDB
	const IDBFS = M.IDBFS ?? FS.filesystems?.IDBFS;
	let loading = false;
	if (IDBFS && savedZip.available) {
		try {
			FS.mount(IDBFS, { autoPersist: true }, '/xash');
			state.idbMounted = true;
			IDBFS.onAutoPersistStateChanged = (active) => { $('save-dot').hidden = !active; };
			M.addRunDependency('xash-idbfs');
			loading = true;
			FS.syncfs(true, (err) => {
				if (err) say(`loading saved games failed: ${err.message || err}`, 'e');
				makeGameDirs();
				M.removeRunDependency('xash-idbfs');
			});
		} catch (err) {
			say(`IndexedDB storage unavailable, progress will not be saved: ${err.message || err}`, 'w');
		}
	} else {
		say('IDBFS is not available, progress will not be saved', 'w');
	}
	if (!loading) makeGameDirs();

	// the user's game data, inflated lazily on first read
	const t0 = performance.now();
	const lazy = Z.mountLazy(FS, '/rodir', mount, fflate.inflateSync, {
		onError: (path, err) => say(`cannot read ${path}: ${err.message || err}`, 'e'),
	});
	state.lazy = lazy;
	say(`mounted ${fmtCount(lazy.stats.files)} files in ${(performance.now() - t0).toFixed(0)} ms` +
		(lazy.stats.duplicates ? ` (${lazy.stats.duplicates} case-duplicates ignored)` : ''));

	// our libraries and resources on top; .so files are compiled by Emscripten's preload plugin
	for (const it of plan.files) {
		const cut = it.dest.lastIndexOf('/');
		let dir = it.dest.slice(0, cut);
		const name = it.dest.slice(cut + 1);
		if (dir.startsWith('/rodir/')) {
			dir = Z.resolveDirCI(FS, dir);
			for (const n of FS.readdir(dir)) {
				if (n !== '.' && n !== '..' && n.toLowerCase() === name.toLowerCase()) {
					try {
						FS.unlink(dir + '/' + n);
					} catch (err) {
						say(`cannot replace ${dir}/${n}: ${err.message || err}`, 'w');
					}
				}
			}
		} else {
			FS.mkdirTree(dir);
		}
		const bytes = it.bytes;
		it.bytes = null;
		FS.createPreloadedFile(dir, name, bytes, true, false, undefined,
			(err) => engineFailed(`Failed to load ${dir}/${name}`, err instanceof Error ? err : new Error(String(err))));
	}

	const ENV = M.ENV;
	if (!ENV) throw new Error('the engine build does not export ENV');
	Object.assign(ENV, {
		XASH3D_BASEDIR: '/xash',
		XASH3D_RODIR: '/rodir',
		LD_LIBRARY_PATH: '/engine',
		HOME: '/xash',
		// MAIN_MODULE links every system library, including LLVM's profiling runtime, which
		// creates default.profraw in the working directory; keep it out of the saved data
		LLVM_PROFILE_FILE: '/tmp/default.profraw',
	});
	if (plan.files.some((it) => it.dest === '/engine/extras.pk3')) ENV.XASH3D_EXTRAS_PAK1 = '/engine/extras.pk3';
	FS.chdir('/xash');
}

// ---------------------------------------------------------------------------------------------
// engine lifecycle

function onEngineReady() {
	if (state.ready) return;
	state.ready = true;
	progress.hide();
	const canvas = $('canvas');
	canvas.focus();
	// SDL picks up the CSS size of the canvas on resize events
	window.dispatchEvent(new Event('resize'));
	setTimeout(() => window.dispatchEvent(new Event('resize')), 250);
	hudWake();
	const ctx = audioContext();
	toast(ctx && ctx.state !== 'running'
		? 'Click the game to enable sound and capture the mouse. Esc releases it.'
		: 'Click the game to capture the mouse. Esc releases it.', 5000);
	say('engine running');
}

function onEngineExit(code, reason) {
	if (state.exited) return;
	state.exited = true;
	state.running = false;
	persistNow();
	if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
	const msg = String(reason || state.lastEngineError || '').trim();
	say(`engine exited with code ${code}${msg ? ': ' + msg : ''}`, code ? 'e' : 'i');
	if (!code && !msg) {
		showError('Game closed', 'The engine has shut down. Reload the page to play again.', null, { neutral: true });
	} else {
		showError('The engine stopped', msg || `Exit code ${code}.`);
	}
}

function engineFailed(message, err) {
	if (state.exited) return;
	state.exited = true;
	state.running = false;
	showError('The engine failed', message, err);
}

// ---------------------------------------------------------------------------------------------
// persistence of /xash

let persistTimer = 0;
function schedulePersist(delay = 750) {
	clearTimeout(persistTimer);
	persistTimer = setTimeout(persistNow, delay);
}

function persistNow() {
	clearTimeout(persistTimer);
	const M = state.module;
	if (!M || !state.idbMounted || !M.FS) return;
	try {
		const IDBFS = M.IDBFS ?? M.FS.filesystems?.IDBFS;
		const mount = M.FS.lookupPath('/xash').node.mount;
		if (typeof IDBFS?.queuePersist === 'function') IDBFS.queuePersist(mount); // serialized with autoPersist
		else M.FS.syncfs(false, (err) => err && say(`saving failed: ${err.message || err}`, 'e'));
	} catch (err) {
		say(`saving failed: ${err.message || err}`, 'e');
	}
}

// ---------------------------------------------------------------------------------------------
// browser integration while playing

const stage = $('stage'), canvas = $('canvas'), hud = $('hud');

function audioContext() {
	return state.module?.SDL2?.audioContext ?? null;
}
let audioPausedByUs = false;
function resumeAudio() {
	const ctx = audioContext();
	if (ctx && ctx.state === 'suspended' && !document.hidden) ctx.resume().catch(() => {});
}

let toastTimer = 0;
function toast(text, ms = 3000) {
	const t = $('toast');
	t.textContent = text;
	t.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

let idleTimer = 0;
function hudWake() {
	hud.classList.remove('idle');
	clearTimeout(idleTimer);
	idleTimer = setTimeout(() => hud.classList.add('idle'), 2500);
}

stage.addEventListener('contextmenu', (e) => e.preventDefault());
stage.addEventListener('pointerdown', (e) => {
	if (e.target === canvas) {
		canvas.focus({ preventScroll: true });
		resumeAudio();
		$('toast').hidden = true;
	}
});
stage.addEventListener('pointermove', () => {
	if (!document.pointerLockElement) hudWake();
});
document.addEventListener('pointerlockchange', () => {
	if (document.pointerLockElement) hud.classList.add('idle');
	else hudWake();
});

const fsButton = $('btn-fullscreen');
fsButton.hidden = !document.fullscreenEnabled;
fsButton.addEventListener('click', async () => {
	try {
		if (document.fullscreenElement) {
			await document.exitFullscreen();
		} else {
			await stage.requestFullscreen({ navigationUI: 'hide' });
			// keep Escape for the game (hold Esc to leave fullscreen); Chromium only
			await navigator.keyboard?.lock?.(['Escape']).catch(() => {});
		}
	} catch (err) {
		say(`fullscreen failed: ${err.message || err}`, 'w');
	}
	canvas.focus({ preventScroll: true });
	resumeAudio();
});
document.addEventListener('fullscreenchange', () => {
	if (!document.fullscreenElement) navigator.keyboard?.unlock?.();
	fsButton.setAttribute('aria-label', document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen');
});
$('btn-log').addEventListener('click', () => {
	logView.toggle();
	canvas.focus({ preventScroll: true });
});

// SDL already prevents the default action for Tab/Backspace/arrows/F-keys/Ctrl+key while it has the
// keyboard; also stop Alt (menu bar on Windows) and keep keys away from the page while playing.
const BLOCKED_CODES = new Set(['Tab', 'Backspace', 'AltLeft', 'AltRight', 'ContextMenu', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
	'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'PageUp', 'PageDown', 'Home', 'End']);
const blockKeys = (e) => {
	if (!state.running || state.exited || !$('error').hidden) return;
	const t = e.target;
	if (t && t !== document.body && t !== canvas && t !== document.documentElement && t !== stage) return; // typing in our own UI
	resumeAudio();
	if (BLOCKED_CODES.has(e.code) || (e.ctrlKey && /^Key[A-Z]$/.test(e.code) && e.code !== 'KeyC' && e.code !== 'KeyV')) e.preventDefault();
};
window.addEventListener('keydown', blockKeys, { capture: true });
window.addEventListener('keyup', (e) => {
	if (state.running && !state.exited && (e.code === 'AltLeft' || e.code === 'AltRight')) e.preventDefault();
}, { capture: true });

document.addEventListener('visibilitychange', () => {
	const ctx = audioContext();
	if (document.hidden) {
		persistNow();
		// the main loop stops with requestAnimationFrame; stop the audio callback looping stale sound
		if (ctx && ctx.state === 'running') {
			ctx.suspend().catch(() => {});
			audioPausedByUs = true;
		}
	} else if (ctx && audioPausedByUs) {
		audioPausedByUs = false;
		ctx.resume().catch(() => {});
	}
});
window.addEventListener('pagehide', () => persistNow());
window.addEventListener('beforeunload', (e) => {
	if (!state.running || state.exited) return;
	persistNow();
	e.preventDefault();
	e.returnValue = '';
});
window.addEventListener('error', (e) => {
	if (state.engineCreated) say(`uncaught: ${e.message}`, 'e');
});
window.addEventListener('unhandledrejection', (e) => {
	if (!state.engineCreated) return;
	const msg = String(e.reason?.message || e.reason);
	// SDL requests pointer lock without handling the promise; a refusal is harmless (next click retries)
	if (/pointer ?lock/i.test(msg)) {
		e.preventDefault();
		say(`pointer lock refused: ${msg}`, 'w');
		return;
	}
	say(`unhandled rejection: ${msg}`, 'e');
});

// ---------------------------------------------------------------------------------------------
// landing page wiring

function checkBrowser() {
	const problems = [];
	if (typeof WebAssembly !== 'object') problems.push('WebAssembly is not supported by this browser.');
	try {
		const c = document.createElement('canvas');
		const gl = c.getContext('webgl2');
		if (!gl) problems.push('WebGL 2 is not available; the hardware renderer will not work.');
		else gl.getExtension('WEBGL_lose_context')?.loseContext();
	} catch {
		problems.push('WebGL 2 is not available.');
	}
	if (!savedZip.available) problems.push('IndexedDB is unavailable (private mode?): saved games will not persist.');
	if (matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches) problems.push('A keyboard and mouse are recommended.');
	if (typeof fflate === 'undefined') problems.push('vendor/fflate.umd.js failed to load.');
	$('compat').textContent = problems.join(' ');
	$('compat').hidden = !problems.length;
	return problems;
}

function wireLanding() {
	const pickZip = $('pick-zip'), pickDir = $('pick-dir'), drop = $('drop');
	pickZip.addEventListener('change', () => {
		const f = pickZip.files[0];
		pickZip.value = '';
		if (f) useZipFile(f);
	});
	pickDir.addEventListener('change', () => {
		const files = [...pickDir.files];
		pickDir.value = '';
		if (!files.length) return;
		const top = (files[0].webkitRelativePath || '').split('/')[0] || 'folder';
		useFolder(files, top + '/');
	});
	drop.addEventListener('click', (e) => {
		if (!e.target.closest('label, button, input')) pickZip.click();
	});
	drop.addEventListener('keydown', (e) => {
		if ((e.key === 'Enter' || e.key === ' ') && e.target === drop) {
			e.preventDefault();
			pickZip.click();
		}
	});

	// drag & drop anywhere on the page: a zip, or one or more folders (e.g. valve/ and cstrike/)
	const veil = $('dropveil');
	let depth = 0;
	const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
	window.addEventListener('dragenter', (e) => {
		if (!hasFiles(e) || state.engineCreated) return;
		depth++;
		veil.hidden = false;
		drop.classList.add('over');
	});
	window.addEventListener('dragleave', () => {
		if (--depth > 0) return;
		depth = 0;
		veil.hidden = true;
		drop.classList.remove('over');
	});
	window.addEventListener('dragover', (e) => {
		if (hasFiles(e)) e.preventDefault();
	});
	window.addEventListener('drop', async (e) => {
		e.preventDefault();
		depth = 0;
		veil.hidden = true;
		drop.classList.remove('over');
		if (state.engineCreated || !e.dataTransfer) return;
		const entries = [...e.dataTransfer.items].filter((i) => i.kind === 'file').map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
		const dirs = entries.filter((en) => en.isDirectory);
		if (dirs.length) {
			const files = [];
			for (const d of dirs) files.push(...await Z.filesFromDirectoryEntry(d));
			useFolder(files, dirs.map((d) => d.name + '/').join(' + '));
			return;
		}
		const file = e.dataTransfer.files[0];
		if (file) useZipFile(file);
	});

	// saved zip
	$('use-saved').addEventListener('click', () => useSaved());
	$('forget-saved').addEventListener('click', async () => {
		try {
			await savedZip.clear();
		} catch (err) {
			say(`forgetting the saved zip failed: ${err.message || err}`, 'e');
		}
		if (state.source?.saved) {
			state.source.saved = false;
			renderSource();
		}
		refreshSaved();
	});

	// options
	const remember = $('remember');
	remember.checked = prefs.get('remember', false);
	remember.disabled = !savedZip.available;
	remember.addEventListener('change', () => {
		prefs.set('remember', remember.checked);
		if (remember.checked && state.source?.kind === 'zip' && !state.source.saved) rememberSource();
	});
	const dev = $('devmode');
	dev.checked = params.has('dev') ? params.get('dev') === '1' : prefs.get('dev', false);
	dev.addEventListener('change', () => prefs.set('dev', dev.checked));
	const argsField = $('args');
	if (params.has('args')) {
		argsField.value = params.get('args'); // from the URL: used for this session, not stored
	} else {
		argsField.value = prefs.get('args', '');
		argsField.addEventListener('input', () => prefs.set('args', argsField.value));
	}
	$('renderer').addEventListener('change', () => prefs.set('renderer', $('renderer').value));
	if (dev.checked || argsField.value) $('advanced').open = true;

	$('reset-saves').addEventListener('click', () => {
		if (!confirm('Delete all saved games, screenshots and settings that the engine stored in this browser? Your game files are not affected.')) return;
		const req = indexedDB.deleteDatabase('/xash');
		req.onsuccess = () => toastLanding('Saved games and settings deleted.');
		req.onerror = () => toastLanding('Could not delete the saved data.');
		req.onblocked = () => toastLanding('Close other tabs running the game first.');
	});

	// log
	$('log-toggle').addEventListener('click', () => logView.open(true));
	$('log-close').addEventListener('click', () => {
		logView.open(false);
		if (state.running) canvas.focus({ preventScroll: true });
	});
	$('log-copy').addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(logView.text());
			$('log-copy').textContent = 'Copied';
		} catch {
			$('log-copy').textContent = 'Copy failed';
		}
		setTimeout(() => { $('log-copy').textContent = 'Copy'; }, 1500);
	});
	$('log-save').addEventListener('click', () => {
		const url = URL.createObjectURL(new Blob([logView.text()], { type: 'text/plain' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = 'xash3d-web-log.txt';
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	});
}

function toastLanding(text) {
	$('build-info').textContent = text;
}

async function main() {
	wireLanding();
	const problems = checkBrowser();
	say(`launcher started (${navigator.userAgent})`);
	await loadManifest();
	const saved = await refreshSaved();

	try {
		const zipUrl = params.get('zip');
		if (zipUrl) {
			enterStage(); // overlay over a black page while downloading
			let got;
			try {
				got = await fetchZip(zipUrl);
			} finally {
				leaveStage();
			}
			if (got.bytes) await useSource({ kind: 'zip', name: got.name, size: got.bytes.length, reader: Z.bytesReader(got.bytes), bytes: got.bytes, fromUrl: true });
			else await useZipFile(got.blob, { name: got.name, fromUrl: true });
		} else if (saved && params.get('autostart') === '1') {
			await useSaved();
		}
	} catch (err) {
		showError('Could not load the game data', err.message, err);
		return;
	}

	if (params.get('autostart') === '1') {
		const game = (params.get('game') || prefs.get('lastGame', 'valve')).toLowerCase();
		if (!state.source) {
			say('autostart: no game data (use ?zip=<url> or saved data)', 'w');
		} else if (problems.includes('WebAssembly is not supported by this browser.')) {
			showError('Cannot start', 'WebAssembly is not supported by this browser.');
		} else {
			start(game);
		}
	}
}

// handle for debugging and browser automation
globalThis.xashLauncher = {
	get state() { return state; },
	get module() { return state.module; },
	log: () => logView.text(),
	start: (id) => start(id),
};

main();
