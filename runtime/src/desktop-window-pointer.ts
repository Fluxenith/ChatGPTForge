// Screenshot-driven pointer input for an explicitly granted HWND. The coordinates
// are image pixels from the latest window capture, never desktop coordinates.
// This path does not depend on the target application exposing UIA controls.
import {inputGuardSource} from './desktop-input-guard.js';
export const desktopWindowPointerNative = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ForgeWindowPointer {
 [StructLayout(LayoutKind.Sequential)] struct Rect {public int Left,Top,Right,Bottom;}
 [StructLayout(LayoutKind.Sequential)] struct Point {public int x,y;}
 [StructLayout(LayoutKind.Sequential)] struct MouseInput {public int x,y;public uint data,flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Explicit)] struct InputData {[FieldOffset(0)] public MouseInput mouse;}
 [StructLayout(LayoutKind.Sequential)] struct Input {public uint type;public InputData data;}
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
 [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent,IntPtr child);
 [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
 [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
 [DllImport("user32.dll")] static extern uint SendInput(uint count,Input[] inputs,int size);
 [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd,int attribute,out Rect rect,int size);

 static Input Mouse(uint flags,int x,int y) {
  return new Input {type=0,data=new InputData {mouse=new MouseInput {flags=flags,x=x,y=y}}};
 }
 static Point Pixel(int x,int y,Rect rect,int imageWidth,int imageHeight) {
  return new Point {
   x=rect.Left+(int)Math.Floor((x+0.5)*(rect.Right-rect.Left)/imageWidth),
   y=rect.Top+(int)Math.Floor((y+0.5)*(rect.Bottom-rect.Top)/imageHeight)
  };
 }
 static bool Matches(Rect rect,int left,int top,int width,int height) {
  return rect.Left==left&&rect.Top==top&&rect.Right-rect.Left==width&&rect.Bottom-rect.Top==height;
 }
 static Rect CaptureRect(IntPtr hwnd,Rect window,int left,int top,int width,int height) {
  if(Matches(window,left,top,width,height))return window;
  Rect visible;
  if(DwmGetWindowAttribute(hwnd,9,out visible,Marshal.SizeOf(typeof(Rect)))==0&&Matches(visible,left,top,width,height))return visible;
  throw new InvalidOperationException("Window moved or resized since screenshot; observe again");
 }
 public static void Perform(IntPtr hwnd,string action,string button,int x,int y,int endX,int endY,
  int expectedX,int expectedY,int width,int height,int imageWidth,int imageHeight) {
  if(action!="click"&&action!="double_click"&&action!="drag")
   throw new InvalidOperationException("Unsupported screenshot pointer action");
  if(button!="left"&&button!="right")throw new InvalidOperationException("Unsupported mouse button");
  if(imageWidth<1||imageHeight<1||width<1||height<1
   ||x<0||y<0||endX<0||endY<0||x>=imageWidth||endX>=imageWidth||y>=imageHeight||endY>=imageHeight)
   throw new InvalidOperationException("Pointer is outside the authorized screenshot");
  if(!IsWindowVisible(hwnd)||IsIconic(hwnd))throw new InvalidOperationException("Authorized window is not visible");
  Rect rect;
  if(!GetWindowRect(hwnd,out rect))throw new InvalidOperationException("Authorized window bounds unavailable");
  var capture=CaptureRect(hwnd,rect,expectedX,expectedY,width,height);
  foreach(int key in new[]{1,2,4,5,6,0x10,0x11,0x12,0x5b,0x5c})
   if((GetAsyncKeyState(key)&0x8000)!=0)
    throw new InvalidOperationException("Release held mouse buttons and modifiers first");
  ForgePointerGuard.Check();SetForegroundWindow(hwnd);
  if(GetForegroundWindow()!=hwnd)throw new InvalidOperationException("Authorized window could not become foreground");
  if(!GetWindowRect(hwnd,out rect))throw new InvalidOperationException("Authorized window bounds unavailable");
  capture=CaptureRect(hwnd,rect,expectedX,expectedY,width,height);
  int left=GetSystemMetrics(76),top=GetSystemMetrics(77),screenW=GetSystemMetrics(78),screenH=GetSystemMetrics(79);
  if(screenW<2||screenH<2)throw new InvalidOperationException("Virtual desktop bounds unavailable");
  var moves=new List<Input>();
  int steps=action=="drag"?12:0;
  for(int i=0;i<=steps;i++) {
   int px=steps==0?x:x+(endX-x)*i/steps,py=steps==0?y:y+(endY-y)*i/steps;
   var point=Pixel(px,py,capture,imageWidth,imageHeight);
   var hit=WindowFromPoint(point);
   if(hit!=hwnd&&!IsChild(hwnd,hit))
    throw new InvalidOperationException("Screenshot pointer path is covered by another window");
   if(point.x<left||point.y<top||point.x>=left+screenW||point.y>=top+screenH)
    throw new InvalidOperationException("Screenshot pointer path is outside the visible desktop");
   moves.Add(Mouse(0x8000u|0x4000u|0x2000u|1u,
    (int)Math.Round((point.x-left)*65535.0/(screenW-1)),
    (int)Math.Round((point.y-top)*65535.0/(screenH-1))));
  }
  if(GetForegroundWindow()!=hwnd)throw new InvalidOperationException("Foreground changed before pointer input");
  uint down=button=="left"?2u:8u,up=button=="left"?4u:16u;
  var events=new List<Input>{moves[0],Mouse(down,0,0)};
  for(int i=1;i<moves.Count;i++)events.Add(moves[i]);
  events.Add(Mouse(up,0,0));
  if(action=="double_click"){events.Add(Mouse(down,0,0));events.Add(Mouse(up,0,0));}
  var inputs=events.ToArray();
  ForgePointerGuard.Check();uint sent=SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(Input)));
  if(sent!=inputs.Length) {
   bool held=false;
   for(int i=0;i<sent;i++){if(inputs[i].data.mouse.flags==down)held=true;if(inputs[i].data.mouse.flags==up)held=false;}
   if(held)SendInput(1,new[]{Mouse(up,0,0)},Marshal.SizeOf(typeof(Input)));
   throw new InvalidOperationException("Screenshot pointer delivery incomplete; observe before proceeding");
  }
 }
}
`+inputGuardSource('ForgePointerGuard');
