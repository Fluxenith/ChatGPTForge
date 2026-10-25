import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const task = 'task_2aad700a29110b3bab49b29f';
const state = path.join(os.homedir(), '.chatgptforge/state/forge-tasks.sqlite');
const db = new Database(state, { readonly: true, fileMustExist: true });
try {
  const rows = db.prepare('SELECT id,state,request,result FROM browser_operations WHERE task_id=? ORDER BY rowid').all(task);
  const output = path.resolve('../artifacts');
  const operations = rows.map(row => {
    const request=JSON.parse(row.request),result=row.result?JSON.parse(row.result):null;
    if(result?.image) {
      fs.writeFileSync(path.join(output,'browser-live-product.png'),Buffer.from(result.image,'base64'));
      delete result.image;result.image_file='browser-live-product.png';
    }
    return {operation_id:row.id,state:row.state,request,result};
  });
  fs.writeFileSync(path.join(output,'browser-live-receipts.json'),JSON.stringify({task_id:task,operations},null,2));
  console.log(JSON.stringify({operations:operations.length,states:operations.map(o=>({id:o.operation_id,state:o.state,action:o.request.action}))}));
} finally {db.close();}
