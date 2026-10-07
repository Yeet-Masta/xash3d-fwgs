# Web (Emscripten / WebAssembly) port

Xash3D FWGS can be built for the browser with [Emscripten](https://emscripten.org/). Half-Life
([hlsdk-portable](https://github.com/FWGS/hlsdk-portable)) and Counter-Strike 1.6
([cs16-client](https://github.com/Velaron/cs16-client), with ReGameDLL_CS and YaPB bots) run in
the page with game files the player supplies as a zip. No game data is ever part of the build.

## How it fits together

* The engine is the Emscripten **main module** (`xash.js` + `xash.wasm`, linked with
  `-sMAIN_MODULE=1`, so it exports libc, libc++, SDL2 and GL to everything else).
* Everything the engine normally `dlopen()`s is a wasm **side module** with the usual name and
  a `.so` suffix: `filesystem_stdio.so`, `libref_webgl2.so`, `libmenu.so` and the game
  libraries `<gamedir>/dlls/<name>_emscripten_wasm32.so` and
  `<gamedir>/cl_dlls/client_emscripten_wasm32.so`.
  Side modules must be linked with `-sSIDE_MODULE=1 -Wl,-Bsymbolic`: Emscripten's GOT is shared
  by all modules, so without `-Bsymbolic` a library's references to its own symbols can bind to
  identically named symbols of another library (e.g. the HL server to the client's weapon
  prediction stubs).
* The renderer is `ref_gl` built as `ref_webgl2`: gl2_shim emulates the fixed function pipeline
  on top of WebGL2 (GLSL ES 3.00, no buffer mapping).
* The browser owns the main loop: `Host_Main` initializes the engine and hands the frame loop to
  `emscripten_set_main_loop_arg`, one frame per `requestAnimationFrame`. There is no ASYNCIFY
  and there are no threads, so no special HTTP headers (COOP/COEP) are needed.
* `dladdr()` is a stub in Emscripten, so `COM_NameForFunction` (needed by save/restore and level
  transitions) maps the function pointer back to its export name through the dynamic linker's
  tables (`engine/platform/emscripten/lib_emscripten.js`).
* The page (`web/`, see [web/README.md](../web/README.md)) mounts the game zip lazily under
  `/rodir`, puts the libraries in place, keeps `/xash` (configs, saves) in IndexedDB and calls
  `main()`. Fatal errors and quitting are reported to the page through `Module.xash` callbacks,
  the page has to be reloaded to start again.

## Building

Builds run on Linux or WSL with the Emscripten SDK (tested with 6.0.11) and, for cs16-client,
CMake. Clone hlsdk-portable and cs16-client (with submodules) next to this repository, then:

```sh
source ~/emsdk/emsdk_env.sh
scripts/emscripten/build-all.sh   # engine, hlsdk-portable, cs16-client, launcher -> build-web/
```

Single components: `scripts/emscripten/build-engine.sh`, `build-hlsdk.sh`, `build-cs16.sh`,
`assemble.py` (each script documents its environment variables). The engine alone is
`./waf configure --emscripten -T release && ./waf build && ./waf install --destdir=...`.

## Running

Serve `build-web/` with any static web server that sends `.wasm` as `application/wasm`
(`python3 scripts/emscripten/assemble.py --serve-only` or `python3 -m http.server -d build-web`),
open it, drop a zip with your `valve` (and `cstrike`) folder and press Play.

## Limitations

* Single player and listen servers only: there is no networking with other players yet.
* AVI/BIK videos are not played.
* The engine can't restart in place (changing game, `quit`, fatal errors): reload the page.
* The whole zip is kept in memory while playing (compressed); about 1-1.5 GB of RAM is needed
  for Half-Life plus Counter-Strike.
