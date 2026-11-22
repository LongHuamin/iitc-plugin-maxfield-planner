#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');

var root = __dirname;
var version = '1.3.10';

var userscriptHeader = [
  '// ==UserScript==',
  '// @id             iitc-plugin-maxfield-planner@iitc',
  '// @name           IITC plugin: maxfield-planner',
  '// @category       Draw',
  '// @version        ' + version,
  '// @namespace      iitc-plugin-maxfield-planner',
  '// @description    在地图上直接点选 portal，用 Fan Fields 2 原版规划算法（锚点 Cycle Start、顺/逆时针、Inbound/Outbound）生成 field 最大化的 link 与行走顺序。统计层数、link、portal 与 AP。支持中英文与深浅色主题。兼容 IITC 桌面端与 IITC Mobile。本插件是 Fan Fields 2（ISC，© 2018-2025 IITC plugin: Fan Fields 2 / Justus Kenklies）规划引擎的派生作品，不是官方 Fan Fields 2。',
  '// @include        https://intel.ingress.com/*',
  '// @include        http://intel.ingress.com/*',
  '// @include        https://*.ingress.com/intel*',
  '// @include        http://*.ingress.com/intel*',
  '// @match          https://intel.ingress.com/*',
  '// @match          https://intel.ingress.com/*/*',
  '// @recommends     keys@xelio|liveInventory@DanielOnDiordna',
  '// @grant          none',
  '// @updateURL https://raw.githubusercontent.com/LongHuamin/iitc-plugin-maxfield-planner/main/iitc-plugin-maxfield-planner.meta.js',
  '// @downloadURL https://raw.githubusercontent.com/LongHuamin/iitc-plugin-maxfield-planner/main/iitc-plugin-maxfield-planner.user.js',
  '// ==/UserScript=='
].join('\n') + '\n';

var header = userscriptHeader + [
  '',
  '/*',
  ' * Planning engine derived from Fan Fields 2 2.8.4.20260912 by Heistergand.',
  ' *',
  ' * ISC License',
  ' *',
  ' * Copyright © 2018-2025 IITC plugin: Fan Fields 2',
  ' * Copyright © 2018 Justus Kenklies',
  ' *',
  ' * Permission to use, copy, modify, and/or distribute this software for',
  ' * any purpose with or without fee is hereby granted, provided that the',
  ' * above copyright notice and this permission notice appear in all',
  ' * copies.',
  ' *',
  ' * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL',
  ' * WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED',
  ' * WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE',
  ' * AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL',
  ' * DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA',
  ' * OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER',
  ' * TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR',
  ' * PERFORMANCE OF THIS SOFTWARE.',
  ' */',
  ''
].join('\n');

var geo = fs.readFileSync(path.join(root, 'engine/geo.js'), 'utf8');
var engine = fs.readFileSync(path.join(root, 'engine/fanfields2-engine.js'), 'utf8');
var favSync = fs.readFileSync(path.join(root, 'src/fav-sync.js'), 'utf8');
var crossLinks = fs.readFileSync(path.join(root, 'src/cross-links.js'), 'utf8');
var ui = fs.readFileSync(path.join(root, 'src/plugin-ui.js'), 'utf8');

var wrapperOpen = [
  'function wrapper(plugin_info) {',
  "  'use strict';",
  "  var MFP_VERSION = '" + version + "';",
  '',
].join('\n');

var wrapperClose = [
  '',
  '  function setup() {',
  '    var p = window.plugin && window.plugin.maxfieldPlanner;',
  '    if (p && plugin_info && plugin_info.script && plugin_info.script.version) {',
  '      p.VERSION = String(plugin_info.script.version);',
  '    }',
  "    if (p && typeof p.init === 'function') p.init();",
  '  }',
  '',
  '  setup.info = plugin_info;',
  '  if (!window.bootPlugins) window.bootPlugins = [];',
  '  window.bootPlugins.push(setup);',
  "  if (window.iitcLoaded && typeof setup === 'function') setup();",
  '}',
  '',
].join('\n');

var boot = "\nvar script = document.createElement('script');\nvar info = {};\nif (typeof GM_info !== 'undefined' && GM_info && GM_info.script) {\n  info.script = {\n    version: GM_info.script.version,\n    name: GM_info.script.name,\n    description: GM_info.script.description\n  };\n}\nscript.appendChild(document.createTextNode('(' + wrapper + ')(' + JSON.stringify(info) + ');'));\n(document.body || document.head || document.documentElement).appendChild(script);\n";

var outPath = path.join(root, 'iitc-plugin-maxfield-planner.user.js');
fs.writeFileSync(outPath, header + wrapperOpen + '\n' + geo + '\n' + engine + '\n' + favSync + '\n' + crossLinks + '\n' + ui + '\n' + wrapperClose + boot);
console.log('wrote', outPath, fs.statSync(outPath).size, 'bytes');

var metaPath = path.join(root, 'iitc-plugin-maxfield-planner.meta.js');
fs.writeFileSync(metaPath, userscriptHeader);
console.log('wrote', metaPath, fs.statSync(metaPath).size, 'bytes');
