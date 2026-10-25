export const desktopCaptureNative = String.raw`
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
// Capture only the authorized window. Never fall back to whole-screen capture.
public static class ForgeWindowCapture {
 [StructLayout(LayoutKind.Sequential)]
 struct Rect {public int Left; public int Top; public int Right; public int Bottom;}
 [DllImport("user32.dll", SetLastError=true)]
 static extern bool GetWindowRect(IntPtr handle, out Rect rect);
 [DllImport("user32.dll", SetLastError=true)]
 static extern bool PrintWindow(IntPtr handle, IntPtr dc, uint flags);
 [DllImport("dwmapi.dll")]
 static extern int DwmGetWindowAttribute(IntPtr handle,int attribute,out Rect rect,int size);
 [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
 [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
 public static object CaptureDesktop() {
  SetProcessDPIAware();
  int x=GetSystemMetrics(76),y=GetSystemMetrics(77),width=GetSystemMetrics(78),height=GetSystemMetrics(79);
  if(width<1||height<1||width>32768||height>32768||(long)width*height>64000000)
   throw new InvalidOperationException("Desktop screenshot exceeds size limits");
  using(var bitmap=new Bitmap(width,height,PixelFormat.Format24bppRgb)) {
   using(var graphics=Graphics.FromImage(bitmap))graphics.CopyFromScreen(x,y,0,0,new Size(width,height),CopyPixelOperation.SourceCopy);
   double ratio=Math.Min(1,Math.Min(1920.0/width,1080.0/height));
   int w=Math.Max(1,(int)Math.Round(width*ratio)),h=Math.Max(1,(int)Math.Round(height*ratio));
   using(var scaled=new Bitmap(w,h,PixelFormat.Format24bppRgb)) {
    using(var graphics=Graphics.FromImage(scaled)) {
     graphics.InterpolationMode=InterpolationMode.HighQualityBicubic;
     graphics.DrawImage(bitmap,0,0,w,h);
    }
    using(var stream=new MemoryStream()) {
     scaled.Save(stream,ImageFormat.Png);
     if(stream.Length>3*1024*1024)throw new InvalidOperationException("Desktop PNG exceeds output limit");
     return new {image=Convert.ToBase64String(stream.ToArray()),x,y,width,height,image_width=w,image_height=h};
    }
   }
  }
 }
 // PrintWindow can report success without painting. Retry its default mode
 // before treating an empty window capture as a valid observation.
 static bool DrawWindow(IntPtr handle, Bitmap bitmap, uint flags, Color untouched) {
  using(var graphics=Graphics.FromImage(bitmap)) {
   graphics.Clear(untouched);
   var dc=graphics.GetHdc();
   try {if(!PrintWindow(handle,dc,flags))return false;}
   finally {graphics.ReleaseHdc(dc);}
  }
  int untouchedSamples=0;
  for(int row=0;row<5;row++)for(int col=0;col<5;col++) {
   var color=bitmap.GetPixel((bitmap.Width-1)*col/4,(bitmap.Height-1)*row/4);
   if(color.ToArgb()==untouched.ToArgb())untouchedSamples++;
  }
  return untouchedSamples<25;
 }
 // Windows.Graphics.Capture returns the DWM visible frame, which can be
 // smaller than GetWindowRect (invisible resize borders). Preserve that exact
 // coordinate origin so screenshot-relative clicks hit the captured pixels.
 public static int[] VisibleBounds(IntPtr handle) {
  Rect rect;
  if(DwmGetWindowAttribute(handle,9,out rect,Marshal.SizeOf(typeof(Rect)))!=0)
   throw new InvalidOperationException("Windows capture visible frame bounds unavailable");
  return new[]{rect.Left,rect.Top,rect.Right,rect.Bottom};
 }
 public static object FromWindowsCapture(IntPtr handle,byte[] png,int[] expected) {
  if(png==null||png.Length<8||png.Length>3*1024*1024)
   throw new InvalidOperationException("Windows capture PNG size is invalid");
  Rect rect;
  if(DwmGetWindowAttribute(handle,9,out rect,Marshal.SizeOf(typeof(Rect)))!=0)
   throw new InvalidOperationException("Windows capture visible frame bounds unavailable");
  if(expected==null||expected.Length!=4||rect.Left!=expected[0]||rect.Top!=expected[1]||rect.Right!=expected[2]||rect.Bottom!=expected[3])
   throw new InvalidOperationException("Window moved or resized during Windows capture");
  int width=rect.Right-rect.Left,height=rect.Bottom-rect.Top;
  if(width<1||height<1||width>4096||height>2400||((long)width*height)>9000000)
   throw new InvalidOperationException("Windows capture visible frame exceeds limits");
  double ratio=Math.Min(1,Math.Min(1440.0/width,1080.0/height));
  int expectedWidth=Math.Max(1,(int)Math.Floor(width*ratio+0.5));
  int expectedHeight=Math.Max(1,(int)Math.Floor(height*ratio+0.5));
  using(var stream=new MemoryStream(png))using(var image=Image.FromStream(stream)) {
   if(image.Width!=expectedWidth||image.Height!=expectedHeight)
    throw new InvalidOperationException("Windows capture image does not match DWM frame bounds");
  }
  return new {image=Convert.ToBase64String(png),window_x=rect.Left,window_y=rect.Top,width,height,image_width=expectedWidth,image_height=expectedHeight,capture_method="windows_graphics_capture"};
 }
 public static object Capture(IntPtr handle) {
  Rect rect;
  if(!GetWindowRect(handle,out rect)) throw new InvalidOperationException("Window bounds unavailable");
  int width=rect.Right-rect.Left,height=rect.Bottom-rect.Top;
  if(width<1||height<1||width>4096||height>2400||((long)width*height)>9000000)
    throw new InvalidOperationException("Window screenshot exceeds approved size limits");
  using(var bitmap=new Bitmap(width,height,PixelFormat.Format32bppArgb)) {
   var untouched=Color.FromArgb(255,17,37,59);
   string method="print_window_renderfullcontent";
   if(!DrawWindow(handle,bitmap,2,untouched)) {
    method="print_window_default";
    if(!DrawWindow(handle,bitmap,0,untouched))
     throw new InvalidOperationException("Authorized window could not be captured (PrintWindow returned no pixels)");
   }
   double ratio=Math.Min(1,Math.Min(1440.0/width,1080.0/height));
   int targetWidth=Math.Max(1,(int)Math.Round(width*ratio));
   int targetHeight=Math.Max(1,(int)Math.Round(height*ratio));
   using(var scaled=new Bitmap(targetWidth,targetHeight,PixelFormat.Format24bppRgb)) {
    using(var graphics=Graphics.FromImage(scaled)) {
     graphics.InterpolationMode=InterpolationMode.HighQualityBicubic;
     graphics.DrawImage(bitmap,0,0,targetWidth,targetHeight);
    }
    using(var stream=new MemoryStream()) {
     scaled.Save(stream,ImageFormat.Png);
     return new {image=Convert.ToBase64String(stream.ToArray()),window_x=rect.Left,window_y=rect.Top,width,height,image_width=targetWidth,image_height=targetHeight,capture_method=method};
    }
   }
  }
 }
}
`;
