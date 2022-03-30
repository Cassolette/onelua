const fs = require("fs");
const path = require("path");
const luamin = require("luamin");
const resolver = require('resolve').sync;
const luaprint = require("./luaprint");

class LuaPackage {
    /**
     *
     * @param {{}} pkg_config
     * @param {string} pkg_path
     */
    constructor(pkg_config, pkg_dir, pkg_script) {
        /** The package.json object */
        this.packageConfig = pkg_config;
        /** The path to the package's root dir */
        this.packageDir = pkg_dir;
        /** The path to the main Lua script */
        this.mainScriptPath = pkg_script
        /** The path to the main Lua script's dir */
        this.mainDir = path.dirname(pkg_script);
    }

    /**
     * Absolute path to the package.json of the package
     * @param {*} package_json_path
     * @returns {LuaPackage?}
     */
    static fromPackageJson(package_json_path) {
        var pkg_cfg = require(package_json_path);
        if (!pkg_cfg)
            return null;  // package.json not found

        if (!pkg_cfg.onelua || !pkg_cfg.onelua.main)
            return null;  // package.json found, but no onelua instructions / entry file

        var pkg_path = path.dirname(package_json_path);
        var pkg_script = path.resolve(pkg_path, pkg_cfg.onelua.main)
        if (!fs.existsSync(pkg_script))
            return null;  // main script doesn't exist

        return new LuaPackage(pkg_cfg, pkg_path, pkg_script);
    }
}

class LuaScript {
    /**
     * @param {string} path_absol
     * @param {LuaPackage?} pkg
     */
    constructor(path_absol, pkg) {
        this.path = path_absol;
        /**
         * The script's package object
         * @type {LuaPackage}
         */
        this.package = pkg;
        this.baseDir = path.dirname(path_absol);
    }

    get contents() {
        return fs.readFileSync(this.path, 'utf-8');
    }

    exists() {
        return fs.existsSync(this.path);
    }
}

class OLProcessor {
    constructor(entry, options) {
        this.debug = options.debug;
        this.minify = options.minify;
        this.entryScript = new LuaScript(path.resolve(entry));
        // // Search paths for packages
        // this.packagePaths = [
        //     "?.lua",
        //     "?/init.lua",
        //     "?/?.lua"
        // ]

        if (!this.entryScript.exists()) throw "Entry script doesn't exist!";
    }

    process() {
        var modulesIds = {};  /* path: id */
        var modulesAst = {};  /* id: ast */
        var mainAst = null;

        var currModuleId = 0;

        /**
         *
         * @param {LuaScript} script
         * @param {boolean} is_entry
         * @returns {number} moduleId
         */
        var recurseResolve = (script, is_entry) => {
            if (script.path in modulesIds) {
                /* already resolved */
                if (this.debug) console.log("> already resolved .")
                return modulesIds[script.path];
            }

            /* delete luaparse cache */
            require("decache")("luaparse");
            const luaparse = require("luaparse");

            /**
             *
             * @param {LuaScript} base_script
             * @param {string} module
             * @returns {LuaScript?}
             */
            var get_required = (base_script, module) => this.#getRequiredModule(base_script, module);  // expose function to luaparse

            var new_astnode = (module, node) => {
                let required = get_required(script, module);
                if (required == null)
                    throw `Invalid require: module "${module}" was not found in ${script.path}:${node.base.loc.start.line}`;

                if (this.debug) console.log(`found module in ${required.path}`);

                // call recursive
                var module_id = recurseResolve(required, false);
                if (this.debug) console.log(`got back id of ${module_id} (resolving for ${script.path})`);

                return {
                    "type": "CallExpression",
                    "base": {
                        "type": "Identifier",
                        "name": "__OL__require",
                        "isLocal": true
                    },
                    "arguments": [
                        {
                            "type": "NumericLiteral",
                            "value": module_id,
                            "raw": module_id.toString()
                        }
                    ]
                }
            }

            var originalStringCall = luaparse.ast["stringCallExpression"];
            luaparse.ast["stringCallExpression"] = function () {
                var node = originalStringCall.apply(null, arguments);
                if (node.base.type == "Identifier" && node.base.name == "require") {
                    //console.log(require("util").inspect(node, {showHidden: false, depth: null}))
                    let arg = node.argument;

                    // replace ast to point to new module
                    node = new_astnode(arg.value, node);
                }
                return node;
            }

            var originalCall = luaparse.ast["callExpression"];
            luaparse.ast["callExpression"] = function () {
                var node = originalCall.apply(null, arguments);
                if (node.base.type == "Identifier" && node.base.name == "require") {
                    //console.log(require("util").inspect(node, {showHidden: false, depth: null}))
                    let first_arg = node.arguments[0];
                    if (first_arg.type != "StringLiteral") throw `Invalid require: expected require() argument of type StringLiteral, got ${first_arg.type}`;

                    // replace ast to point to new module
                    node = new_astnode(first_arg.value, node);
                }
                return node;
            };

            if (this.debug) console.log("!!!!!! parsing ast for " + script.path)
            //try {
            var ast = luaparse.parse(script.contents, {
                encodingMode: 'x-user-defined',
                scope: true,
                comments: true,
                locations: true
            });
            //console.log(require("util").inspect(ast, {depth:4}))
            //}catch (err){ console.log(err) }

            if (this.debug) console.log("-----finished parse ast for " + script.path)

            if (is_entry) {
                mainAst = ast;
            } else {
                currModuleId++;
                modulesIds[script.path] = currModuleId;
                //if (this.debug) console.dir(modulesIds)
                if (this.debug) console.log("! The module '" + script.path + `' was resolved with id: ${currModuleId}`)

                modulesAst[currModuleId] = ast;
                return currModuleId;
            }
        }

        recurseResolve(this.entryScript, true);

        // merge the asts finally
        /*Object.keys(modulesAst).forEach((key) => {
            //console.dir(modulesAst[key]);
        });*/

        if (this.debug) {
            console.log("MODULESast:"); console.dir(modulesAst);
            console.log("MAINast:"); console.dir(mainAst);
        }

        var finalAst = this.#createFinalAst(modulesIds, modulesAst, mainAst);

        return this.minify ? luamin.minify(finalAst) : luaprint(finalAst);
    }


