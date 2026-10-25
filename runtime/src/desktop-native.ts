// Minimal Windows SDK UIAutomationClient.idl ABI declarations. Unused slots are
// placeholders and must never be called. No SDK, downloaded DLL or UIA proxy is
// required at runtime; Windows supplies CUIAutomation.
import {inputGuardSource} from './desktop-input-guard.js';
export const desktopNative = String.raw`
using System;
using System.Runtime.InteropServices;
namespace ForgeUIA {
 [ComImport, Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface Automation {
  void CompareElements(); void CompareRuntimeIds(); void GetRootElement();
  Element ElementFromHandle(IntPtr hwnd);
  void ElementFromPoint(); void GetFocusedElement(); void GetRootElementBuildCache();
  void ElementFromHandleBuildCache(); void ElementFromPointBuildCache(); void GetFocusedElementBuildCache();
  void CreateTreeWalker(); void ControlViewWalker(); void ContentViewWalker(); void RawViewWalker();
  void RawViewCondition(); void ControlViewCondition(); void ContentViewCondition(); void CreateCacheRequest();
  [return:MarshalAs(UnmanagedType.IUnknown)] object CreateTrueCondition();
 }
 [ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface Element {
  void SetFocus();
  [return:MarshalAs(UnmanagedType.SafeArray, SafeArraySubType=VarEnum.VT_I4)] int[] GetRuntimeId();
  void FindFirst();
  Elements FindAll(int scope, [MarshalAs(UnmanagedType.IUnknown)] object condition);
  void FindFirstBuildCache(); void FindAllBuildCache(); void BuildUpdatedCache();
  [return:MarshalAs(UnmanagedType.Struct)] object GetCurrentPropertyValue(int property);
  void GetCurrentPropertyValueEx(); void GetCachedPropertyValue(); void GetCachedPropertyValueEx();
  void GetCurrentPatternAs(); void GetCachedPatternAs();
  [return:MarshalAs(UnmanagedType.IUnknown)] object GetCurrentPattern(int pattern);
 }
 [ComImport, Guid("14314595-b4bc-4055-95f2-58f2e42c9855"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface Elements { int Length { get; } Element GetElement(int index); }
 [ComImport, Guid("fb377fbe-8ea6-46d5-9c73-6499642d3059"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface InvokePattern { void Invoke(); }
 [ComImport, Guid("94cf8058-9b8d-4ab9-8bfd-4cd0a33c8c70"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface TogglePattern {
  void Toggle();
  int CurrentToggleState {get;}
  int CachedToggleState {get;}
 }
 [ComImport, Guid("a94cd8b1-0844-4cd6-9d2d-640537ab39e9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface ValuePattern {
  void SetValue([MarshalAs(UnmanagedType.BStr)] string value);
  string CurrentValue { [return:MarshalAs(UnmanagedType.BStr)] get; }
  bool CurrentIsReadOnly { [return:MarshalAs(UnmanagedType.Bool)] get; }
 }
 [ComImport, Guid("a8efa66a-0fda-421a-9194-38021f3578ea"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface SelectionItemPattern {
  void Select(); void AddToSelection(); void RemoveFromSelection();
  bool CurrentIsSelected { [return:MarshalAs(UnmanagedType.Bool)] get; }
 }
 [ComImport, Guid("88f4d42a-e881-459d-a77c-73bbbb7e02dc"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface ScrollPattern {
  void Scroll(int horizontalAmount,int verticalAmount);
  void SetScrollPercent(double horizontalPercent,double verticalPercent);
  double CurrentHorizontalScrollPercent {get;}
  double CurrentVerticalScrollPercent {get;}
  double CurrentHorizontalViewSize {get;}
  double CurrentVerticalViewSize {get;}
  bool CurrentHorizontallyScrollable { [return:MarshalAs(UnmanagedType.Bool)] get; }
  bool CurrentVerticallyScrollable { [return:MarshalAs(UnmanagedType.Bool)] get; }
 }
 public sealed class ScrollState {
  public bool horizontal_scrollable,vertical_scrollable;
  public double horizontal_percent,vertical_percent;
 }
 public sealed class Node {
  readonly Element element;
  internal Node(Element value) { element=value; }
  public string Name {get{return (string)element.GetCurrentPropertyValue(30005);}}
  public string AutomationId {get{return (string)element.GetCurrentPropertyValue(30011);}}
  public int ControlType {get{return (int)element.GetCurrentPropertyValue(30003);}}
  public bool Enabled {get{return (bool)element.GetCurrentPropertyValue(30010);}}
  public bool Password {get{return (bool)element.GetCurrentPropertyValue(30019);}}
  public string RuntimeId {get{return string.Join(".",element.GetRuntimeId());}}
  public bool? Selected {
   get {
    try {
     var pattern=element.GetCurrentPattern(10010) as SelectionItemPattern;
     return pattern==null?(bool?)null:pattern.CurrentIsSelected;
    } catch(COMException) {return null;} catch(InvalidCastException) {return null;}
   }
  }
  public ScrollState ScrollPosition {
   get {
    try {
     var pattern=element.GetCurrentPattern(10004) as ScrollPattern;
     if(pattern==null)return null;
     return new ScrollState {
      horizontal_scrollable=pattern.CurrentHorizontallyScrollable,
      vertical_scrollable=pattern.CurrentVerticallyScrollable,
      horizontal_percent=pattern.CurrentHorizontalScrollPercent,
      vertical_percent=pattern.CurrentVerticalScrollPercent
     };
    } catch(COMException) {return null;} catch(InvalidCastException) {return null;}
   }
  }
  public void Select() {
   if(!Enabled||Password)throw new InvalidOperationException("Unsupported selection target");
   var pattern=(SelectionItemPattern)element.GetCurrentPattern(10010);
   ForgeUIAGuard.Check();
   if(!pattern.CurrentIsSelected)pattern.Select();
   if(!pattern.CurrentIsSelected)throw new InvalidOperationException("Selection did not reach requested item");
  }
  public void ScrollTo(double horizontal,double vertical) {
   if(!Enabled||Password)throw new InvalidOperationException("Unsupported scroll target");
   if((horizontal!=-1&&(double.IsNaN(horizontal)||double.IsInfinity(horizontal)||horizontal<0||horizontal>100))
     ||(vertical!=-1&&(double.IsNaN(vertical)||double.IsInfinity(vertical)||vertical<0||vertical>100))
     ||(horizontal==-1&&vertical==-1))throw new InvalidOperationException("Scroll percent must be within 0..100 for at least one axis");
   var pattern=(ScrollPattern)element.GetCurrentPattern(10004);
   if((horizontal!=-1&&!pattern.CurrentHorizontallyScrollable)||(vertical!=-1&&!pattern.CurrentVerticallyScrollable))
    throw new InvalidOperationException("Requested axis is not scrollable");
   ForgeUIAGuard.Check();pattern.SetScrollPercent(horizontal,vertical);
  }
  public void Invoke() {
   if(ControlType!=50000 || !Enabled || Password) throw new InvalidOperationException("Unsupported button");
   var pattern=(InvokePattern)element.GetCurrentPattern(10000);
   ForgeUIAGuard.Check();pattern.Invoke();
  }
  public bool? Checked {
   get {
    if(ControlType!=50002)return null;
    try {
     var obj=element.GetCurrentPattern(10015);
     if(obj==null)return null;
     var pattern=(TogglePattern)obj;
     int state=pattern.CurrentToggleState;
     return state==0?false:state==1?true:(bool?)null;
    } catch(COMException) {
     // Some UIA providers report CheckBox but do not implement TogglePattern.
     // A missing optional pattern must not make inspecting other controls fail.
     return null;
    } catch(InvalidCastException) {
     return null;
    }
   }
  }
  public void Check(bool desired) {
   if(ControlType!=50002||!Enabled||Password) throw new InvalidOperationException("Unsupported checkbox");
   var pattern=(TogglePattern)element.GetCurrentPattern(10015);
   int state=pattern.CurrentToggleState;
   if(state!=0&&state!=1) throw new InvalidOperationException("Indeterminate checkbox cannot be set safely");
   ForgeUIAGuard.Check();if((state==1)!=desired)pattern.Toggle();
   if(pattern.CurrentToggleState!=(desired?1:0))throw new InvalidOperationException("Checkbox state did not match desired value");
  }
  public long NativeHandle {get{var v=element.GetCurrentPropertyValue(30020);return v==null?0:Convert.ToInt64(v);}}
  [StructLayout(LayoutKind.Sequential)] struct ClientRect {public int Left,Top,Right,Bottom;}
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd,out ClientRect rect);
  public int[] PointerBounds {
   get {
    ClientRect rect;var target=new IntPtr(NativeHandle);
    if(target==IntPtr.Zero||!GetClientRect(target,out rect))return null;
    return new[]{rect.Right-rect.Left,rect.Bottom-rect.Top};
   }
  }
  // Client-relative messages stay on this captured control; no global cursor or
  // keyboard state is changed. Some applications require physical input instead.
  public void Pointer(string action,int x,int y,int endX,int endY,string button,IntPtr top,bool physical) {
   if(!Enabled||Password)throw new InvalidOperationException("Control is disabled or a password field");
   var target=new IntPtr(NativeHandle);
   if(target==IntPtr.Zero||(target!=top&&!IsChild(top,target)))throw new InvalidOperationException("Control window is outside the authorized window");
   var bounds=PointerBounds;
   if(bounds==null||x<0||y<0||endX<0||endY<0||x>=bounds[0]||endX>=bounds[0]||y>=bounds[1]||endY>=bounds[1]||Math.Max(x,endX)>32767||Math.Max(y,endY)>32767)
    throw new InvalidOperationException("Pointer coordinates outside control client bounds");
   if(action!="click"&&action!="double_click"&&action!="drag")throw new InvalidOperationException("Unsupported pointer action");
   if(button!="left"&&button!="right")throw new InvalidOperationException("Unsupported pointer button");
   if(physical){PhysicalPointer(action,x,y,endX,endY,button,target,top);return;}
   uint down=button=="left"?0x0201u:0x0204u,up=down+1,twice=down+2;
   int mask=button=="left"?1:2;
   PointerMessage(target,0x0200,0,x,y);
   PointerMessage(target,down,mask,x,y);
   try {
    if(action=="drag")for(int step=1;step<=12;step++)PointerMessage(target,0x0200,mask,x+(endX-x)*step/12,y+(endY-y)*step/12);
   } finally {
    // A release is cleanup, not new authority to continue after interruption.
    PostMessage(target,up,IntPtr.Zero,new IntPtr((endY<<16)|(endX&0xffff)));
   }
   if(action=="double_click") {PointerMessage(target,twice,mask,x,y);PointerMessage(target,up,0,x,y);}
  }
  static void PointerMessage(IntPtr target,uint message,int buttons,int x,int y) {
   ForgeUIAGuard.Check();
   if(!PostMessage(target,message,new IntPtr(buttons),new IntPtr((y<<16)|(x&0xffff))))throw new InvalidOperationException("Pointer delivery unknown; inspect before proceeding");
  }
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd,uint msg,IntPtr w,IntPtr l);
  [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent,IntPtr child);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code,uint type);
  // Keys travel as window messages to the control's own native window, never as
  // global SendInput, so they cannot reach whichever window happens to be in front.
  public void Key(int vk,IntPtr top) {
   ForgeUIAGuard.Check();
   if(!Enabled||Password) throw new InvalidOperationException("Control is disabled or a password field");
   var target=new IntPtr(NativeHandle);
   if(target==IntPtr.Zero) throw new InvalidOperationException("Control has no native window; keys cannot be delivered safely");
   if(target!=top&&!IsChild(top,target)) throw new InvalidOperationException("Control window is outside the authorized window");
   long scan=MapVirtualKey((uint)vk,0)&0xFF;
   var extended=(vk>=0x21&&vk<=0x28)||vk==0x2E?1L<<24:0;
   if(!PostMessage(target,0x0100,new IntPtr(vk),new IntPtr(1|(scan<<16)|extended))) throw new InvalidOperationException("Key down was not delivered");
   if(!PostMessage(target,0x0101,new IntPtr(vk),new IntPtr(1|(scan<<16)|extended|(1L<<30)|(1L<<31)))) throw new InvalidOperationException("Key up delivery is unknown");
  }
  public void Fill(string value) {
   if(ControlType!=50004 || !Enabled || Password) throw new InvalidOperationException("Unsupported text field");
   var pattern=(ValuePattern)element.GetCurrentPattern(10002);
   if(pattern.CurrentIsReadOnly) throw new InvalidOperationException("Read-only field");
   ForgeUIAGuard.Check();pattern.SetValue(value);
   if(pattern.CurrentValue!=value)throw new InvalidOperationException("Text field did not retain requested value; inspect before proceeding");
  }
  [StructLayout(LayoutKind.Sequential)] struct KeyboardInput {public ushort key,scan;public uint flags,time;public UIntPtr extra;}
  [StructLayout(LayoutKind.Sequential)] struct MouseInput {public int x,y;public uint data,flags,time;public UIntPtr extra;}
  [StructLayout(LayoutKind.Explicit)] struct InputData {[FieldOffset(0)] public KeyboardInput keyboard;[FieldOffset(0)] public MouseInput mouse;}
  [StructLayout(LayoutKind.Sequential)] struct Input {public uint type;public InputData data;}
  [DllImport("user32.dll")] static extern uint SendInput(uint count,Input[] inputs,int size);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  static Input KeyInput(int key,bool up) {return new Input {type=1,data=new InputData {keyboard=new KeyboardInput {key=(ushort)key,flags=(up?2u:0u)|((key>=0x21&&key<=0x28)||key==0x2d||key==0x2e||key==0x5b?1u:0u)}}};}
  [StructLayout(LayoutKind.Sequential)] struct Point {public int x,y;}
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window,ref Point point);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  static Input MouseEvent(uint flags,int x,int y){return new Input {type=0,data=new InputData {mouse=new MouseInput {flags=flags,x=x,y=y}}};}
  void PhysicalPointer(string action,int x,int y,int endX,int endY,string button,IntPtr target,IntPtr top) {
   foreach(int key in new[]{1,2,4,5,6,0x10,0x11,0x12,0x5b,0x5c})if((GetAsyncKeyState(key)&0x8000)!=0)throw new InvalidOperationException("Release held mouse buttons and modifiers before physical pointer input");
   ForgeUIAGuard.Check();SetForegroundWindow(top);
   if(GetForegroundWindow()!=top)throw new InvalidOperationException("Authorized window could not become foreground");
   int left=GetSystemMetrics(76),upper=GetSystemMetrics(77),width=GetSystemMetrics(78),height=GetSystemMetrics(79);
   if(width<2||height<2)throw new InvalidOperationException("Desktop bounds unavailable");
   var moves=new System.Collections.Generic.List<Input>();
   int steps=action=="drag"?12:0;
   for(int step=0;step<=steps;step++) {
    var point=new Point {x=steps==0?x:x+(endX-x)*step/steps,y=steps==0?y:y+(endY-y)*step/steps};
    if(!ClientToScreen(target,ref point))throw new InvalidOperationException("Control screen coordinates unavailable");
    var hit=WindowFromPoint(point);
    if(hit!=target&&!IsChild(target,hit))throw new InvalidOperationException("Pointer path is covered or outside captured control");
    if(point.x<left||point.y<upper||point.x>=left+width||point.y>=upper+height)throw new InvalidOperationException("Pointer path outside desktop bounds");
    moves.Add(MouseEvent(0x8000u|0x4000u|0x2000u|1u,(int)Math.Round((point.x-left)*65535.0/(width-1)),(int)Math.Round((point.y-upper)*65535.0/(height-1))));
   }
   if(GetForegroundWindow()!=top)throw new InvalidOperationException("Foreground changed before pointer input");
   uint down=button=="left"?2u:8u,up=button=="left"?4u:16u;
   var events=new System.Collections.Generic.List<Input>();
   events.Add(moves[0]);events.Add(MouseEvent(down,0,0));
   for(int i=1;i<moves.Count;i++)events.Add(moves[i]);
   events.Add(MouseEvent(up,0,0));
   if(action=="double_click"){events.Add(MouseEvent(down,0,0));events.Add(MouseEvent(up,0,0));}
   ForgeUIAGuard.Check();
   var inputs=events.ToArray();uint sent=SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(Input)));
   if(sent!=inputs.Length){
    bool held=false;for(int i=0;i<sent;i++){if(inputs[i].data.mouse.flags==down)held=true;if(inputs[i].data.mouse.flags==up)held=false;}
    if(held)SendInput(1,new[]{MouseEvent(up,0,0)},Marshal.SizeOf(typeof(Input)));
    throw new InvalidOperationException("Physical pointer delivery incomplete or blocked; inspect before proceeding");
   }
  }
  void FocusForKeyboard(IntPtr top) {
   if(!Enabled||Password)throw new InvalidOperationException("Control is disabled or a password field");
   // Never release a modifier that the user was already holding.
   foreach(int key in new[]{0x10,0x11,0x12,0x5b,0x5c})if((GetAsyncKeyState(key)&0x8000)!=0)throw new InvalidOperationException("Release held modifier keys before keyboard input");
   ForgeUIAGuard.Check();SetForegroundWindow(top);
   if(GetForegroundWindow()!=top)throw new InvalidOperationException("Authorized window could not become foreground");
   ForgeUIAGuard.Check();element.SetFocus();
   if(!(bool)element.GetCurrentPropertyValue(30008))throw new InvalidOperationException("Captured control did not receive keyboard focus");
   if(GetForegroundWindow()!=top)throw new InvalidOperationException("Foreground changed before keyboard input");
  }
  static Input UnicodeInput(char unit,bool up) {return new Input {type=1,data=new InputData {keyboard=new KeyboardInput {scan=unit,flags=4u|(up?2u:0u)}}};}
  public void TypeText(string text,IntPtr top) {
   if(String.IsNullOrEmpty(text)||text.Length>10000)throw new InvalidOperationException("Text must contain 1..10000 UTF-16 units");
   FocusForKeyboard(top);
   // Bound queued Unicode events; Escape can stop subsequent chunks. Never
   // split a surrogate pair, and never repeat text already accepted by Windows.
   for(int start=0;start<text.Length;) {
    int count=Math.Min(32,text.Length-start);
    if(start+count<text.Length&&char.IsHighSurrogate(text[start+count-1]))count--;
    var inputs=new Input[count*2];
    for(int i=0;i<count;i++){inputs[i*2]=UnicodeInput(text[start+i],false);inputs[i*2+1]=UnicodeInput(text[start+i],true);}
    ForgeUIAGuard.Check();
    if(GetForegroundWindow()!=top)throw new InvalidOperationException("Foreground changed during text input");
    uint sent=SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(Input)));
    if(sent!=inputs.Length){
     if(sent%2==1){var release=new[]{UnicodeInput(text[start+(int)sent/2],true)};SendInput(1,release,Marshal.SizeOf(typeof(Input)));}
     throw new InvalidOperationException("Text delivery incomplete or blocked; inspect before proceeding");
    }
    start+=count;System.Threading.Thread.Sleep(5);
   }
  }
  public void Hotkey(int[] keys,IntPtr top) {
   if(keys==null||keys.Length<1||keys.Length>5)throw new InvalidOperationException("Invalid hotkey sequence");
   foreach(int key in keys)if(key<1||key>255)throw new InvalidOperationException("Invalid virtual key");
   foreach(int key in keys)if((GetAsyncKeyState(key)&0x8000)!=0)throw new InvalidOperationException("Requested key is already held");
   FocusForKeyboard(top);
   var inputs=new Input[keys.Length*2];
   for(int i=0;i<keys.Length;i++){inputs[i]=KeyInput(keys[i],false);inputs[keys.Length+i]=KeyInput(keys[keys.Length-1-i],true);}
   ForgeUIAGuard.Check();uint sent=SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(Input)));
   if(sent!=inputs.Length){
    // Release only keys whose down event was accepted, then retain uncertainty.
    int downs=Math.Min((int)sent,keys.Length);
    if(downs>0){var releases=new Input[downs];for(int i=0;i<downs;i++)releases[i]=KeyInput(keys[downs-1-i],true);SendInput((uint)downs,releases,Marshal.SizeOf(typeof(Input)));}
    throw new InvalidOperationException("Hotkey delivery incomplete or blocked; inspect before proceeding");
   }
  }
 }
 public sealed class Window {
  readonly Automation automation;
  readonly Element root;
  readonly Elements elements;
  public Window(IntPtr hwnd) {
   automation=(Automation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("ff48dba4-60ef-4201-aa87-54103eef594e")));
   root=automation.ElementFromHandle(hwnd);
   elements=root.FindAll(4,automation.CreateTrueCondition());
  }
  public Node Root {get{return new Node(root);}}
  public int Count {get{return elements.Length;}}
  public Node Get(int index) {return new Node(elements.GetElement(index));}
 }
}
`+inputGuardSource('ForgeUIAGuard');

