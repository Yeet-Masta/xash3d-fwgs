/*
lib_emscripten.js - JavaScript side of Emscripten platform support
Copyright (C) 2026 Flying With Gauss

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.
*/

addToLibrary({
	// Emscripten's dladdr() is a stub, so save/restore can't name think/touch/use functions.
	// Function pointers in wasm are indices into the shared function table, side modules export
	// every visible function, so look the table entry up among the exports of the library.
	// Each library gets a lazily built reverse map, as savegames may name thousands of pointers.
	Emscripten_NameForFunction__deps: ['$LDSO', '$getWasmTableEntry', '$stringToUTF8'],
	Emscripten_NameForFunction: (handle, func, out, size) => {
		var dso = LDSO.loadedLibsByHandle[handle];
		if (!dso || !dso.exports)
			return 0;

		var entry;
		try {
			entry = getWasmTableEntry(func);
		} catch (e) {
			return 0;
		}

		if (!entry)
			return 0;

		if (!dso.xashNames) {
			var names = new Map();
			for (var name in dso.exports) {
				var exp = dso.exports[name];
				if (typeof exp != 'function')
					continue;

				// first name wins, so aliases resolve consistently
				if (!names.has(exp))
					names.set(exp, name);

				// look through wrappers some settings (e.g. Asyncify) put around exports
				if (exp.orig && !names.has(exp.orig))
					names.set(exp.orig, name);
			}
			dso.xashNames = names;
		}

		var found = dso.xashNames.get(entry);
		if (!found)
			return 0;

		stringToUTF8(found, out, size);
		return 1;
	},
});