    /**
     * Get the associated LuaScript from this context
     * @param {LuaScript} base_script - The script that is including the module
     * @param {string} module - Module name
     * @returns {LuaScript?}
     */
    #getRequiredModule(base_script, module) {
        var base_dir = base_script.baseDir;
        /* first convert . to / */
        module = module.replace(/\./g, "/");

        var script_path = null;
        if (this.debug) console.log(module + ".lua")

        /* next, find the module relative to the baseDir */
        script_path = path.join(base_dir, module + ".lua");
        if (fs.existsSync(script_path))
            return new LuaScript(script_path, base_script.package); // same pkg

        /* then find the module relative to the script's main dir */
        if (base_script.package) {
            script_path = path.join(base_script.package.mainDir, module + ".lua");
            if (fs.existsSync(script_path))
                return new LuaScript(script_path, base_script.package); // same pkg
        } else {
            // entry script?
            var entry_dir = this.entryScript.baseDir;
            script_path = path.join(entry_dir, module + ".lua");
            if (fs.existsSync(script_path))
                return new LuaScript(script_path, null);
        }

        /* finally, find the module installed with npm */
        //console.dir(require.resolve.paths(module))
        let nodeModPath = null;
        /** @type {string?} */
        let pkgPath
        try {
            nodeModPath = resolver(module, {
                basedir: base_dir,
                extensions: [".lua"],
                includeCoreModules: false,
                // "(Note: the second argument will change to "pkgfile" in v2)"
                packageFilter: (pkgJson, pkgDir) => {
                    pkgPath = pkgDir
                    // edit pkg json to search onelua main
                    pkgJson["main"] = pkgJson["onelua"]["main"]
                    return pkgJson
                }
            });
        } catch (e) { if (this.debug) console.error(e) }

        if (this.debug) console.debug(module, nodeModPath, pkgPath)
        if (!nodeModPath)
            return null;

        var pkg = LuaPackage.fromPackageJson(path.join(pkgPath, "/package.json"));
        if (!pkg)
            return null;  // invalid OL package

