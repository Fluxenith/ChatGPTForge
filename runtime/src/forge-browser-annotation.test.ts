import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DurableTasks} from './durable-tasks.js';
import {ForgeBrowser} from './forge-browser.js';

test('real Chrome screenshot review supports drawn annotations, multi-frame capture, submission and artifacts',
  {timeout:90_000},async t=>{
    const root=mkdtempSync(join(realpathSync(tmpdir()),'forge-annotate-'));
    const project=join(root,'project');mkdirSync(join(project,'out'),{recursive:true});
    const server=createServer((_req,response)=>{
      response.setHeader('Content-Type','text/html; charset=utf-8');
      response.end('<!doctype html><html><head><title>Authorized review page</title></head><body style="background:#e3f5fc"><h1>Review order 10</h1><button id="next" onclick="document.querySelector(\'h1\').textContent=\'Review order 11\'">Next</button></body></html>');
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
    const engine=new DurableTasks(join(root,'state'));
    const browser=new ForgeBrowser(engine,[project],undefined,{annotationHeadless:true});
    t.after(async()=>{
      await browser.close();server.closeAllConnections();
      await new Promise<void>(resolve=>server.close(()=>resolve()));engine.close();
      rmSync(root,{recursive:true,force:true,maxRetries:6,retryDelay:100});
    });
    browser.allow(origin);
    const task=engine.create(project,'draw-review','Annotate source screenshot',['echo ok'],true);
    const run=(id:string,params:any)=>browser.run(task.task_id,id,task.lease_token!,params) as Promise<any>;
    const noIntent=(id:string)=>assert.equal(engine.db.prepare('SELECT 1 FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,id),undefined);
    assert.equal(browser.resolvedConfig().supported_actions.includes('annotate_begin'),true);
    await run('open',{action:'open',url:origin});
    await assert.rejects(run('too-early',{action:'annotate_export',path:'out/review.json'}),/Start an annotation review/);
    noIntent('too-early');
    await assert.rejects(run('missing-review',{action:'annotate_capture'}),/Start an annotation review/);
    noIntent('missing-review');

    const started=await run('review-start',{action:'annotate_begin'});
    assert.equal(started.frames,1);
    const session=(browser as any).sessions.get(task.task_id);
    const review=(browser as any).annotations.reviews.get(session.context);
    const ui=review.page;
    assert.equal((await review.context.cookies()).length,0,'review Chrome has no source cookies');
    await ui.locator('#shot').waitFor({state:'visible'});
    await ui.locator('#label').fill('Fix the heading');
    const box=await ui.locator('#markup').boundingBox();
    assert.ok(box);
    const draw=async(start:number,end:number)=>{
      await ui.mouse.move(box!.x+box!.width*start,box!.y+box!.height*start);
      await ui.mouse.down();
      await ui.mouse.move(box!.x+box!.width*end,box!.y+box!.height*end,{steps:6});
      await ui.mouse.up();
    };
    await draw(.2,.4);
    const annotated=await ui.evaluate(()=>((window as any).__forgeState()).annotations);
    assert.equal(annotated[0].annotations[0].kind,'rect');
    assert.equal(annotated[0].annotations[0].text,'Fix the heading');

    await session.page.locator('#next').click();
    await ui.locator('#capture').click();
    await ui.waitForFunction(()=>((window as any).__forgeState()).frame_ids.length===2);
    assert.equal(await ui.locator('#frames button').count(),2);
    await ui.locator('#label').fill('Second screenshot arrow');
    await ui.locator('[data-tool="arrow"]').click();
    await draw(.5,.7);
    await ui.locator('#label').fill('Freehand observation');
    await ui.locator('[data-tool="pen"]').click();
    await draw(.15,.25);
    await ui.locator('[data-tool="text"]').click();
    await ui.locator('#label').fill('Text at location');
    await ui.mouse.click(box!.x+box!.width*.45,box!.y+box!.height*.3);
    await ui.locator('#feedback').fill('Two captured states reviewed.');
    await ui.locator('#submit').click();
    await ui.waitForTimeout(200);
    assert.equal(await ui.evaluate(()=>((window as any).__forgeState()).submitted),true,
      'Review submission failed: '+await ui.locator('#message').textContent());

    const state=await run('annotation-status',{action:'annotate_status'});
    assert.equal(state.state,'submitted');
    assert.equal(state.frames,2);
    assert.equal(state.annotations,4);
    await assert.rejects(run('no-capture-after-submit',{action:'annotate_capture'}),/Reopen the submitted/);
    noIntent('no-capture-after-submit');
    await assert.rejects(run('invalid-export',{action:'annotate_export',path:'out/no.txt'}),/\.json path/);
    noIntent('invalid-export');

    const occupied=join(project,'out/review-1.png');
    writeFileSync(occupied,'preexisting');
    await assert.rejects(run('occupied-export',{action:'annotate_export',path:'out/review.json'}),/Destination already exists/);
    noIntent('occupied-export');
    assert.equal(readFileSync(occupied,'utf8'),'preexisting');
    rmSync(occupied);

    const saved=await run('annotation-export',{action:'annotate_export',path:'out/review.json'});
    assert.equal(saved.state,'exported');
    assert.equal(saved.frames,2);
    assert.equal(saved.annotation_count,4);
    assert.deepEqual(await run('annotation-export',{action:'annotate_export',path:'out/review.json'}),saved);
    const manifest=JSON.parse(readFileSync(join(project,saved.manifest),'utf8'));
    assert.equal(manifest.feedback,'Two captured states reviewed.');
    assert.deepEqual(manifest.frames.map((f:any)=>f.annotations[0].kind),['rect','arrow']);
    assert.deepEqual(manifest.frames[1].annotations.map((a:any)=>a.kind),['arrow','pen','text']);
    assert.ok(manifest.frames[1].annotations[1].points.length>2);
    for(const item of manifest.frames){
      const image=readFileSync(join(project,item.png_file));
      assert.deepEqual([...image.subarray(0,8)],[137,80,78,71,13,10,26,10]);
      assert.equal(createHash('sha256').update(image).digest('hex'),item.png_sha256);
      assert.notEqual(item.png_sha256,createHash('sha256').update(review.shots.get(item.id).png).digest('hex'),
        'annotation strokes must actually change exported screenshot pixels');
      assert.match(readFileSync(join(project,item.aria_file),'utf8'),/Review order/);
      assert.ok(item.annotations[0].width>0);
      assert.equal(item.source_url,origin+'/');
    }

    await ui.locator('#edit').click();
    assert.equal((await run('editing-state',{action:'annotate_status'})).state,'editing');
    await ui.locator('#remove').click();
    assert.equal((await run('removed-state',{action:'annotate_status'})).frames,1);
    const reviewClosed=ui.waitForEvent('close');
    await ui.locator('#remove').evaluate((button:HTMLButtonElement)=>button.click());
    await reviewClosed;
    assert.equal((await run('last-removed',{action:'annotate_status'})).review_open,false);

    await run('review-start-again',{action:'annotate_begin'});
    const captured=await run('tool-capture',{action:'annotate_capture'});
    assert.equal(captured.frames,2);
    await assert.rejects(run('export-unsubmitted',{action:'annotate_export',path:'out/draft.json'}),/Submit the screenshot review/);
    noIntent('export-unsubmitted');
    const cancelled=await run('cancel-review',{action:'annotate_cancel'});
    assert.equal(cancelled.state,'cancelled');
    assert.equal((await run('post-cancel',{action:'annotate_status'})).review_open,false);
    await run('close',{action:'close'});
  });
