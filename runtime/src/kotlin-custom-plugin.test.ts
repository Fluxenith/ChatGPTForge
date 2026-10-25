import test from 'node:test';
import assert from 'node:assert/strict';
import {validateKotlinCompiler,kotlinSettings} from './kotlin-compiler-settings.js';
test('native custom plugin IDs permit scalar options without allowing uncaptured paths',()=>{
 const c={pluginIds:['demo.check'],pluginOptions:['plugin:demo.check:mode=strict'],pluginClasspaths:['.forge/kotlin-import/run/plugins/check.jar']};
 assert.match(kotlinSettings('main',['src'],c).compilerArguments,/demo.check:mode=strict/);
 for(const option of ['plugin:missing:mode=strict','plugin:demo.check:configFile=relative.txt','plugin:demo.check:mode=C:/external','plugin:demo.check:mode=../../escape','plugin:demo.check:mode=https://example.com'])assert.throws(()=>validateKotlinCompiler({...c,pluginOptions:[option]}),/Unrepresented/);
 assert.throws(()=>validateKotlinCompiler({...c,pluginIds:['bad:id']}),/Invalid/);
});
