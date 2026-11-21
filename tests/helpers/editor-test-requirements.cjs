'use strict';
const { existsSync } = require('node:fs');
const library = '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib';
const api = '/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/DaVinciResolveScript.pyi';
module.exports = {
  vendorLuaSkip: existsSync(library) ? false : 'Installed Resolve vendor LuaJIT is required',
  resolveApiSkip: existsSync(api) ? false : 'Installed Resolve API reference is required',
  macAttributesSkip: process.platform === 'darwin' ? false : 'macOS file attribute profile is required'
};
