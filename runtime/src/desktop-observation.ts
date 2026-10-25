export type DesktopWorker = (input:Record<string,unknown>, timeoutMs:number)=>Promise<any>;

// UIA runs in a different, disposable process. A hung COM provider must not
// consume the already captured image, or block the next observation worker.
export async function observeDesktop(input:Record<string,unknown>, worker:DesktopWorker, accessibilityTimeoutMs=5000) {
  const capture=await worker({...input,action:'screenshot'},20000);
  try {
    const state=await worker({...input,action:'inspect'},accessibilityTimeoutMs);
    return {...capture,...state,image:capture.image,state:'captured',
      accessibility_available:true,accessibility_status:'available'};
  } catch(error) {
    const timeout=(error as {code?:string})?.code==='DESKTOP_TIMEOUT';
    return {...capture,state:'captured',controls:[],accessibility_available:false,
      accessibility_status:timeout?'timeout':'unavailable',
      accessibility_error:timeout?'UIA observation exceeded its independent deadline':String(error)};
  }
}
