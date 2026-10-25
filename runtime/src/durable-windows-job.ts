import koffi from "koffi";
import { join } from "node:path";

// The shell starts suspended, enters a non-breakaway job, then resumes.
// Only the worker owns the job handle: worker death closes it and kills members.
// Recovery queries identity and job membership; it never kills a saved PID.
export function startWindowsJob(command: string, cwd: string, outputPath: string, jobName: string,options:{memoryLimitMiB?:number}={}) {
  const kernel = koffi.load("kernel32.dll");
  const security = koffi.struct({length:"uint32",descriptor:"void *",inherit:"int"});
  const startup = koffi.struct({cb:"uint32",reserved:"void *",desktop:"void *",title:"void *",
    x:"uint32",y:"uint32",xSize:"uint32",ySize:"uint32",xChars:"uint32",yChars:"uint32",fill:"uint32",
    flags:"uint32",show:"uint16",reserved2Size:"uint16",reserved2:"void *",stdin:"void *",stdout:"void *",stderr:"void *"});
  const processInfo = koffi.struct({process:"void *",thread:"void *",pid:"uint32",tid:"uint32"});
  const basicLimit = koffi.struct({processTime:"int64",jobTime:"int64",flags:"uint32",minWorking:"size_t",maxWorking:"size_t",active:"uint32",affinity:"uintptr_t",priority:"uint32",scheduling:"uint32"});
  const ioCounters = koffi.struct({readOps:"uint64",writeOps:"uint64",otherOps:"uint64",readBytes:"uint64",writeBytes:"uint64",otherBytes:"uint64"});
  const extended = koffi.struct({basic:basicLimit,io:ioCounters,processMemory:"size_t",jobMemory:"size_t",peakProcess:"size_t",peakJob:"size_t"});
  const accounting = koffi.struct({user:"int64",kernel:"int64",periodUser:"int64",periodKernel:"int64",faults:"uint32",total:"uint32",active:"uint32",terminated:"uint32"});
  const createJob=kernel.func("void * __stdcall CreateJobObjectW(void *, const char16_t *)");
  const setJob=kernel.func("SetInformationJobObject","int",["void *","int","void *","uint32"]);
  const assign=kernel.func("int __stdcall AssignProcessToJobObject(void *, void *)");
  const terminate=kernel.func("int __stdcall TerminateJobObject(void *, uint32)");
  const close=kernel.func("int __stdcall CloseHandle(void *)");
  const error=kernel.func("uint32 __stdcall GetLastError()");
  const createFile=kernel.func("CreateFileW","void *",["str16","uint32","uint32",koffi.pointer(security),"uint32","uint32","void *"]);
  const createProcess=kernel.func("CreateProcessW","int",["str16","void *","void *","void *","int","uint32","void *","str16",koffi.pointer(startup),koffi.out(koffi.pointer(processInfo))]);
  const resume=kernel.func("uint32 __stdcall ResumeThread(void *)");
  const terminateProcess=kernel.func("int __stdcall TerminateProcess(void *, uint32)");
  const query=kernel.func("QueryInformationJobObject","int",["void *","int",koffi.out(koffi.pointer(accounting)),"uint32","void *"]);
  const exitCode=kernel.func("GetExitCodeProcess","int",["void *",koffi.out(koffi.pointer("uint32"))]);
  const getTimes=kernel.func("GetProcessTimes","int",["void *",koffi.out(koffi.pointer("uint64")),koffi.out(koffi.pointer("uint64")),koffi.out(koffi.pointer("uint64")),koffi.out(koffi.pointer("uint64"))]);
  const createPipe=kernel.func('CreatePipe','int',[koffi.out(koffi.pointer('void *')),koffi.out(koffi.pointer('void *')),koffi.pointer(security),'uint32']);
  const setHandle=kernel.func('int __stdcall SetHandleInformation(void *, uint32, uint32)');
  const write=kernel.func('WriteFile','int',['void *','void *','uint32',koffi.out(koffi.pointer('uint32')),'void *']);
  const fail=(name:string):never=>{throw new Error(`${name}: Windows error ${error()}`);};
  const invalid=(handle:unknown)=>handle == null || koffi.address(handle) === BigInt.asUintN(koffi.sizeof("void *")*8,-1n);
  let job:unknown;
  let output:unknown;
  let input:unknown;
  let inputWriter:unknown;
  const info: {process?:unknown;thread?:unknown;pid?:number;tid?:number}={};
  try {
    job=createJob(null,jobName); if(invalid(job)) fail("CreateJobObject");
    if(error() === 183) throw new Error("Job name already exists; refusing launch");
    const limits=Buffer.alloc(koffi.sizeof(extended));
    // The two int64 time limits precede LimitFlags on both Windows architectures.
    limits.writeUInt32LE(0x2000,16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if(options.memoryLimitMiB!==undefined) {
      if(!Number.isInteger(options.memoryLimitMiB)||options.memoryLimitMiB<1||options.memoryLimitMiB>4096)throw new Error('Invalid job memory limit');
      limits.writeUInt32LE(0x2200,16); // also JOB_OBJECT_LIMIT_JOB_MEMORY
      const offset=koffi.offsetof(extended,'jobMemory'),bytes=options.memoryLimitMiB*1024*1024;
      if(koffi.sizeof('size_t')===8)limits.writeBigUInt64LE(BigInt(bytes),offset);
      else limits.writeUInt32LE(bytes,offset);
    }
    if(!setJob(job,9,limits,limits.length)) fail("SetInformationJobObject");
    const sa={length:koffi.sizeof(security),descriptor:null,inherit:1};
    output=createFile(outputPath,0x40000000,3,sa,2,0x80,null);
    if(invalid(output)) fail("Create output");
    const readPipe=[null],writePipe=[null];
    if(!createPipe(readPipe,writePipe,sa,65536))fail('CreatePipe');
    input=readPipe[0];inputWriter=writePipe[0];
    if(!setHandle(inputWriter,1,0))fail('SetHandleInformation stdin');
    const executable=join(process.env.SystemRoot ?? "C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe");
    const script="$ErrorActionPreference='Stop'; [Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; & {\n"+command+"\n}; if ($LASTEXITCODE) { exit $LASTEXITCODE }; if (-not $?) { exit 1 }";
    const commandLine=Buffer.from(`"${executable}" -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script,"utf16le").toString("base64")}\0`,"utf16le");
    const si={cb:koffi.sizeof(startup),reserved:null,desktop:null,title:null,x:0,y:0,xSize:0,ySize:0,xChars:0,yChars:0,fill:0,flags:0x100,show:0,reserved2Size:0,reserved2:null,stdin:input,stdout:output,stderr:output};
    if(!createProcess(executable,commandLine,null,null,1,0x08000004,null,cwd,si,info)) fail("CreateProcess suspended");
    if(!assign(job,info.process)) fail("AssignProcessToJobObject");
    const created=[0n], ended=[0n], kernelTime=[0n], userTime=[0n];
    if(!getTimes(info.process,created,ended,kernelTime,userTime)) fail("GetProcessTimes");
    if(resume(info.thread)===0xffffffff) fail("ResumeThread");
    close(info.thread); info.thread=undefined;
    close(output); output=undefined; close(input); input=undefined;
    return {
      pid:info.pid!, creation_time:String(created[0]),
      input(data:string,eof:boolean):Promise<void> {
        if(!inputWriter)return Promise.reject(new Error('stdin is closed'));
        const bytes=Buffer.from(data),written=[0];
        return new Promise((resolve,reject)=>{
          write.async(inputWriter,bytes,bytes.length,written,null,(err:unknown,ok:number)=>{
            if(err || !ok || written[0]!==bytes.length){reject(new Error('stdin delivery is unknown; do not resend'));return;}
            if(eof){close(inputWriter);inputWriter=undefined;}resolve();
          });
        });
      },
      stop() { if(!terminate(job,1)) fail("TerminateJobObject"); },
      poll():number|null {
        const stats:{active?:number}={};
        if(!query(job,1,stats,koffi.sizeof(accounting),null)) fail("QueryInformationJobObject");
        if(stats.active !== 0) return null;
        const code=[0]; if(!exitCode(info.process,code)) fail("GetExitCodeProcess");
        return code[0]!;
      },
      close() { if(info.process) close(info.process); if(job) close(job); if(inputWriter)close(inputWriter);inputWriter=undefined;info.process=undefined; job=undefined; },
    };
  } catch (err) {
    // The shell has not run if assignment/resume failed; do not fall back to an uncontained launch.
    if(info.process) { terminateProcess(info.process,1); close(info.process); }
    if(info.thread) close(info.thread);
    if(output && !invalid(output)) close(output);
    if(input && !invalid(input)) close(input);
    if(inputWriter && !invalid(inputWriter))close(inputWriter);
    if(job && !invalid(job)) close(job);
    throw err;
  }
}

export function windowsProcessIdentity(pid: number): string | null {
  const k=koffi.load("kernel32.dll");
  const open=k.func("void * __stdcall OpenProcess(uint32, int, uint32)");
  const close=k.func("int __stdcall CloseHandle(void *)");
  const error=k.func("uint32 __stdcall GetLastError()");
  const wait=k.func("uint32 __stdcall WaitForSingleObject(void *, uint32)");
  const times=k.func("GetProcessTimes","int",["void *",...Array.from({length:4},()=>koffi.out(koffi.pointer("uint64")))]);
  const handle=open(0x101000,0,pid); // query limited information + synchronize
  if(!handle) {
    const code=error();
    if(code === 87) return null; // PID no longer exists
    throw new Error(`Cannot inspect worker identity: Windows error ${code}`);
  }
  try {
    const created=[0n],ended=[0n],kernel=[0n],user=[0n];
    if(!times(handle,created,ended,kernel,user)) throw new Error(`GetProcessTimes: ${error()}`);
    const status=wait(handle,0);
    if(status === 0) return null;
    if(status !== 258) throw new Error(`Cannot determine worker liveness: ${status}`);
    return String(created[0]);
  } finally {close(handle);}
}

// Call only AFTER the original worker is proven dead. Opening its job while it
// is alive would keep an extra handle and defeat kill-on-last-handle-close.
export function assertWindowsJobStopped(pid: number, creation: string, name: string) {
  if(windowsProcessIdentity(pid) === creation) throw new Error("Original worker is still running; cancel or wait first");
  const k=koffi.load("kernel32.dll");
  const open=k.func("void * __stdcall OpenJobObjectW(uint32, int, const char16_t *)");
  const close=k.func("int __stdcall CloseHandle(void *)");
  const error=k.func("uint32 __stdcall GetLastError()");
  const query=k.func("int __stdcall QueryInformationJobObject(void *, int, void *, uint32, void *)");
  const job=open(4,0,name); // JOB_OBJECT_QUERY only
  if(!job) {
    const code=error();
    if(code === 2) return; // named job no longer exists
    throw new Error(`Cannot inspect job: Windows error ${code}`);
  }
  try {
    const stats=Buffer.alloc(48);
    if(!query(job,1,stats,stats.length,null)) throw new Error(`Cannot inspect job members: ${error()}`);
    if(stats.readUInt32LE(40) !== 0) throw new Error("Job still contains processes; wait before reconciling");
  } finally {close(job);}
}