        return new LuaScript(nodeModPath, pkg);
    }

    #createFinalAst(modulesIds, modulesAst, mainAst) {
        var finalAst = {
            "type": "Chunk",
            "body": [
                {
                    "type": "LocalStatement",
                    "variables": [
                        {
                            "type": "Identifier",
                            "name": "__OL__require",
                            "isLocal": true
                        }
                    ],
                    "init": []
                }
            ],
            "comments": [],
            "globals": []
        };

        /* ast utils */
        var createRequireDef = (key, ast) => {
            return {
                "type": "AssignmentStatement",
                "variables": [
                    {
                        "type": "IndexExpression",
                        "base": {
                            "type": "Identifier",
                            "name": "__OL__packages",
                            "isLocal": true
                        },
                        "index": {
                            "type": "NumericLiteral",
                            "value": key,
                            "raw": key.toString()
                        }
                    }
                ],
                "init": [
                    {
                        "type": "FunctionDeclaration",
                        "identifier": null,
                        "isLocal": false,
                        "parameters": [

                        ],
                        "body": ast
                    }
                ]
            }
        }

        /* define packages */
        finalAst.body.push({
            "type": "LocalStatement",
            "variables": [
                {
                    "type": "Identifier",
                    "name": "__OL__packages",
                    "isLocal": true
                }
            ],
            "init": [
                {
                    "type": "TableConstructorExpression",
                    "fields": []
                }
            ]
        });

        Object.keys(modulesAst).forEach((id) => {
            finalAst.body.push(createRequireDef(id, modulesAst[id].body));
            finalAst.globals.push(...modulesAst[id].globals);  // extend globals
        });

        /* define One-lua require() function */
        finalAst.body.push({
            "type": "LocalStatement",
            "variables": [
                {
                    "type": "Identifier",
                    "name": "__OL__cached_packages",
                    "isLocal": true
                }
            ],
            "init": [
                {
                    "type": "TableConstructorExpression",
                    "fields": []
                }
            ]
        });
        finalAst.body.push({
            "type": "AssignmentStatement",
            "variables": [
                {
                    "type": "Identifier",
                    "name": "__OL__require",
                    "isLocal": true
                }
            ],
            "init": [
                {
                    "type": "FunctionDeclaration",
                    "identifier": null,
                    "isLocal": false,
                    "parameters": [
                        {
                            "type": "Identifier",
                            "name": "id",
                            "isLocal": true
                        }
                    ],
                    "body": [
                        {
                            "type": "IfStatement",
                            "clauses": [
                                {
                                    "type": "IfClause",
                                    "condition": {
                                        "type": "IndexExpression",
                                        "base": {
                                            "type": "Identifier",
                                            "name": "__OL__cached_packages",
                                            "isLocal": true
                                        },
                                        "index": {
                                            "type": "Identifier",
                                            "name": "id",
                                            "isLocal": true
                                        }
                                    },
                                    "body": [
                                        {
                                            "type": "ReturnStatement",
                                            "arguments": [
                                                {
                                                    "type": "IndexExpression",
                                                    "base": {
                                                        "type": "Identifier",
                                                        "name": "__OL__cached_packages",
                                                        "isLocal": true
                                                    },
                                                    "index": {
                                                        "type": "Identifier",
                                                        "name": "id",
                                                        "isLocal": true
                                                    }
                                                }
                                            ]
                                        }
                                    ]
                                }
                            ]
                        },
                        {
                            "type": "LocalStatement",
                            "variables": [
                                {
                                    "type": "Identifier",
                                    "name": "package",
                                    "isLocal": true
                                }
                            ],
                            "init": [
                                {
                                    "type": "CallExpression",
                                    "base": {
                                        "type": "IndexExpression",
                                        "base": {
                                            "type": "Identifier",
                                            "name": "__OL__packages",
                                            "isLocal": true
                                        },
                                        "index": {
                                            "type": "Identifier",
                                            "name": "id",
                                            "isLocal": true
                                        }
                                    },
                                    "arguments": []
                                }
                            ]
                        },
                        {
                            "type": "AssignmentStatement",
                            "variables": [
                                {
                                    "type": "IndexExpression",
                                    "base": {
                                        "type": "Identifier",
                                        "name": "__OL__cached_packages",
                                        "isLocal": true
                                    },
                                    "index": {
                                        "type": "Identifier",
                                        "name": "id",
                                        "isLocal": true
                                    }
                                }
                            ],
                            "init": [
                                {
                                    "type": "Identifier",
                                    "name": "package",
                                    "isLocal": true
                                }
                            ]
                        },
                        {
                            "type": "ReturnStatement",
                            "arguments": [
                                {
                                    "type": "Identifier",
                                    "name": "package",
                                    "isLocal": true
                                }
                            ]
                        }
                    ]
                }
            ]
        });

        /* add main */
        finalAst.body.push(...mainAst.body);  // extend body
        finalAst.globals.push(...mainAst.globals);  // extend globals

        if (this.debug) console.dir(JSON.stringify(finalAst))

        return finalAst;
    }
};

module.exports = {
    /**
     * @param {string} entry - Absolute path to the Lua script or project directory
     * @param {{}} options
     * @returns {string}
     * @throws Throws on any error
     */
    process: (entry, options) => {
        return new OLProcessor(entry, options).process();
    },
};
