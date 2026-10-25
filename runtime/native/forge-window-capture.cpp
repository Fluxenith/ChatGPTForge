// Optional Windows Graphics Capture companion. Captures only the exact HWND
// provided by Forge after its local 15-minute window grant and identity check.
// Stdout: one base64 PNG. Nonzero exit: caller falls back to PrintWindow.
// Build with scripts/build-window-capture.ps1 (Windows SDK + MSVC, no NuGet).
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wincodec.h>
#include <objidl.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <winrt/base.h>
#include <algorithm>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

using namespace winrt;
namespace graphics = winrt::Windows::Graphics;
namespace capture = winrt::Windows::Graphics::Capture;
namespace direct3d = winrt::Windows::Graphics::DirectX::Direct3D11;
static const char* capture_stage = "entry";

static std::string base64(const unsigned char* data, size_t count) {
  static constexpr char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string encoded;
  encoded.reserve(((count + 2) / 3) * 4);
  for (size_t i = 0; i < count; i += 3) {
    uint32_t value = static_cast<uint32_t>(data[i]) << 16;
    if (i + 1 < count) value |= static_cast<uint32_t>(data[i + 1]) << 8;
    if (i + 2 < count) value |= data[i + 2];
    encoded.push_back(alphabet[(value >> 18) & 63]);
    encoded.push_back(alphabet[(value >> 12) & 63]);
    encoded.push_back(i + 1 < count ? alphabet[(value >> 6) & 63] : '=');
    encoded.push_back(i + 2 < count ? alphabet[value & 63] : '=');
  }
  return encoded;
}

static std::vector<unsigned char> encode_png(
    ID3D11Device* d3d_device, ID3D11DeviceContext* d3d_context,
    ID3D11Texture2D* source, uint32_t width, uint32_t height) {
  capture_stage = "map_texture";
  D3D11_TEXTURE2D_DESC desc{};
  source->GetDesc(&desc);
  if (width < 1 || height < 1 || width > 4096 || height > 2400 ||
      uint64_t(width) * height > 9000000 || width > desc.Width ||
      height > desc.Height || desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM) {
    throw std::runtime_error("invalid captured window frame");
  }

  desc.Usage = D3D11_USAGE_STAGING;
  desc.BindFlags = 0;
  desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  desc.MiscFlags = 0;
  com_ptr<ID3D11Texture2D> staging;
  check_hresult(d3d_device->CreateTexture2D(&desc, nullptr, staging.put()));
  d3d_context->CopyResource(staging.get(), source);

  D3D11_MAPPED_SUBRESOURCE mapped{};
  check_hresult(d3d_context->Map(staging.get(), 0, D3D11_MAP_READ, 0, &mapped));
  try {
    if (uint64_t(mapped.RowPitch) * height > UINT32_MAX)
      throw std::runtime_error("window frame stride exceeds limit");
    capture_stage = "wic_bitmap";
    com_ptr<IWICImagingFactory> factory;
    check_hresult(CoCreateInstance(CLSID_WICImagingFactory, nullptr,
        CLSCTX_INPROC_SERVER, IID_PPV_ARGS(factory.put())));
    com_ptr<IWICBitmap> bitmap;
    check_hresult(factory->CreateBitmapFromMemory(
        width, height, GUID_WICPixelFormat32bppBGRA, mapped.RowPitch,
        mapped.RowPitch * height, static_cast<BYTE*>(mapped.pData), bitmap.put()));

    const double scale = std::min(1.0, std::min(1440.0 / width, 1080.0 / height));
    const auto target_width = std::max(1u, static_cast<uint32_t>(width * scale + 0.5));
    const auto target_height = std::max(1u, static_cast<uint32_t>(height * scale + 0.5));
    com_ptr<IWICBitmapSource> source_bitmap = bitmap.as<IWICBitmapSource>();
    com_ptr<IWICBitmapScaler> scaler;
    if (target_width != width || target_height != height) {
      check_hresult(factory->CreateBitmapScaler(scaler.put()));
      check_hresult(scaler->Initialize(bitmap.get(), target_width,
          target_height, WICBitmapInterpolationModeFant));
      source_bitmap = scaler.as<IWICBitmapSource>();
    }

    capture_stage = "wic_encoder";
    com_ptr<IStream> stream;
    check_hresult(CreateStreamOnHGlobal(nullptr, TRUE, stream.put()));
    com_ptr<IWICBitmapEncoder> encoder;
    check_hresult(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, encoder.put()));
    check_hresult(encoder->Initialize(stream.get(), WICBitmapEncoderNoCache));
    com_ptr<IWICBitmapFrameEncode> frame;
    com_ptr<IPropertyBag2> properties;
    check_hresult(encoder->CreateNewFrame(frame.put(), properties.put()));
    check_hresult(frame->Initialize(properties.get()));
    check_hresult(frame->SetSize(target_width, target_height));
    WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
    check_hresult(frame->SetPixelFormat(&format));
    capture_stage = "wic_write_source";
    check_hresult(frame->WriteSource(source_bitmap.get(), nullptr));
    check_hresult(frame->Commit());
    check_hresult(encoder->Commit());

    capture_stage = "wic_memory_stream";
    STATSTG stat{};
    check_hresult(stream->Stat(&stat, STATFLAG_NONAME));
    if (stat.cbSize.QuadPart < 8 || stat.cbSize.QuadPart > 3 * 1024 * 1024)
      throw std::runtime_error("window PNG exceeds output limit");
    HGLOBAL memory = nullptr;
    check_hresult(GetHGlobalFromStream(stream.get(), &memory));
    auto* pixels = static_cast<const unsigned char*>(GlobalLock(memory));
    if (!pixels) throw std::runtime_error("window PNG could not be read");
    std::vector<unsigned char> output(pixels,
        pixels + static_cast<size_t>(stat.cbSize.QuadPart));
    GlobalUnlock(memory);
    d3d_context->Unmap(staging.get(), 0);
    return output;
  } catch (...) {
    d3d_context->Unmap(staging.get(), 0);
    throw;
  }
}