// MainWindowHandle can become zero when an authorized window is hidden. Validate
// the exact granted HWND and its process owner instead of selecting a new window.
export const desktopIdentityNative = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;
public sealed class ForgeWindowInfo {public int pid;public string hwnd,title;}
public static class ForgeWindowIdentity {
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
 [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr hwnd,uint message,UIntPtr w,IntPtr l,uint flags,uint timeout,out UIntPtr result);
 [StructLayout(LayoutKind.Sequential)] struct FocusPoint {public int x,y;}
 [StructLayout(LayoutKind.Sequential)] struct FocusMouse {public int x,y;public uint data,flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Explicit)] struct FocusData {[FieldOffset(0)] public FocusMouse mouse;}
 [StructLayout(LayoutKind.Sequential)] struct FocusInput {public uint type;public FocusData data;}
 [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(FocusPoint point);
 [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
 [DllImport("user32.dll")] static extern uint SendInput(uint count,FocusInput[] input,int size);
 static FocusInput Mouse(uint flags,int x,int y){return new FocusInput {data=new FocusData {mouse=new FocusMouse {flags=flags,x=x,y=y}}};}
 static void ActivateCaption(IntPtr hwnd) {
  // Foreground lock may reject a background helper. Click only a native caption
  // belonging to the authorized HWND, never client content or another app.
  ForgeIdentityGuard.Check();SetWindowPos(hwnd,IntPtr.Zero,0,0,0,0,0x13);
  Rect r;if(!GetWindowRect(hwnd,out r))throw new InvalidOperationException("Target bounds unavailable");
  int left=GetSystemMetrics(76),top=GetSystemMetrics(77),w=GetSystemMetrics(78),h=GetSystemMetrics(79);
  if(w<2||h<2)throw new InvalidOperationException("Desktop bounds unavailable");
  for(int offset=8;offset<=48;offset+=4){
   int x=r.Left+(r.Right-r.Left)/2,y=r.Top+offset;
   if(x<left||x>=left+w||y<top||y>=top+h)continue;
   var point=new FocusPoint{x=x,y=y};UIntPtr hit;
   if(WindowFromPoint(point)!=hwnd)continue;
   if(SendMessageTimeout(hwnd,0x84,UIntPtr.Zero,new IntPtr((y<<16)|(x&0xffff)),2,300,out hit)==IntPtr.Zero||hit.ToUInt64()!=2)continue;
   foreach(int key in new[]{1,2,4,5,6,0x10,0x11,0x12,0x5b,0x5c})
    if((GetAsyncKeyState(key)&0x8000)!=0)throw new InvalidOperationException("Release held keys before activation");
   ForgeIdentityGuard.Check();
   if(WindowFromPoint(point)!=hwnd)throw new InvalidOperationException("Target caption became covered");
   var input=new[]{Mouse(0xe001u,(int)Math.Round((x-left)*65535.0/(w-1)),(int)Math.Round((y-top)*65535.0/(h-1))),Mouse(2,0,0),Mouse(4,0,0)};
   uint sent=SendInput(3,input,Marshal.SizeOf(typeof(FocusInput)));
   if(sent!=3){if(sent==2)SendInput(1,new[]{Mouse(4,0,0)},Marshal.SizeOf(typeof(FocusInput)));throw new InvalidOperationException("Activation input incomplete; observe before retrying");}
   return;
  }
  throw new InvalidOperationException("No visible native caption available for activation");
 }
 public static void Focus(IntPtr hwnd) {
  foreach(int key in new[]{1,2,4,5,6,0x10,0x11,0x12,0x5b,0x5c})
   if((GetAsyncKeyState(key)&0x8000)!=0)throw new InvalidOperationException("Release held buttons and modifiers before switching apps");
  ForgeIdentityGuard.Check();
  if(IsIconic(hwnd))ShowWindow(hwnd,9);
  ForgeIdentityGuard.Check();SetForegroundWindow(hwnd);
  // Cross-thread activation is asynchronous. Drain the activation notification
  // with a bounded WM_NULL, without attaching our input queue to the target.
  UIntPtr result;
  if(SendMessageTimeout(hwnd,0,UIntPtr.Zero,IntPtr.Zero,2,1500,out result)==IntPtr.Zero)
   throw new InvalidOperationException("Target did not respond to activation; observe before retrying");
  ForgeIdentityGuard.Check();
  if(GetForegroundWindow()!=hwnd){
   ActivateCaption(hwnd);
   for(int i=0;i<20&&GetForegroundWindow()!=hwnd;i++){System.Threading.Thread.Sleep(25);ForgeIdentityGuard.Check();}
  }
  if(GetForegroundWindow()!=hwnd)throw new InvalidOperationException("Target could not become foreground; observe before retrying");
 }

 [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 public static void ConfigureDpi(){if(SetThreadDpiAwarenessContext(new IntPtr(-4))==IntPtr.Zero)throw new InvalidOperationException("Per-monitor DPI context unavailable");}
 delegate bool WindowCallback(IntPtr hwnd,IntPtr data);
 [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback,IntPtr data);
 [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder title,int count);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd,int show);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
 [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
 [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd,IntPtr after,int x,int y,int w,int h,uint flags);
 [StructLayout(LayoutKind.Sequential)] struct Rect {public int Left,Top,Right,Bottom;}
 // Move and minimize do not activate. Maximize/restore from maximized can activate.
 public static object State(IntPtr hwnd) {
  Rect r;if(!GetWindowRect(hwnd,out r))throw new InvalidOperationException("Window bounds unavailable");
  return new System.Collections.Generic.Dictionary<string,object>{{"foreground",GetForegroundWindow()==hwnd},{"minimized",IsIconic(hwnd)},{"maximized",IsZoomed(hwnd)},{"x",r.Left},{"y",r.Top},{"width",r.Right-r.Left},{"height",r.Bottom-r.Top}};
 }
 public static void Show(IntPtr hwnd,string state) {
  ForgeIdentityGuard.Check();
  if(state=="minimize")ShowWindow(hwnd,7);        // SW_SHOWMINNOACTIVE
  else if(state=="maximize")ShowWindow(hwnd,3);  // SW_SHOWMAXIMIZED
  else if(state=="restore") {
   // A minimized window can remember maximized placement. Show without activation
   // first, then normalize that remembered placement if necessary.
   ShowWindow(hwnd,4);
   if(IsZoomed(hwnd)){ForgeIdentityGuard.Check();ShowWindow(hwnd,9);}
  }
  else throw new InvalidOperationException("Unsupported window state");
 }
 public static void Move(IntPtr hwnd,int x,int y,int w,int h) {
  ForgeIdentityGuard.Check();
  if(IsIconic(hwnd)||IsZoomed(hwnd))throw new InvalidOperationException("Restore the window before moving it");
  if(!SetWindowPos(hwnd,IntPtr.Zero,x,y,w,h,0x0004|0x0010))throw new InvalidOperationException("Window move failed"); // NOZORDER|NOACTIVATE
 }
 public static bool OwnedTopLevel(IntPtr hwnd,int expectedPid) {
  uint actual;
  return hwnd!=IntPtr.Zero&&IsWindow(hwnd)&&GetAncestor(hwnd,2)==hwnd
   &&GetWindowThreadProcessId(hwnd,out actual)!=0&&actual==(uint)expectedPid;
 }
 public static ForgeWindowInfo[] VisibleWindows() {
  var windows=new List<ForgeWindowInfo>();
  EnumWindows((hwnd,data)=>{
   if(!IsWindowVisible(hwnd)||windows.Count>=200)return true;
   uint pid;GetWindowThreadProcessId(hwnd,out pid);
   var title=new StringBuilder(512);GetWindowText(hwnd,title,title.Capacity);
   if(pid!=0&&title.Length!=0)windows.Add(new ForgeWindowInfo {pid=(int)pid,hwnd=hwnd.ToInt64().ToString(),title=title.ToString()});
   return true;
  },IntPtr.Zero);
  return windows.ToArray();
 }
}
`+inputGuardSource('ForgeIdentityGuard');
