import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableTasks} from './durable-tasks.js';
import {ForgeBrowser,videoRecorderAvailable} from './forge-browser.js';

test('native on-demand WebM records owned tabs, chapter and action overlays with single-execution receipts',
  {timeout:90_000},async t=>{
    const root=mkdtempSync(join(realpathSync(tmpdir()),'forge-video-'));
    const project=join(root,'project');mkdirSync(join(project,'out'),{recursive:true});
    const server=createServer((_request,response)=>{
      response.setHeader('Content-Type','text/html; charset=utf-8');
      response.end('<!doctype html><body style="background:#efe"><button id="toggle" onclick="document.body.style.backgroundColor=\'#def\'">Toggle</button></body>');
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
    const engine=new DurableTasks(join(root,'state')),browser=new ForgeBrowser(engine,[project]);
    t.after(async()=>{
      await browser.close();server.closeAllConnections();
      await new Promise<void>(resolve=>server.close(()=>resolve()));engine.close();
      rmSync(root,{recursive:true,force:true,maxRetries:6,retryDelay:100});
    });
    browser.allow(origin);
    const task=engine.create(project,'video','record native browser video',['echo ok'],true);
    const run=(id:string,params:any)=>browser.run(task.task_id,id,task.lease_token!,params) as Promise<any>;
    const noIntent=(id:string)=>assert.equal(engine.db.prepare('SELECT 1 FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,id),undefined);

    assert.equal(browser.resolvedConfig().supported_actions.includes('video_start'),true);
    await run('open',{action:'open',url:origin});
    await assert.rejects(run('bad-stop',{action:'video_stop',path:'out/demo.webm'}),/Start video recording/);
    noIntent('bad-stop');
    if(!videoRecorderAvailable()){
      await assert.rejects(run('missing-ffmpeg',{action:'video_start'}),/ffmpeg component/);
      noIntent('missing-ffmpeg');
      t.diagnostic('Playwright ffmpeg unavailable: dynamic video capability rejected before recording');
      return;
    }
    await assert.rejects(run('bad-size',{action:'video_start',video_size:{width:10,height:10}}),/Video size/);
    noIntent('bad-size');
    const started=await run('video-start',{action:'video_start',video_size:{width:480,height:320},video_fps:12});
    assert.equal(started.recording,true);
    assert.equal(started.tabs_recorded,1);
    assert.equal((await run('video-status',{action:'video_status'})).video_id,started.video_id);
    await assert.rejects(run('start-twice',{action:'video_start'}),/already present/);
    noIntent('start-twice');

    const overlays=await run('actions',{action:'video_show_actions',video_duration_ms:300,video_position:'bottom-right',video_cursor:'pointer'});
    assert.equal(overlays.action_overlays,true);
    const chapter=await run('chapter',{action:'video_chapter',title:'Demo phase one',description:'Action capture',video_duration_ms:350});
    assert.equal(chapter.chapter_added,true);
    const session=(browser as any).sessions.get(task.task_id);
    await session.page.locator('#toggle').click();
    await session.page.waitForTimeout(650);
    assert.equal((await run('hide-actions',{action:'video_hide_actions'})).action_overlays,false);
    const paused=await run('video-pause',{action:'video_pause'});
    assert.equal(paused.paused,true);
    assert.equal((await run('video-paused-status',{action:'video_status'})).paused,true);
    await assert.rejects(run('double-pause',{action:'video_pause'}),/Only an active video/);
    noIntent('double-pause');
    const resumed=await run('video-resume',{action:'video_resume'});
    assert.equal(resumed.recording,true);
    assert.equal(resumed.segments,2,'resuming creates another independently playable video segment');
    await session.page.locator('#toggle').click();
    await session.page.waitForTimeout(350);
    await assert.rejects(run('bad-extension',{action:'video_stop',path:'out/demo.txt'}),/\.webm path/);
    noIntent('bad-extension');

    const tabList=await run('tabs',{action:'tabs'});
    const firstTab=tabList.tabs.find((tab:any)=>tab.active).tab_id;
    await run('new-tab',{action:'new_tab',url:origin+'/second'});
    assert.equal((await run('video-status-2',{action:'video_status'})).tabs_recorded,3);
    await run('chapter-two',{action:'video_chapter',title:'Second tab',video_duration_ms:350});
    await (browser as any).sessions.get(task.task_id).page.locator('#toggle').click();
    await (browser as any).sessions.get(task.task_id).page.waitForTimeout(550);
    await run('switch-first',{action:'switch_tab',tab_id:firstTab});
    await run('close-second',{action:'close_tab',tab_id:(await run('tabs-more',{action:'tabs'})).tabs.find((tab:any)=>!tab.active).tab_id});
    assert.equal((await run('video-status-3',{action:'video_status'})).clips_finalized,2);

    const occupied=join(project,'out/demo-1.webm');
    writeFileSync(occupied,'existing video file');
    await assert.rejects(run('duplicate-path',{action:'video_stop',path:'out/demo.webm'}),/Destination already exists/);
    noIntent('duplicate-path');
    assert.equal(readFileSync(occupied,'utf8'),'existing video file');
    rmSync(occupied);
    const stopped=await run('video-stop',{action:'video_stop',path:'out/demo.webm'});
    assert.equal(stopped.recording,false);
    assert.equal(stopped.videos.length,3);
    assert.equal(stopped.chapters.length,2);
    assert.deepEqual(stopped.chapters.map((c:any)=>c.title),['Demo phase one','Second tab']);
    assert.deepEqual(stopped.videos.map((v:any)=>v.path),['out/demo.webm','out/demo-1.webm','out/demo-2.webm']);
    for(const video of stopped.videos){
      const data=readFileSync(join(project,video.path));
      assert.ok(data.length>1500,`video ${video.path} must contain actual frames`);
      assert.deepEqual([...data.subarray(0,4)],[0x1a,0x45,0xdf,0xa3]);
      assert.equal(video.size,data.length);
      assert.ok(video.recorded_wall_ms>0);
      assert.ok(video.start_offset_ms>=0);
    }
    assert.deepEqual(await run('video-stop',{action:'video_stop',path:'out/demo.webm'}),stopped,
      'same operation id returns durable receipt without rewriting output');
    assert.equal((await run('video-status-stopped',{action:'video_status'})).recording,false);
    await assert.rejects(run('no-video',{action:'video_stop',path:'out/extra.webm'}),/Start video recording/);
    noIntent('no-video');
    await run('close',{action:'close'});
  });