static std::vector<unsigned char> capture_window(HWND hwnd, uint32_t expected_pid) {
  capture_stage = "validate_window";
  DWORD actual_pid = 0;
  GetWindowThreadProcessId(hwnd, &actual_pid);
  if (!IsWindow(hwnd) || !IsWindowVisible(hwnd) || IsIconic(hwnd) ||
      GetAncestor(hwnd, GA_ROOT) != hwnd || actual_pid != expected_pid)
    throw std::runtime_error("window identity unavailable or changed");

  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  capture_stage = "winrt_initialize";
  init_apartment(apartment_type::multi_threaded);
  if (!capture::GraphicsCaptureSession::IsSupported())
    throw std::runtime_error("Windows Graphics Capture is not supported");

  capture_stage = "d3d_device";
  com_ptr<ID3D11Device> d3d_device;
  com_ptr<ID3D11DeviceContext> d3d_context;
  HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
      D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
      d3d_device.put(), nullptr, d3d_context.put());
  if (FAILED(hr)) check_hresult(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP,
      nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
      D3D11_SDK_VERSION, d3d_device.put(), nullptr, d3d_context.put()));

  capture_stage = "winrt_device";
  com_ptr<IDXGIDevice> dxgi = d3d_device.as<IDXGIDevice>();
  com_ptr<::IInspectable> device_inspectable;
  check_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgi.get(),
      reinterpret_cast<::IInspectable**>(device_inspectable.put())));
  auto device = device_inspectable.as<direct3d::IDirect3DDevice>();

  capture_stage = "window_capture_item";
  auto activation = get_activation_factory<capture::GraphicsCaptureItem>();
  auto interop = activation.as<IGraphicsCaptureItemInterop>();
  capture::GraphicsCaptureItem item{nullptr};
  capture_stage = "create_for_window";
  check_hresult(interop->CreateForWindow(hwnd,
      guid_of<capture::IGraphicsCaptureItem>(), put_abi(item)));
  const auto size = item.Size();
  if (size.Width <= 0 || size.Height <= 0 || size.Width > 4096 ||
      size.Height > 2400 || int64_t(size.Width) * size.Height > 9000000)
    throw std::runtime_error("captured window dimensions exceed limits");

  capture_stage = "capture_frame_pool";
  auto pool = capture::Direct3D11CaptureFramePool::CreateFreeThreaded(
      device, graphics::DirectX::DirectXPixelFormat::B8G8R8A8UIntNormalized,
      1, size);
  auto session = pool.CreateCaptureSession(item);
  handle arrived(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!arrived) throw std::runtime_error("could not create capture event");
  const auto token = pool.FrameArrived([event = arrived.get()](
      capture::Direct3D11CaptureFramePool const&, auto const&) {
    SetEvent(event);
  });
  capture_stage = "start_capture";
  session.StartCapture();
  const DWORD result = WaitForSingleObject(arrived.get(), 3000);
  pool.FrameArrived(token);
  if (result != WAIT_OBJECT_0) {
    session.Close();
    pool.Close();
    throw std::runtime_error("Windows Graphics Capture timed out");
  }

  capture_stage = "get_frame";
  auto frame = pool.TryGetNextFrame();
  if (!frame) throw std::runtime_error("Windows Graphics Capture returned no frame");
  auto surface = frame.Surface();
  auto access = surface.as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
  com_ptr<ID3D11Texture2D> texture;
  check_hresult(access->GetInterface(__uuidof(ID3D11Texture2D), texture.put_void()));
  const auto content_size = frame.ContentSize();
  capture_stage = "encode_png";
  auto png = encode_png(d3d_device.get(), d3d_context.get(), texture.get(),
      static_cast<uint32_t>(content_size.Width),
      static_cast<uint32_t>(content_size.Height));
  frame.Close();
  session.Close();
  pool.Close();
  return png;
}

int wmain(int argc, wchar_t** argv) {
  try {
    if (argc != 3) throw std::runtime_error("expected HWND and PID");
    const auto number = std::stoull(argv[1]);
    const auto pid = std::stoul(argv[2]);
    if (number == 0 || number > UINTPTR_MAX || pid == 0 || pid > UINT32_MAX)
      throw std::runtime_error("invalid window identity");
    const auto hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(number));
    const auto png = capture_window(hwnd, static_cast<uint32_t>(pid));
    std::cout << base64(png.data(), png.size()) << "\n";
    return 0;
  } catch (winrt::hresult_error const& error) {
    std::cerr << "Windows Graphics Capture HRESULT 0x" << std::hex
              << static_cast<uint32_t>(error.code()) << " at " << capture_stage << "\n";
    return 4;
  } catch (std::exception const& error) {
    std::cerr << error.what() << "\n";
    return 2;
  } catch (...) {
    std::cerr << "Windows Graphics Capture unavailable\n";
    return 3;
  }
}
