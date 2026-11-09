'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const files=[];
for(const directory of ['v2/agent','v2/market'])for(const name of fs.readdirSync(directory))if(/^test-.*\.js$/.test(name))files.push(path.join(directory,name));
const result=spawnSync(process.execPath,['--test',...files],{stdio:'inherit',windowsHide:true});
process.exitCode=result.status??1;
