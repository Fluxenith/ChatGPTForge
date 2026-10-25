import {inputGuardSource} from './desktop-input-guard.js';
export const desktopSurfaceNative=String.raw`
using System;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class ForgeSurface {
 [StructLayout(LayoutKind.Sequential)] public struct Rect {public int Left,Top,Right,Bottom;}
 [StructLayout(LayoutKind.Sequential)] struct Point {public int x,y;}
 [StructLayout(LayoutKind.Sequential)] struct Mouse {public int x,y;public uint data,flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Explicit)] struct Data {[FieldOffset(0)] public Mouse mouse;}
 [StructLayout(LayoutKind.Sequential)] struct Input {public uint type;public Data data;}
 public class Target {public string hwnd,creation,kind;public int pid,x,y,width,height;}
 delegate bool EnumProc(IntPtr hwnd,IntPtr data);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb,IntPtr data);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd,StringBuilder text,int count);
 [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
 [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
 [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point p);
 [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
 [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
 [DllImport("user32.dll")] static extern uint SendInput(uint count,Input[] input,int size);
 static string Class(IntPtr h){var b=new StringBuilder(256);GetClassName(h,b,256);return b.ToString();}
 static bool Shell(IntPtr h){uint owner,pid;GetWindowThreadProcessId(GetShellWindow(),out owner);GetWindowThreadProcessId(h,out pid);return owner!=0&&pid==owner&&Array.IndexOf(new[]{"Progman","WorkerW","Shell_TrayWnd","Shell_SecondaryTrayWnd"},Class(h))>=0;}
 public static Target[] Surfaces(){var list=new List<Target>();EnumWindows((h,d)=>{try{if(IsWindowVisible(h)&&Shell(h)){uint pid;Rect r;GetWindowThreadProcessId(h,out pid);if(GetWindowRect(h,out r)&&r.Right>r.Left&&r.Bottom>r.Top)list.Add(new Target{hwnd=h.ToInt64().ToString(),pid=(int)pid,creation=Process.GetProcessById((int)pid).StartTime.ToFileTimeUtc().ToString(),kind=Class(h).Contains("TrayWnd")?"taskbar":"desktop",x=r.Left,y=r.Top,width=r.Right-r.Left,height=r.Bottom-r.Top});}}catch{}return true;},IntPtr.Zero);return list.ToArray();}
 static void Validate(Target t){var h=new IntPtr(long.Parse(t.hwnd));uint pid;Rect r;GetWindowThreadProcessId(h,out pid);if(pid!=t.pid||!IsWindowVisible(h)||IsIconic(h)||Process.GetProcessById(t.pid).StartTime.ToFileTimeUtc().ToString()!=t.creation||!GetWindowRect(h,out r)||r.Left!=t.x||r.Top!=t.y||r.Right-r.Left!=t.width||r.Bottom-r.Top!=t.height)throw new InvalidOperationException("Desktop target changed; observe again");if(t.kind!="window"&&!Shell(h))throw new InvalidOperationException("Shell target changed");}
 static void Hit(Target t,Point p){var h=GetAncestor(WindowFromPoint(p),2);if(h.ToInt64().ToString()!=t.hwnd)throw new InvalidOperationException("Desktop target is covered or pointer left selected window");}
 static Input Event(uint flags,int x,int y){return new Input{type=0,data=new Data{mouse=new Mouse{flags=flags,x=x,y=y}}};}
 static void Send(Input i){if(SendInput(1,new[]{i},Marshal.SizeOf(typeof(Input)))!=1)throw new InvalidOperationException("Desktop input delivery incomplete");}
 static Point Pixel(int x,int y,int left,int top,int width,int height,int iw,int ih){if(x<0||y<0||x>=iw||y>=ih)throw new InvalidOperationException("Pixel outside observation");return new Point{x=left+(int)Math.Floor((x+0.5)*width/iw),y=top+(int)Math.Floor((y+0.5)*height/ih)};}
 static Input Move(Point p,int left,int top,int width,int height){return Event(0x8000u|0x4000u|0x2000u|1u,(int)Math.Round((p.x-left)*65535.0/(width-1)),(int)Math.Round((p.y-top)*65535.0/(height-1)));}
 public static void Perform(Target source,Target destination,string action,int x,int y,int ex,int ey,int left,int top,int width,int height,int iw,int ih){
  if(action!="click"&&action!="drag")throw new InvalidOperationException("Unsupported surface action");
  if(width<2||height<2||iw<1||ih<1||GetSystemMetrics(76)!=left||GetSystemMetrics(77)!=top||GetSystemMetrics(78)!=width||GetSystemMetrics(79)!=height)throw new InvalidOperationException("Monitor layout changed");
  foreach(int key in new[]{1,2,4,5,6,0x10,0x11,0x12,0x5b,0x5c})if((GetAsyncKeyState(key)&0x8000)!=0)throw new InvalidOperationException("Release held buttons and modifiers");
  Validate(source);Validate(destination);var a=Pixel(x,y,left,top,width,height,iw,ih);var b=Pixel(ex,ey,left,top,width,height,iw,ih);Hit(source,a);Hit(destination,b);
  // Reject routes through a third application before pressing the mouse.
  for(int i=0;i<=24;i++){var p=new Point{x=a.x+(b.x-a.x)*i/24,y=a.y+(b.y-a.y)*i/24};var h=GetAncestor(WindowFromPoint(p),2);if(h.ToInt64().ToString()!=source.hwnd&&h.ToInt64().ToString()!=destination.hwnd&&!Shell(h))throw new InvalidOperationException("Drag path crosses an unselected application");}
  bool held=false;
  try {
   ForgeSurfaceGuard.Check();Send(Move(a,left,top,width,height));Thread.Sleep(50);ForgeSurfaceGuard.Check();Hit(source,a);Validate(source);Validate(destination);
   held=true;Send(Event(2,0,0));Thread.Sleep(80);
   if(action=="drag")for(int i=1;i<=24;i++){ForgeSurfaceGuard.Check();Validate(source);Validate(destination);var p=new Point{x=a.x+(b.x-a.x)*i/24,y=a.y+(b.y-a.y)*i/24};var h=GetAncestor(WindowFromPoint(p),2);if(h.ToInt64().ToString()!=source.hwnd&&h.ToInt64().ToString()!=destination.hwnd&&!Shell(h))throw new InvalidOperationException("Drag path changed");Send(Move(p,left,top,width,height));Thread.Sleep(20);}
   ForgeSurfaceGuard.Check();Validate(destination);Hit(destination,b);Send(Event(4,0,0));held=false;
  } finally {if(held)SendInput(1,new[]{Event(4,0,0)},Marshal.SizeOf(typeof(Input)));}
 }
}
`+inputGuardSource('ForgeSurfaceGuard');
