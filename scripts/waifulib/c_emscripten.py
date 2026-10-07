#!/usr/bin/env python
# encoding: utf-8
# c_emscripten.py -- platform modifiers for Emscripten's clang wrappers (emcc/em++)
#
# Loaded from xcompile.py when --emscripten is passed. Compiler detection itself is done by
# waf's stock clang/clang++ tools (emcc defines __clang__), they call
# gcc_modifier_<DEST_OS>/gxx_modifier_<DEST_OS> after get_cc_version(), which we provide here.

from waflib.Configure import conf
from waflib.TaskGen import feature, after_method

def _common(conf, lang):
	v = conf.env
	# waf does not know wasm in MACRO_TO_DEST_CPU
	v.DEST_CPU = 'wasm32'
	v.DEST_BINFMT = 'wasm'

	# main program: emcc emits <name>.js + <name>.wasm
	v[lang + 'program_PATTERN'] = '%s.js'
	# shared libraries are real wasm side modules, keep ELF-like naming expected by the engine
	# and by Emscripten's wasm preload plugin, which only handles names ending in .so
	v[lang + 'shlib_PATTERN'] = 'lib%s.so'

	flags = 'CFLAGS' if lang == 'c' else 'CXXFLAGS'
	# everything that ends up in a MAIN_MODULE or SIDE_MODULE must be PIC
	v[flags + '_' + lang + 'shlib'] = ['-fPIC']
	v[flags + '_' + lang + 'stlib'] = ['-fPIC']
	v[flags + '_' + lang + 'program'] = ['-fPIC']

	# -shared alone emits a static object ("emulated dynamic linking"), -sSIDE_MODULE emits real dylink.0 wasm
	# Emscripten's GOT is process-wide, -Bsymbolic keeps a module's references to its own symbols local,
	# otherwise identically named symbols (e.g. client weapon prediction stubs vs server entities)
	# get interposed by whichever module was loaded first
	v['LINKFLAGS_' + lang + 'shlib'] = ['-sSIDE_MODULE=1', '-Wl,-Bsymbolic']
	# MAIN_MODULE is NOT added here, otherwise every configure check would link a full main module.
	# It's added in engine/wscript for the xash target.
	v['LINKFLAGS_' + lang + 'program'] = []

	# no sonames/rpath in wasm
	v.SONAME_ST = []
	v.RPATH_ST = []

@conf
def gcc_modifier_emscripten(conf):
	_common(conf, 'c')

@conf
def gxx_modifier_emscripten(conf):
	_common(conf, 'cxx')

@feature('cxxprogram', 'cprogram')
@after_method('apply_link')
def apply_emscripten_outputs(self):
	if self.env.DEST_OS != 'emscripten':
		return

	# declare side outputs, so waf knows about them (install, clean)
	tsk = self.link_task
	tsk.outputs.append(tsk.outputs[0].change_ext('.wasm'))

def configure(conf):
	pass
