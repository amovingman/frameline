"""Execute a caller-supplied read-only API mock in an explicitly selected Lua library.

This test harness does not connect to Resolve or load a user project.
"""
import ctypes
import sys


def run():
    if len(sys.argv) != 2:
        raise ValueError('usage')
    source = sys.stdin.buffer.read(4 * 1024 * 1024 + 1)
    if not source or len(source) > 4 * 1024 * 1024 or b'\x00' in source:
        raise ValueError('mock-size')
    library = ctypes.CDLL(sys.argv[1])
    library.luaL_newstate.restype = ctypes.c_void_p
    library.luaL_openlibs.argtypes = [ctypes.c_void_p]
    library.luaL_loadstring.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    library.luaL_loadstring.restype = ctypes.c_int
    library.lua_pcall.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int]
    library.lua_pcall.restype = ctypes.c_int
    library.lua_close.argtypes = [ctypes.c_void_p]
    state = library.luaL_newstate()
    if not state:
        raise ValueError('mock-runtime')
    try:
        library.luaL_openlibs(state)
        if library.luaL_loadstring(state, source) != 0 or library.lua_pcall(state, 0, 0, 0) != 0:
            raise ValueError('mock-execution')
    finally:
        library.lua_close(state)


if __name__ == '__main__':
    try:
        run()
    except Exception:
        print('lua-observation-mock-failed', file=sys.stderr)
        sys.exit(1)
