import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {desktopCall} from './forge-desktop.js';

// Run only against a disposable Windows fixture explicitly launched by the
// operator; the ordinary suite never opens or operates another user's apps.
test('native window capture and screenshot pointer bounds on owned fixture',{
  skip:process.platform!=='win32'||!process.env.FORGE_DESKTOP_VISUAL_FIXTURE,
},async()=>{
  const receipt=JSON.parse(readFileSync(process.env.FORGE_DESKTOP_VISUAL_FIXTURE!,'utf8').replace(/^\uFEFF/,''));
  const base={pid:receipt.pid,creation:receipt.creation,hwnd:receipt.hwnd};
  const captured=await desktopCall({...base,action:'screenshot'});
  assert.equal(captured.state,'captured');
  assert.ok(captured.capture_method==='windows_graphics_capture'||captured.capture_method.startsWith('print_window'));
  if(process.env.FORGE_DESKTOP_REQUIRE_WGC==='1')assert.equal(captured.capture_method,'windows_graphics_capture');
  assert.ok(captured.width>=300&&captured.image_width>0);
  assert.ok(captured.height>=200&&captured.image_height>0);
  const bytes=Buffer.from(captured.image,'base64');
  assert.ok(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  const observed=await desktopCall({...base,action:'observe'});
  assert.ok(Array.isArray(observed.controls));
  assert.equal(observed.state,'captured');
  assert.equal(observed.width,captured.width);
  // A forged geometry must be rejected before activation or any SendInput.
  await assert.rejects(desktopCall({
    ...base,action:'click',coordinate_space:'window',input_mode:'physical',button:'left',
    x:10,y:10,capture:{
      window_x:captured.window_x,window_y:captured.window_y,
      width:captured.width+1,height:captured.height,
      image_width:captured.image_width,image_height:captured.image_height,
    },
  }),/moved or resized since screenshot/);
});
