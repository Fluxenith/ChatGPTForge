package forge;

import java.nio.file.*;
import java.util.*;
import org.apache.maven.eventspy.AbstractEventSpy;
import org.apache.maven.execution.ExecutionEvent;
import org.apache.maven.project.MavenProject;
import org.codehaus.plexus.util.xml.Xpp3Dom;

/** Explicit build export: Maven owns profiles, mediation, repositories and reactor. */
public final class ForgeMavenModel extends AbstractEventSpy {
  private final Map<String,String> compilers=new HashMap<>();
  private final Map<String,List<String>> kotlinRoots=new HashMap<>();
  private static String value(Xpp3Dom c,String name,MavenProject p){
    if(c==null||c.getChild(name)==null)return null;String s=c.getChild(name).getValue();if(s==null)return null;
    for(var e:p.getProperties().entrySet())s=s.replace("${"+e.getKey()+"}",e.getValue().toString());
    return s.contains("${")?null:s.trim();
  }
  private static List<String> values(Xpp3Dom c,String name){
    List<String> result=new ArrayList<>();if(c!=null&&c.getChild(name)!=null)for(var v:c.getChild(name).getChildren())if(v.getValue()!=null)result.add(v.getValue().trim());return result;
  }
  private void captureCompiler(ExecutionEvent e) throws Exception{
    var mojo=e.getMojoExecution();if(mojo==null||!mojo.getGroupId().equals("org.jetbrains.kotlin")||!mojo.getArtifactId().equals("kotlin-maven-plugin")||!Set.of("compile","test-compile").contains(mojo.getGoal()))return;
    Xpp3Dom c=mojo.getConfiguration();List<String> fields=new ArrayList<>(),options=new ArrayList<>(),jars=new ArrayList<>();
    List<String> sourceDirs=new ArrayList<>();
    for(String r:values(c,"sourceDirs")){
      r=r.replace("${project.basedir}",e.getProject().getBasedir().toString()).replace("${project.build.directory}",e.getProject().getBuild().getDirectory());
      for(var prop:e.getProject().getProperties().entrySet())r=r.replace("${"+prop.getKey()+"}",prop.getValue().toString());
      if(r.contains("${"))throw new IllegalStateException("Unresolved Kotlin sourceDir");
      Path dir=Path.of(r);sourceDirs.add((dir.isAbsolute()?dir:e.getProject().getBasedir().toPath().resolve(dir)).normalize().toString());
    }
    kotlinRoots.put(e.getProject().getId()+":"+mojo.getGoal(),sourceDirs);
    for(String k:List.of("languageVersion","apiVersion","jvmTarget")){String v=value(c,k,e.getProject());if(v!=null)fields.add(q(k)+":"+q(v));}
    var descriptor=mojo.getMojoDescriptor().getPluginDescriptor();
    var realm=descriptor.getClassRealm();
    Map<String,String> ids=new LinkedHashMap<>();
    Set<String> providerJars=new HashSet<>();
    var container=(org.codehaus.plexus.DefaultPlexusContainer)e.getSession().getContainer();
    var previous=container.setLookupRealm(realm);
    var thread=Thread.currentThread();var previousLoader=thread.getContextClassLoader();thread.setContextClassLoader(realm);
    try{
      for(String plugin:values(c,"compilerPlugins")){
        Class<?> role=realm.loadClass("org.jetbrains.kotlin.maven.KotlinMavenPluginExtension");
        Object extension=container.lookup(role.getName(),plugin);
        if(!(Boolean)role.getMethod("isApplicable",MavenProject.class,org.apache.maven.plugin.MojoExecution.class).invoke(extension,e.getProject(),mojo))continue;
        String id=(String)role.getMethod("getCompilerPluginId").invoke(extension);ids.put(plugin,id);
        providerJars.add(Path.of(extension.getClass().getProtectionDomain().getCodeSource().getLocation().toURI()).toString());
        for(Object option:(List<?>)role.getMethod("getPluginOptions",MavenProject.class,org.apache.maven.plugin.MojoExecution.class).invoke(extension,e.getProject(),mojo)){
          Class<?> type=option.getClass();options.add("plugin:"+type.getField("pluginId").get(option)+":"+type.getField("key").get(option)+"="+type.getField("value").get(option));
        }
      }
    }finally{thread.setContextClassLoader(previousLoader);container.setLookupRealm(previous);}
    for(String option:values(c,"pluginOptions")){
      int at=option.indexOf(':');if(at<0||!ids.containsKey(option.substring(0,at)))throw new IllegalStateException("Invalid Kotlin plugin option");options.add("plugin:"+ids.get(option.substring(0,at))+":"+option.substring(at+1));
    }
    var artifacts=mojo.getMojoDescriptor().getPluginDescriptor().getArtifacts();
    // Capture declared plugin dependency closures, including custom helper JARs.
    // The compiler distribution is supplied by the pinned language server.
    Set<String> declared=new HashSet<>();for(var dep:descriptor.getPlugin().getDependencies())declared.add(dep.getGroupId()+":"+dep.getArtifactId()+":");
    if(!ids.isEmpty())for(var a:artifacts){
      String id=a.getArtifactId();
      if(a.getGroupId().equals("org.jetbrains.kotlin")&&(id.startsWith("kotlin-compiler")||id.startsWith("kotlin-stdlib")||id.equals("kotlin-reflect")||id.startsWith("kotlin-scripting")||id.equals("kotlin-daemon-embeddable")))continue;
      boolean include=providerJars.contains(a.getFile().toPath().toString())||declared.stream().anyMatch(d->(a.getGroupId()+":"+id+":").startsWith(d))||a.getDependencyTrail()!=null&&a.getDependencyTrail().stream().anyMatch(t->declared.stream().anyMatch(t::startsWith));
      try(var jar=new java.util.zip.ZipFile(a.getFile())){for(String service:List.of("CompilerPluginRegistrar","ComponentRegistrar","CommandLineProcessor"))include|=jar.getEntry("META-INF/services/org.jetbrains.kotlin.compiler.plugin."+service)!=null;}
      if(include)jars.add(a.getFile().getAbsolutePath());
    }
    if(!values(c,"compilerPlugins").isEmpty()&&jars.isEmpty())throw new IllegalStateException("Compiler plugin artifacts missing");
    fields.add("\"pluginIds\":"+list(new LinkedHashSet<>(ids.values())));fields.add("\"pluginOptions\":"+list(options));fields.add("\"pluginClasspaths\":"+list(jars));fields.add("\"freeArgs\":"+list(values(c,"args")));
    compilers.put(e.getProject().getId()+":"+mojo.getGoal(),"{"+String.join(",",fields)+"}");
  }
  private static String q(String s) {
    StringBuilder b=new StringBuilder("\"");
    for(char c:s.toCharArray()) { if(c=='"'||c=='\\')b.append('\\').append(c);else if(c<32)b.append(String.format("\\u%04x",(int)c));else b.append(c); }
    return b.append('"').toString();
  }
  private static String list(Collection<String> xs) {return "["+String.join(",",xs.stream().map(ForgeMavenModel::q).toList())+"]";}
  private static boolean source(Path root) throws Exception {
    if(!Files.isDirectory(root))return false;
    try(var files=Files.walk(root)){return files.anyMatch(f->f.toString().endsWith(".java")||f.toString().endsWith(".kt"));}
  }
  @Override public void onEvent(Object event) throws Exception {
    if(!(event instanceof ExecutionEvent e))return;
    if(e.getType()==ExecutionEvent.Type.MojoSucceeded){try{captureCompiler(e);}catch(Exception ex){compilers.put("ERROR",ex.toString());}return;}
    if(e.getType()!=ExecutionEvent.Type.SessionEnded)return;
    if(e.getSession().getResult().hasExceptions())return;
    if(compilers.containsKey("ERROR"))throw new IllegalStateException(compilers.get("ERROR"));
    var projects=e.getSession().getProjects();
    Map<String,String> outputs=new HashMap<>();
    for(int i=0;i<projects.size();i++){
      var p=projects.get(i);outputs.put(Path.of(p.getBuild().getOutputDirectory()).toAbsolutePath().normalize().toString(),"maven"+i+"_main");
      outputs.put(Path.of(p.getBuild().getTestOutputDirectory()).toAbsolutePath().normalize().toString(),"maven"+i+"_test");
    }
    List<String> modules=new ArrayList<>();
    Set<String> mainRoots=new HashSet<>();
    for(int i=0;i<projects.size();i++)for(boolean test:new boolean[]{false,true}){
      MavenProject p=projects.get(i);
      List<String> candidates=new ArrayList<>(test?p.getTestCompileSourceRoots():p.getCompileSourceRoots());
      candidates.addAll(kotlinRoots.getOrDefault(p.getId()+":"+(test?"test-compile":"compile"),List.of()));
      List<String> roots=new ArrayList<>();
      for(String r:candidates)if(source(Path.of(r))){String canonical=Path.of(r).toRealPath().toString();if(!roots.contains(canonical)&&(!test||!mainRoots.contains(canonical)))roots.add(canonical);}
      if(!test)mainRoots.addAll(roots);
      if(roots.isEmpty())continue;
      String name="maven"+i+(test?"_test":"_main");
      Set<String> deps=new LinkedHashSet<>(),libs=new LinkedHashSet<>();
      for(String entry:test?p.getTestClasspathElements():p.getCompileClasspathElements()){
        String path=Path.of(entry).toAbsolutePath().normalize().toString(),peer=outputs.get(path);
        if(peer!=null){if(!peer.equals(name))deps.add(peer);}
        else if(Files.isRegularFile(Path.of(path)))libs.add(path);
        else throw new IllegalStateException("Unrepresented Maven classpath entry: "+path);
      }
      String compiler=compilers.get(p.getId()+":"+(test?"test-compile":"compile"));
      Path build=Path.of(p.getBuild().getDirectory()).toAbsolutePath().normalize();
      var generated=roots.stream().filter(r->Path.of(r).startsWith(build)).toList();
      modules.add("{\"name\":"+q(name)+",\"roots\":"+list(roots)+",\"generatedRoots\":"+list(generated)+",\"dependencies\":"+list(deps)+",\"libraries\":"+list(libs)+(compiler==null?"":",\"compiler\":"+compiler)+"}");
    }
    Files.writeString(Path.of(System.getenv("FORGE_MODEL_OUTPUT")),"{\"modules\":["+String.join(",",modules)+"]}");
  }
}
