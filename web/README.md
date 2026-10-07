# Xash3D FWGS web launcher

Plain HTML/CSS/ES-module launcher for the Emscripten (WebAssembly) build of Xash3D FWGS.
It runs Half-Life (hlsdk-portable) and Counter-Strike 1.6 (cs16-client) in the browser with
game files the user supplies. No bundler, no runtime CDN: the only third-party file is
`vendor/fflate.umd.js` (fflate 0.8.3, MIT, see `vendor/fflate.LICENSE`).

| File | Purpose |
|---|---|
| `index.html`, `style.css` | landing page, game stage, progress/error overlays, log drawer |
| `launcher.js` | reads `manifest.json`, game data handling, downloads, engine start, browser integration |
| `zipfs.js` | ZIP central-directory reader (ZIP64, UTF-8, data descriptors, stored/deflate) and lazy MEMFS mount |

## Build and serve

All builds run in WSL/Linux with Emscripten (`source ~/emsdk/emsdk_env.sh`). They install into
`build-web/` (gitignored), then `assemble.py` copies this directory next to them and writes
`build-web/manifest.json`:

```sh
scripts/emscripten/build-all.sh                 # engine + hlsdk-portable + cs16-client, then assemble
python3 scripts/emscripten/assemble.py          # only re-copy web/ and regenerate manifest.json
python3 scripts/emscripten/assemble.py --serve  # ...and serve on http://localhost:8642/
```

Any static server works if it serves `.wasm` as `application/wasm` and `.js` as JavaScript
(`assemble.py --serve-only [port]` sets both explicitly; `python -m http.server` is fine on
current Python). No special headers (COOP/COEP) are needed: the build uses no threads.

`assemble.py` only removes launcher files it copied itself on an earlier run; engine and game
outputs that other builds installed are never deleted. It lists every file below
`build-web/engine/` and `build-web/games/<gamedir>/` in the manifest (size + sha1 for cache
busting; `--no-hash` skips hashing) with titles/requirements from its `GAMES` table
(`valve` = Half-Life, `cstrike` = Counter-Strike, requires `valve`). A game that ships
`dlls/yapb_emscripten_wasm32.so` gets the default arguments `-dll @yapb` (bots).

## Using it

1. Zip the `valve` folder (and `cstrike` for Counter-Strike) from a legally owned Half-Life
   install, e.g. `Steam/steamapps/common/Half-Life`. A wrapping folder (`Half-Life/valve/...`)
   and odd case (`Valve/`) are fine; Windows/macOS/Linux binaries in it are ignored.
2. Open the page, drop the zip (or pick it, or pick/drop the game folders), press **Play**.
   *Remember this zip* stores it in IndexedDB so the next visit offers *Use saved data*.
3. Saves, `config.cfg` and screenshots live in the engine's `/xash` directory, persisted in the
   browser's IndexedDB (database `/xash`); *Advanced* has a button to delete them.

The engine cannot restart inside a page: quitting or a fatal error shows a message with a
*Reload* button.

Advanced options: renderer (only shown when the build has more than one), developer console
(`-dev 1 -console`), extra command-line arguments (kept in localStorage).

## URL parameters (testing and automation)

| Parameter | Effect |
|---|---|
| `?zip=<url>` | fetch the game zip from a same-origin URL instead of asking for a file |
| `&game=<dir>` | preselect a game (`valve`, `cstrike`) |
| `&autostart=1` | start that game (or the last one played) without clicking; uses the saved zip when no `zip=` is given |
| `&dev=1` | developer console on for this visit |
| `&args=<text>` | extra engine arguments for this visit (not stored) |
| `&renderer=<name>` | renderer library to use (`webgl2` by default) |

`window.xashLauncher` exposes `state`, `module`, `log()` and `start(dir)` for debugging.

## Runtime layout (shared contract with the engine port)

The launcher creates the engine with `createXash(Module)` (`engine/xash.js`, `-sMODULARIZE`)
and in `Module.preRun`:

- mounts IDBFS on `/xash` (`autoPersist`) and loads it before `main()` runs;
- mounts the selected game dirs from the zip under `/rodir/<gamedir>/` as lazy MEMFS files:
  nothing is inflated until the engine reads a file, and only the compressed bytes are kept;
- places `engine/*` into `/engine/` and `games/<dir>/*` over `/rodir/<dir>/` with
  `FS.createPreloadedFile`, so every `.so` is compiled asynchronously before `main()`;
- sets `XASH3D_BASEDIR=/xash`, `XASH3D_RODIR=/rodir`, `XASH3D_EXTRAS_PAK1=/engine/extras.pk3`,
  `LD_LIBRARY_PATH=/engine`, `HOME=/xash`, cwd `/xash`;

then calls `callMain(['-game', dir, '-ref', 'webgl2', ...defaults, ...user args])`.
Engine callbacks it handles: `Module.xash.onReady()`, `onExit(code[, reason])`,
`onError(text)` and `onFsWrite(path)` (optional; IDBFS `autoPersist` already saves on file
close, and the page also saves when it is hidden or closed).
