// Local operator investigation. Never executes or retries the unresolved command.
import {readFileSync,realpathSync} from 'node:fs';
import {homedir,userInfo} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../dist/config.js';
import {DurableTasks} from '../dist/durable-tasks.js';
import {resolveCanonicalAllowedPath} from '../dist/roots.js';

const [mode,taskId,operationId,fingerprint,evidencePath]=process.argv.slice(2);
if(!['inspect','resolve'].includes(mode) || !taskId || (mode==='resolve' && (!operationId || !fingerprint || !evidencePath))) {
  throw new Error('Usage: node scripts/reconcile-task.mjs inspect TASK_ID | resolve TASK_ID OPERATION_ID EXPECTED_FINGERPRINT EVIDENCE_TEXT_FILE');
}
const env={...process.env,DEVSPACE_CONFIG_DIR:process.env.CHATGPTFORGE_CONFIG_DIR ?? join(homedir(),'.chatgptforge')};
delete env.DEVSPACE_OAUTH_OWNER_TOKEN;
const config=loadConfig(env);
const engine=new DurableTasks(config.stateDir);
try {
  await resolveCanonicalAllowedPath(engine.task(taskId).root,process.cwd(),config.allowedRoots.map(root=>realpathSync.native(root)));
  const result=mode==='inspect' ? engine.status(taskId) : await engine.reconcile(taskId,operationId,fingerprint,readFileSync(evidencePath,'utf8'),userInfo().username);
  console.log(JSON.stringify(result,null,2));
} finally {engine.close();}
