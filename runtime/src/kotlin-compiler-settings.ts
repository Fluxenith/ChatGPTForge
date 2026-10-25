export interface KotlinCompilerSettings {languageVersion?:string;apiVersion?:string;jvmTarget?:string;pluginIds?:string[];pluginOptions?:string[];pluginClasspaths?:string[];freeArgs?:string[]}
export function validateKotlinCompiler(c:KotlinCompilerSettings){
 if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(k=>!['languageVersion','apiVersion','jvmTarget','pluginIds','pluginOptions','pluginClasspaths','freeArgs'].includes(k)))throw Error('Unsupported Kotlin compiler settings');
 for(const k of ['languageVersion','apiVersion','jvmTarget'] as const)if(c[k]!==undefined&&(typeof c[k]!=='string'||!/^\d+(\.\d+)?$/.test(c[k]!)))throw Error('Invalid Kotlin compiler version/target');
 for(const k of ['pluginIds','pluginOptions','pluginClasspaths','freeArgs'] as const)if(c[k]!==undefined&&(!Array.isArray(c[k])||c[k]!.length>256||c[k]!.some(v=>typeof v!=='string'||v.length>4096)))throw Error('Invalid Kotlin compiler option list');
 for(const id of c.pluginIds??[])if(!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/.test(id))throw Error('Invalid Kotlin compiler plugin ID');
 for(const v of c.pluginOptions??[]){
  const custom=/^plugin:([\w.-]+):([\w.-]+)=([\w.$,+@ -]*)$/.exec(v);
  if(custom&&c.pluginIds?.includes(custom[1]!)&&!/path|file|dir|output|report|metric/i.test(custom[2]!)&&!custom[3]!.includes('..'))continue;
  if(!/^plugin:(org\.jetbrains\.kotlin\.(allopen|noarg|samWithReceiver)|kotlinx-serialization):(annotation|preset|invokeInitializers|disableIntrinsic)=([\w.$-]+)$/.test(v)&&!/^plugin:androidx\.compose\.compiler\.plugins\.kotlin:((sourceInformation|traceMarkersEnabled|generateFunctionKeyMetaClasses|intrinsicRemember|nonSkippingGroupOptimization|strongSkipping)=(true|false)|featureFlag=[-+\w]+)$/.test(v))throw Error('Unrepresented Kotlin compiler plugin option: '+v);
 }
 for(const v of c.freeArgs??[])if(!/^(-X(jvm-default|lambdas|jsr305)=[\w-]+|-Xcontext-(receivers|parameters)|-opt-in=[\w.]+|-progressive|-java-parameters)$/.test(v))throw Error('Unrepresented Kotlin compiler argument: '+v);
}
export function kotlinSettings(name:string,roots:string[],c:KotlinCompilerSettings){
 validateKotlinCompiler(c);
 return {name:'Kotlin',module:name,sourceRoots:roots.map(r=>'<WORKSPACE>/'+r),configFileItems:[],useProjectSettings:false,
 implementedModuleNames:[],dependsOnModuleNames:[],additionalVisibleModuleNames:[],productionOutputPath:null,testOutputPath:null,sourceSetNames:[],isTestModule:name.endsWith('_test'),externalProjectId:name,isHmppEnabled:false,pureKotlinSourceFolders:[],kind:'default',
 compilerArguments:'J'+JSON.stringify({...(c.languageVersion?{languageVersion:c.languageVersion}:{}),...(c.apiVersion?{apiVersion:c.apiVersion}:{}),...(c.jvmTarget?{jvmTarget:c.jvmTarget}:{}),pluginOptions:c.pluginOptions??[],pluginClasspaths:(c.pluginClasspaths??[]).map(p=>'<WORKSPACE>/'+p)}),additionalArguments:(c.freeArgs??[]).join(' '),scriptTemplates:null,scriptTemplatesClasspath:null,outputDirectoryForJsLibraryFiles:null,targetPlatform:null,externalSystemRunTasks:[],version:5,flushNeeded:false};
}
