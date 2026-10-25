import {loadConfig} from '../runtime/dist/config.js';
const config=loadConfig({...process.env,DEVSPACE_CONFIG_DIR:process.argv[2]});
if(config.host!=='127.0.0.1')throw Error('Forge local readiness requires a loopback listener');
if(config.subagents.enabled || config.subagents.providers.length)throw Error('Model providers must remain disabled');
console.log(JSON.stringify({host:config.host,port:config.port,skillsManagerEndpoint:config.skillsManagerEndpoint??null}));
