// Compiled into each native input assembly; the monitor is the only writer.
// No key codes, text, cursor coordinates or application contents are persisted.
export function inputGuardSource(className:string):string {return String.raw`
public static class ${className} {
 public static void Check() {
  string name=System.Environment.GetEnvironmentVariable("FORGE_INPUT_GUARD");
  if(string.IsNullOrEmpty(name))return; // direct local helper clients only
  int expected=int.Parse(System.Environment.GetEnvironmentVariable("FORGE_INPUT_EPOCH"));
  using(var mutex=System.Threading.Mutex.OpenExisting(name+".lock")) {
   if(!mutex.WaitOne(250))throw new System.InvalidOperationException("Input monitor unavailable; reauthorize locally");
   try {
    using(var map=System.IO.MemoryMappedFiles.MemoryMappedFile.OpenExisting(name))
    using(var view=map.CreateViewAccessor()) {
     if(view.ReadInt32(4)!=0)throw new System.InvalidOperationException("Desktop stopped by physical Escape; reauthorize locally");
     long age=System.DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()-view.ReadInt64(8);
     if(age<0||age>2000)throw new System.InvalidOperationException("Input monitor heartbeat lost; reauthorize locally");
     if(view.ReadInt32(0)!=expected)throw new System.InvalidOperationException("User input detected; observe again before input");
    }
   } finally {mutex.ReleaseMutex();}
  }
 }
}
`;}

export const inputMonitorSource=String.raw`
using System;
using System.Diagnostics;
using System.IO.MemoryMappedFiles;
using System.Runtime.InteropServices;
using System.Threading;
using System.Collections.Generic;
public static class ForgeInputMonitor {
 delegate IntPtr Hook(int code,IntPtr message,IntPtr data);
 delegate void Tick(IntPtr window,uint message,UIntPtr id,uint time);
 [StructLayout(LayoutKind.Sequential)] struct Point {public int x,y;}
 [StructLayout(LayoutKind.Sequential)] struct Message {public IntPtr hwnd;public uint message;public UIntPtr w;public IntPtr l;public uint time;public Point pt;public uint privateValue;}
 [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SetWindowsHookEx(int id,Hook callback,IntPtr module,uint thread);
 [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
 [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook,int code,IntPtr message,IntPtr data);
 [DllImport("user32.dll")] static extern int GetMessage(out Message message,IntPtr window,uint min,uint max);
 [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Message message);
 [DllImport("user32.dll")] static extern UIntPtr SetTimer(IntPtr window,UIntPtr id,uint interval,Tick callback);
 [DllImport("user32.dll")] static extern bool KillTimer(IntPtr window,UIntPtr id);
 [DllImport("user32.dll")] static extern void PostQuitMessage(int code);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
 [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flags);
 static MemoryMappedViewAccessor view;static Mutex mutex;
 static HashSet<long> targets;
 static int generation,stopped;static Process parent;
 static Hook keyboard=Keyboard,mouse=Mouse;static Tick timer=Pulse;
 static void Changed(bool escape) {
  if(!mutex.WaitOne(100)){PostQuitMessage(1);return;}
  try {generation++;if(escape)stopped=1;view.Write(0,generation);view.Write(4,stopped);}
  finally {mutex.ReleaseMutex();}
 }
 static IntPtr Keyboard(int code,IntPtr message,IntPtr data) {
  if(code>=0 && (Marshal.ReadInt32(data,8)&0x10)==0) {
   int msg=message.ToInt32();
   bool escape=(msg==0x100||msg==0x104)&&Marshal.ReadInt32(data)==27;
   if(escape||targets.Contains(0)||targets.Contains(GetAncestor(GetForegroundWindow(),2).ToInt64()))Changed(escape);
  }
  return CallNextHookEx(IntPtr.Zero,code,message,data);
 }
 static IntPtr Mouse(int code,IntPtr message,IntPtr data) {
  if(code>=0 && (Marshal.ReadInt32(data,12)&1)==0) {
   var point=new Point {x=Marshal.ReadInt32(data),y=Marshal.ReadInt32(data,4)};
   if(targets.Contains(0)||targets.Contains(GetAncestor(WindowFromPoint(point),2).ToInt64()))Changed(false);
  }
  return CallNextHookEx(IntPtr.Zero,code,message,data);
 }
 static void Publish() {
  Console.WriteLine("{\"epoch\":"+generation+",\"stopped\":"+(stopped!=0?"true":"false")+"}");
  Console.Out.Flush();
 }
 static void Pulse(IntPtr window,uint message,UIntPtr id,uint time) {
  try {
   if(parent.HasExited){PostQuitMessage(0);return;}
   if(!mutex.WaitOne(100)){PostQuitMessage(1);return;}
   try {view.Write(8,DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());}finally{mutex.ReleaseMutex();}
   // Heartbeats also let the parent fail closed if this message loop stalls.
   Publish();
  } catch {PostQuitMessage(1);}
 }
 public static void Run(string name,int parentId,string[] windows) {
  parent=Process.GetProcessById(parentId);
  targets=new HashSet<long>();foreach(string window in windows)targets.Add(long.Parse(window));
  using(mutex=new Mutex(false,name+".lock"))
  using(var map=MemoryMappedFile.CreateNew(name,32))
  using(view=map.CreateViewAccessor()) {
   view.Write(8,DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
   IntPtr k=SetWindowsHookEx(13,keyboard,GetModuleHandle(null),0);
   IntPtr m=SetWindowsHookEx(14,mouse,GetModuleHandle(null),0);
   UIntPtr t=UIntPtr.Zero;
   try {
    if(k==IntPtr.Zero||m==IntPtr.Zero)throw new InvalidOperationException("Could not install physical input hooks");
    t=SetTimer(IntPtr.Zero,UIntPtr.Zero,100,timer);
    if(t==UIntPtr.Zero)throw new InvalidOperationException("Could not start monitor heartbeat");
    Publish();Message msg;int status;
    while((status=GetMessage(out msg,IntPtr.Zero,0,0))>0)DispatchMessage(ref msg);
    if(status<0)throw new InvalidOperationException("Input monitor message loop failed");
   } finally {
    // Any surviving input worker must stop, even during normal shutdown.
    if(mutex.WaitOne(250)){try{view.Write(4,1);}finally{mutex.ReleaseMutex();}}
    if(t!=UIntPtr.Zero)KillTimer(IntPtr.Zero,t);
    if(k!=IntPtr.Zero)UnhookWindowsHookEx(k);if(m!=IntPtr.Zero)UnhookWindowsHookEx(m);
   }
  }
 }
}
`;
