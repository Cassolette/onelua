# Onelua

Lua script merger bringing in the NPM workflow. Compiles multiple Lua scripts into one single script, and enables tracking of remote Lua packages via `npm install`.

Onelua taps on to the versatility of the [LuaParse](https://github.com/fstirlitz/luaparse) library to generate Abstract Syntax Trees (AST) to enable detection of `require()` calls, and loads them statically into the final Lua script. Finally, the [Luamin](https://github.com/mathiasbynens/luamin) library translates these ASTs into a compact, minified Lua script.

## Usage
For simplicity's sake, we'll use [npm](https://www.npmjs.com/) only, so be sure to have it installed beforehand!

### Merging Lua scripts
```
npm install @cassolette/onelua
```

In your Lua project, include build instructions for Onelua, where `main` refers to the entrypoint Lua script, and `output` refers to the output (resultant) Lua script.
```
"scripts": {
  "build": "onelua .",
  "start": "lua52 out.lua"
},
"onelua": {
  "main": "main.lua",
  "output": "out.lua"
}
```

### Publishing a Lua package
To expose a Lua package via NPM, in its `package.json`, be sure to specify the entrypoint Lua script to export.

Consider a package named `deptest`:
```
"name": "deptest",
"onelua": {
  "main": "deptest.lua"
},
```

Which can be require()-ed by other Lua modules like so:
```
local deptest = require('deptest')
```

### Command-line (CLI) options
The following command-line arguments are supported. An exhaustive list can be found by running `onelua --help`.

* #### ``--no-minify`` **Experimental**
Turn off minified output. If specified will use `luaprint` instead of `luamin` to output the luaparse AST. Note that `luaprint` is experimental and not guaranteed to be reliable.

* #### ``--prepend-meta``
Prepend the name and date-time generated of the file in the output as block comments.
Example:
```lua
--[[
  deptest.lua
  Generated on Thu, 01 Jan 1970 00:00:00 GMT
]]--
```

Example usage which outputs non-minified Lua script:
```
"scripts": {
  "build": "onelua . --no-minify",
}
```

## Example
* [Example repository](https://github.com/cngc4e/LuaAppTest)
