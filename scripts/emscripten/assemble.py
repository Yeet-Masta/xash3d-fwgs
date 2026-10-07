#!/usr/bin/env python3
# assemble.py - puts the web launcher next to the Emscripten build outputs and writes manifest.json
# Copyright (C) 2026 Xash3D FWGS contributors
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
"""Assemble the browser build in build-web/.

The engine, hlsdk-portable and cs16-client builds install into build-web/engine/ and
build-web/games/<gamedir>/. This script copies the launcher (web/) on top, then scans those
directories and writes build-web/manifest.json, which the launcher uses to know what to download.
It never deletes anything it did not copy itself.

  python3 scripts/emscripten/assemble.py                 # assemble build-web/
  python3 scripts/emscripten/assemble.py --serve         # ...and serve it on http://127.0.0.1:8642/
  python3 scripts/emscripten/assemble.py --serve-only    # just serve
"""

import argparse
import datetime
import functools
import hashlib
import http.server
import json
import os
import shutil
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))

# Game metadata. Unknown game dirs get their dir name as title and require valve.
GAMES = {
	'valve':   { 'title': 'Half-Life' },
	'cstrike': { 'title': 'Counter-Strike', 'requires': ['valve'] },
}

# Default engine arguments added when a game ships a given library (the launcher drops a default
# when the user passes the same option). YaPB wraps the real server library and adds bots, the
# same way cs16-client's Android launcher starts it.
GAME_ARGS_IF_FILE = [
	('dlls/yapb_emscripten_wasm32.so', ['-dll', '@yapb']),
]

# engine files the launcher needs; anything else found in engine/ is listed too
ENGINE_REQUIRED = ['xash.js', 'xash.wasm', 'filesystem_stdio.so', 'libmenu.so', 'libref_webgl2.so']
ENGINE_OPTIONAL = ['extras.pk3']

# never listed in the manifest
IGNORE_SUFFIXES = ('.map', '.symbols', '.debug.wasm', '.a', '.o', '.obj', '.lib', '.pdb', '.tmp', '.part', '.html')
WEB_SKIP = {'README.md'}
WEB_RECORD = '.launcher-files.json'

MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.wasm': 'application/wasm',
	'.so': 'application/octet-stream',
	'.pk3': 'application/octet-stream',
	'.zip': 'application/zip',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.txt': 'text/plain; charset=utf-8',
	'.md': 'text/markdown; charset=utf-8',
	'': 'application/octet-stream',
}


def log(msg):
	print(msg, flush=True)


def ignored(name):
	return name.startswith('.') or name.lower().endswith(IGNORE_SUFFIXES) or name == '__pycache__'


def sha1_of(path):
	h = hashlib.sha1()
	with open(path, 'rb') as f:
		for chunk in iter(lambda: f.read(1 << 20), b''):
			h.update(chunk)
	return h.hexdigest()


def list_files(base, hashing):
	"""All files under base as manifest entries, paths relative to base with '/' separators."""
	out = []
	for dirpath, dirnames, filenames in os.walk(base):
		dirnames[:] = sorted(d for d in dirnames if not ignored(d))
		for name in sorted(filenames):
			if ignored(name):
				continue
			full = os.path.join(dirpath, name)
			rel = os.path.relpath(full, base).replace(os.sep, '/')
			entry = { 'path': rel, 'size': os.path.getsize(full) }
			if hashing:
				entry['sha1'] = sha1_of(full)
			out.append(entry)
	out.sort(key=lambda e: e['path'])
	return out


def copy_launcher(web, dist):
	"""Copies web/ into dist/, removing files that an earlier run copied but web/ no longer has."""
	record_path = os.path.join(dist, WEB_RECORD)
	try:
		with open(record_path, encoding='utf-8') as f:
			previous = set(json.load(f))
	except (OSError, ValueError):
		previous = set()

	copied = []
	for dirpath, dirnames, filenames in os.walk(web):
		dirnames[:] = sorted(d for d in dirnames if not d.startswith('.'))
		for name in sorted(filenames):
			if name.startswith('.') or (name in WEB_SKIP and dirpath == web):
				continue
			src = os.path.join(dirpath, name)
			rel = os.path.relpath(src, web).replace(os.sep, '/')
			if rel.split('/')[0] in ('engine', 'games') or rel == 'manifest.json':
				sys.exit(f'error: web/{rel} would collide with build outputs')
			dst = os.path.join(dist, *rel.split('/'))
			os.makedirs(os.path.dirname(dst), exist_ok=True)
			shutil.copy2(src, dst)
			copied.append(rel)

	for rel in sorted(previous - set(copied)):
		stale = os.path.join(dist, *rel.split('/'))
		if os.path.isfile(stale):
			os.remove(stale)
			log(f'  removed stale launcher file {rel}')

	with open(record_path, 'w', encoding='utf-8', newline='\n') as f:
		json.dump(sorted(copied), f, indent=1)
		f.write('\n')
	return copied


def build_manifest(dist, hashing):
	problems = []
	engine_dir = os.path.join(dist, 'engine')
	games_dir = os.path.join(dist, 'games')

	engine_files = list_files(engine_dir, hashing) if os.path.isdir(engine_dir) else []
	names = { e['path'] for e in engine_files }
	for req in ENGINE_REQUIRED:
		if req not in names:
			problems.append(f'engine/{req} is missing')
	basenames = { n.rsplit('/', 1)[-1] for n in names }
	for opt in ENGINE_OPTIONAL:
		if opt not in basenames:
			log(f'  note: engine/{opt} not found (optional)')
	renderers = sorted(n[len('libref_'):-len('.so')] for n in names if n.startswith('libref_') and n.endswith('.so') and '/' not in n)
	if 'webgl2' in renderers:
		renderers.remove('webgl2')
		renderers.insert(0, 'webgl2')

	games = {}
	if os.path.isdir(games_dir):
		for gamedir in sorted(os.listdir(games_dir)):
			path = os.path.join(games_dir, gamedir)
			if ignored(gamedir) or not os.path.isdir(path):
				continue
			if gamedir != gamedir.lower():
				problems.append(f'games/{gamedir}: game directories must be lower case')
				continue
			meta = GAMES.get(gamedir, { 'title': gamedir, 'requires': [] if gamedir == 'valve' else ['valve'] })
			files = list_files(path, hashing)
			libs = [f['path'] for f in files if f['path'].endswith('.so')]
			if not any(p.startswith('dlls/') for p in libs):
				problems.append(f'games/{gamedir}: no server library (dlls/*_emscripten_wasm32.so)')
			if not any(p.startswith('cl_dlls/client') for p in libs):
				problems.append(f'games/{gamedir}: no client library (cl_dlls/client_emscripten_wasm32.so)')
			args = list(meta.get('args', []))
			for path, extra in GAME_ARGS_IF_FILE:
				if path in libs:
					args += extra
			games[gamedir] = {
				'title': meta['title'],
				'requires': list(meta.get('requires', [])),
				'args': args,
				'files': files,
			}

	# keep the order of GAMES (valve first), then the rest alphabetically
	ordered = { k: games[k] for k in GAMES if k in games }
	ordered.update({ k: v for k, v in games.items() if k not in ordered })
	for gamedir, g in ordered.items():
		for req in g['requires']:
			if req not in ordered:
				problems.append(f'games/{gamedir} requires games/{req}, which is not built')

	manifest = {
		'format': 1,
		'generated': datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z'),
		'engine': { 'files': engine_files, 'renderers': renderers },
		'games': ordered,
	}
	return manifest, problems


def write_json(path, data):
	tmp = path + '.tmp'
	with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
		json.dump(data, f, indent=1)
		f.write('\n')
	os.replace(tmp, path)


def summarize(manifest):
	def total(files):
		return sum(f['size'] for f in files)
	eng = manifest['engine']['files']
	log(f'  engine: {len(eng)} files, {total(eng) / 1048576:.1f} MiB, renderers: {", ".join(manifest["engine"]["renderers"]) or "none"}')
	for e in eng:
		log(f'    {e["path"]:<40} {e["size"]:>12,}')
	for gamedir, g in manifest['games'].items():
		req = f' (requires {", ".join(g["requires"])})' if g['requires'] else ''
		args = f' args: {" ".join(g["args"])}' if g['args'] else ''
		log(f'  games/{gamedir}: "{g["title"]}"{req}: {len(g["files"])} files, {total(g["files"]) / 1048576:.1f} MiB{args}')
		for f in g['files']:
			if f['path'].endswith('.so'):
				log(f'    {f["path"]:<40} {f["size"]:>12,}')


class Handler(http.server.SimpleHTTPRequestHandler):
	# explicit types: the Windows registry often maps .js to text/plain, which breaks ES modules
	extensions_map = MIME

	def end_headers(self):
		self.send_header('Cache-Control', 'no-cache')
		super().end_headers()


def serve(dist, port, bind):
	handler = functools.partial(Handler, directory=dist)
	with http.server.ThreadingHTTPServer((bind, port), handler) as httpd:
		log(f'serving {dist} on http://{"localhost" if bind in ("127.0.0.1", "0.0.0.0", "::") else bind}:{port}/  (Ctrl+C to stop)')
		try:
			httpd.serve_forever()
		except KeyboardInterrupt:
			pass


def main():
	ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	ap.add_argument('--dist', default=os.path.join(ROOT, 'build-web'), help='output directory (default: %(default)s)')
	ap.add_argument('--web', default=os.path.join(ROOT, 'web'), help='launcher sources (default: %(default)s)')
	ap.add_argument('--no-hash', action='store_true', help='do not compute sha1 checksums (used for cache busting)')
	ap.add_argument('--strict', action='store_true', help='fail when engine or game files are missing')
	ap.add_argument('--serve', nargs='?', const=8642, type=int, metavar='PORT', help='serve the result afterwards (default port 8642)')
	ap.add_argument('--serve-only', nargs='?', const=8642, type=int, metavar='PORT', help='only serve, do not assemble')
	ap.add_argument('--bind', default='127.0.0.1', help='address to serve on (default: %(default)s)')
	args = ap.parse_args()

	dist = os.path.abspath(args.dist)
	if args.serve_only:
		serve(dist, args.serve_only, args.bind)
		return 0

	os.makedirs(dist, exist_ok=True)
	log(f'assembling {dist}')
	copied = copy_launcher(os.path.abspath(args.web), dist)
	log(f'  launcher: {len(copied)} files from {os.path.relpath(args.web, ROOT) if args.web.startswith(ROOT) else args.web}')

	manifest, problems = build_manifest(dist, not args.no_hash)
	write_json(os.path.join(dist, 'manifest.json'), manifest)
	summarize(manifest)
	for p in problems:
		log(f'  warning: {p}')
	log('  wrote manifest.json')
	if problems and args.strict:
		return 1
	if args.serve:
		serve(dist, args.serve, args.bind)
	return 0


if __name__ == '__main__':
	sys.exit(main())
