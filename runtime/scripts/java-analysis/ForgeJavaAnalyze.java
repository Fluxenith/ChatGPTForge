import com.sun.source.tree.MemberReferenceTree;
import com.sun.source.tree.NewClassTree;
import javax.lang.model.element.*;
import javax.lang.model.type.*;
import javax.lang.model.util.*;
import javax.tools.StandardLocation;
import java.io.DataInputStream;
import java.util.StringJoiner;
import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.MemberSelectTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import javax.lang.model.element.Element;
import javax.lang.model.element.ElementKind;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

// Owned, source-only Java navigation. The caller copies all files to a private
// snapshot; this process never executes project code or annotation processors.
public class ForgeJavaAnalyze {
    private record Token(String value, int start, int end) {}
    private record Hit(String file, int start, int end, String name,
                       String kind, boolean declaration, Element element) {}
    private record Result(String file, int start, int end, String name,
                          String kind, boolean declaration, String code,
                          String severity, String message) {}
    private static final int MAX_RETURNED = 300;
    private static final List<Hit> hits = new ArrayList<>();
    private static final List<Result> results = new ArrayList<>();
    private static ExternalSource.Definition external;
    private static final class ExternalSource {
  record Token(String text,int start,int end) {}
  record Hit(Element element,String file,Token token,boolean declaration) {}
  static String json(String s){StringBuilder b=new StringBuilder("\"");for(char c:s.toCharArray()){if(c=='"'||c=='\\')b.append('\\').append(c);else if(c<32||c>126)b.append(String.format("\\u%04x",(int)c));else b.append(c);}return b.append('"').toString();}
  static String key(Element e,Types types){
    if(e instanceof TypeElement t)return "T:"+t.getKind()+":"+t.getQualifiedName();
    if(!(e.getEnclosingElement() instanceof TypeElement owner))return null;
    String prefix=owner.getQualifiedName()+"#"+e.getSimpleName();
    if(e instanceof ExecutableElement method){StringJoiner params=new StringJoiner(",","(",")");for(VariableElement p:method.getParameters())params.add(types.erasure(p.asType()).toString());return "M:"+prefix+params+":"+types.erasure(method.getReturnType());}
    if(e instanceof VariableElement)return "F:"+prefix+":"+types.erasure(e.asType());
    return null;
  }
  static TypeElement topOwner(Element element){Element e=element;while(!(e instanceof TypeElement)&&e!=null)e=e.getEnclosingElement();if(!(e instanceof TypeElement))return null;while(e.getEnclosingElement() instanceof TypeElement)e=e.getEnclosingElement();return (TypeElement)e;}
  static void skipAttributes(DataInputStream data)throws Exception{int count=data.readUnsignedShort();for(int i=0;i<count;i++){data.readUnsignedShort();data.skipNBytes(Integer.toUnsignedLong(data.readInt()));}}
  static String sourceFilename(JavaFileObject binary,TypeElement owner)throws Exception{
    byte[] raw;try(var stream=binary.openInputStream()){raw=stream.readNBytes(4*1024*1024+1);}if(raw.length>4*1024*1024)throw new IllegalArgumentException("Binary source metadata exceeds bounds");
    try(var data=new DataInputStream(new java.io.ByteArrayInputStream(raw))){if(data.readInt()!=0xcafebabe)throw new IllegalArgumentException("Invalid binary source metadata");data.readUnsignedShort();data.readUnsignedShort();String[] strings=new String[data.readUnsignedShort()];
      for(int index=1;index<strings.length;index++){int tag=data.readUnsignedByte();switch(tag){case 1->strings[index]=data.readUTF();case 3,4->data.skipNBytes(4);case 5,6->{data.skipNBytes(8);index++;}case 7,8,16,19,20->data.skipNBytes(2);case 9,10,11,12,17,18->data.skipNBytes(4);case 15->data.skipNBytes(3);default->throw new IllegalArgumentException("Unsupported binary metadata constant");}}
      data.skipNBytes(6);data.skipNBytes(data.readUnsignedShort()*2L);for(int group=0;group<2;group++){int count=data.readUnsignedShort();for(int index=0;index<count;index++){data.skipNBytes(6);skipAttributes(data);}}
      int count=data.readUnsignedShort();String name=null;for(int index=0;index<count;index++){int key=data.readUnsignedShort();long size=Integer.toUnsignedLong(data.readInt());if(key<=0||key>=strings.length)throw new IllegalArgumentException("Invalid binary metadata attribute");if("SourceFile".equals(strings[key])){if(size!=2||name!=null)throw new IllegalArgumentException("Invalid binary source filename metadata");int value=data.readUnsignedShort();if(value<=0||value>=strings.length)throw new IllegalArgumentException("Invalid binary source filename metadata");name=strings[value];}else data.skipNBytes(size);}
      if(name==null)name=owner.getSimpleName()+".java";if(!name.endsWith(".java")||name.contains("/")||name.contains("\\")||name.contains(":")||name.indexOf(0)>=0||name.equals(".java"))throw new IllegalArgumentException("Unsafe binary source filename");return name;
    }
  }
  static List<Token> tokens(String s,int start,int end){
    List<Token> out=new ArrayList<>();int i=Math.max(0,start),limit=Math.min(s.length(),end);
    while(i<limit){char c=s.charAt(i);
      if(c=='/'&&i+1<limit&&s.charAt(i+1)=='/'){i+=2;while(i<limit&&s.charAt(i)!='\r'&&s.charAt(i)!='\n')i++;}
      else if(c=='/'&&i+1<limit&&s.charAt(i+1)=='*'){i+=2;while(i+1<limit&&!(s.charAt(i)=='*'&&s.charAt(i+1)=='/'))i++;i=Math.min(limit,i+2);}
      else if(c=='"'||c=='\''){char q=c;boolean triple=q=='"'&&i+2<limit&&s.charAt(i+1)=='"'&&s.charAt(i+2)=='"';i+=triple?3:1;while(i<limit){if(s.charAt(i)=='\\'){i=Math.min(limit,i+2);continue;}if(triple&&i+2<limit&&s.charAt(i)=='"'&&s.charAt(i+1)=='"'&&s.charAt(i+2)=='"'){i+=3;break;}if(!triple&&s.charAt(i++)==q)break;if(triple)i++;}}
      else if(Character.isJavaIdentifierStart(s.codePointAt(i))){int begin=i;i+=Character.charCount(s.codePointAt(i));while(i<limit&&Character.isJavaIdentifierPart(s.codePointAt(i)))i+=Character.charCount(s.codePointAt(i));out.add(new Token(s.substring(begin,i),begin,i));}
      else i++;
    }return out;
  }
  static List<Hit> scan(JavacTask task,CompilationUnitTree unit)throws Exception{
    Trees trees=Trees.instance(task);String source=unit.getSourceFile().getCharContent(false).toString(),file=unit.getSourceFile().toUri().toString();List<Hit> hits=new ArrayList<>();
    new TreePathScanner<Void,Void>(){
      void add(Tree node,String name,boolean declaration){Element e=trees.getElement(getCurrentPath());if(e==null||name.isEmpty()||name.equals("<init>"))return;long begin=trees.getSourcePositions().getStartPosition(unit,node),finish=trees.getSourcePositions().getEndPosition(unit,node);if(begin<0||finish<=begin||finish>source.length())return;
        List<Token> found=tokens(source,(int)begin,(int)Math.min(finish,begin+(declaration?4096:16384)));Token token=null;
        if(declaration&&node instanceof ClassTree){for(int i=1;i<found.size();i++)if(found.get(i).text.equals(name)&&List.of("class","interface","enum","record").contains(found.get(i-1).text)){token=found.get(i);break;}}
        else if(declaration&&node instanceof MethodTree){for(Token t:found)if(t.text.equals(name)&&source.substring(t.end,Math.min((int)finish,t.end+32)).stripLeading().startsWith("(")){token=t;break;}}
        else if(node instanceof MemberSelectTree){for(int i=found.size()-1;i>=0;i--)if(found.get(i).text.equals(name)){token=found.get(i);break;}}
        else for(Token t:found)if(t.text.equals(name)){token=t;break;}
        if(token!=null)hits.add(new Hit(e,file,token,declaration));
      }
      public Void visitClass(ClassTree n,Void x){add(n,n.getSimpleName().toString(),true);return super.visitClass(n,x);}
      public Void visitMethod(MethodTree n,Void x){Element e=trees.getElement(getCurrentPath());String name=n.getName().toString();if(name.equals("<init>")&&e!=null&&e.getEnclosingElement() instanceof TypeElement owner)name=owner.getSimpleName().toString();add(n,name,true);return super.visitMethod(n,x);}
      public Void visitVariable(VariableTree n,Void x){add(n,n.getName().toString(),true);return super.visitVariable(n,x);}
      public Void visitIdentifier(IdentifierTree n,Void x){add(n,n.getName().toString(),false);return super.visitIdentifier(n,x);}
      public Void visitMemberSelect(MemberSelectTree n,Void x){add(n,n.getIdentifier().toString(),false);return super.visitMemberSelect(n,x);}
    }.scan(unit,null);return hits;
  }
  static JavacTask compiler(JavaCompiler compiler,StandardJavaFileManager manager,DiagnosticCollector<JavaFileObject> diagnostics,Iterable<? extends JavaFileObject> sources,String cp,Path empty,Path sourcePath){return (JavacTask)compiler.getTask(new StringWriter(),manager,diagnostics,List.of("--release","21","-proc:none","-implicit:none","-encoding","UTF-8","-classpath",cp,"-processorpath",empty.toString(),"-sourcepath",sourcePath.toString()),null,sources);}
  static void errors(DiagnosticCollector<JavaFileObject> d,String label){for(var error:d.getDiagnostics())if(error.getKind()==Diagnostic.Kind.ERROR)throw new IllegalArgumentException(label+": "+error.getMessage(Locale.ENGLISH));}
  record Definition(int index,String entry,int start,int end,String name,String kind,String key,JdkOrigin jdk) {}
  record Pin(String sha256,long bytes) {}
  record JdkOrigin(String home,String module,String binaryName,String binarySha256,Pin archive,Pin modules,Pin release) {}
  static String hash(byte[] raw)throws Exception{return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(raw));}
  static Path installedFile(Path home,String relative)throws Exception{
    Path path=home;for(Path part:Path.of(relative)){path=path.resolve(part);if(Files.isSymbolicLink(path))throw new IllegalArgumentException("JDK runtime input is a link");}
    if(!path.toRealPath().equals(path)||!Files.isRegularFile(path,java.nio.file.LinkOption.NOFOLLOW_LINKS))throw new IllegalArgumentException("JDK runtime input is not a canonical regular file");return path;
  }
  static Pin pin(Path path,long maximum)throws Exception{
    var before=Files.readAttributes(path,java.nio.file.attribute.BasicFileAttributes.class,java.nio.file.LinkOption.NOFOLLOW_LINKS);
    if(!before.isRegularFile()||before.size()>maximum)throw new IllegalArgumentException("JDK runtime input exceeds bounds");
    var digest=java.security.MessageDigest.getInstance("SHA-256");long bytes=0;
    try(var in=Files.newInputStream(path)){byte[] buffer=new byte[65536];int size;while((size=in.read(buffer))!=-1){bytes+=size;if(bytes>maximum)throw new IllegalArgumentException("JDK runtime input exceeds bounds");digest.update(buffer,0,size);}}
    var after=Files.readAttributes(path,java.nio.file.attribute.BasicFileAttributes.class,java.nio.file.LinkOption.NOFOLLOW_LINKS);
    if(!after.isRegularFile()||bytes!=before.size()||before.size()!=after.size()||!before.lastModifiedTime().equals(after.lastModifiedTime())||!before.creationTime().equals(after.creationTime())||!java.util.Objects.equals(before.fileKey(),after.fileKey())||Files.isSymbolicLink(path))throw new IllegalArgumentException("JDK runtime input changed during capture");
    return new Pin(java.util.HexFormat.of().formatHex(digest.digest()),bytes);
  }
  static List<Hit> matched(JavacTask secondary,List<Hit> hits,Element selected,JavacTask primary,String wanted){
    List<Hit> declarations=hits.stream().filter(h->h.declaration&&wanted.equals(key(h.element,secondary.getTypes()))).toList();
    if(declarations.isEmpty()&&selected instanceof ExecutableElement accessor&&accessor.getParameters().isEmpty()&&accessor.getEnclosingElement() instanceof TypeElement record&&record.getKind()==ElementKind.RECORD&&record.getRecordComponents().stream().anyMatch(component->component.getAccessor().equals(accessor))){
      String field="F:"+record.getQualifiedName()+"#"+accessor.getSimpleName()+":"+primary.getTypes().erasure(accessor.getReturnType());declarations=hits.stream().filter(h->h.declaration&&field.equals(key(h.element,secondary.getTypes()))).toList();
    }
    return declarations;
  }
  static Definition jdk(JavaCompiler compiler,StandardJavaFileManager primary,JavacTask task,Element selected,TypeElement owner,TypeElement declaring,String wanted,Path empty)throws Exception{
    ModuleElement module=task.getElements().getModuleOf(declaring);if(module==null||module.isUnnamed())return null;
    String moduleName=module.getQualifiedName().toString(),binaryName=task.getElements().getBinaryName(declaring).toString();
    var location=primary.getLocationForModule(StandardLocation.SYSTEM_MODULES,moduleName);if(location==null)return null;
    JavaFileObject binary=primary.getJavaFileForInput(location,binaryName,JavaFileObject.Kind.CLASS);
    if(binary==null||!binary.toUri().getScheme().equals("jrt")||!binary.toUri().getPath().equals("/"+moduleName+"/"+binaryName.replace('.','/')+".class"))throw new IllegalArgumentException("JDK binary module origin mismatch");
    Path home=Path.of(System.getProperty("java.home")).toRealPath();
    if(!Files.exists(home.resolve("lib/src.zip"),java.nio.file.LinkOption.NOFOLLOW_LINKS))return null;
    Path archive=installedFile(home,"lib/src.zip"),modules=installedFile(home,"lib/modules"),release=installedFile(home,"release");
    Pin archivePin=pin(archive,64L*1024*1024),modulesPin=pin(modules,512L*1024*1024),releasePin=pin(release,65536);
    String qualified=owner.getQualifiedName().toString(),packageName=qualified.contains(".")?qualified.substring(0,qualified.lastIndexOf('.')):"",filename=sourceFilename(binary,owner),entry=moduleName+"/"+(packageName.isEmpty()?"":packageName.replace('.','/')+"/")+filename;
    byte[] raw;
    try(var zip=new java.util.zip.ZipFile(archive.toFile(),StandardCharsets.UTF_8)){
      if(zip.size()>40000)throw new IllegalArgumentException("JDK source directory exceeds bounds");
      java.util.Set<String> names=new java.util.HashSet<>();var entries=zip.entries();while(entries.hasMoreElements()){String name=entries.nextElement().getName();if(!names.add(name)||name.startsWith("/")||name.contains("\\")||name.indexOf(0)>=0||name.contains(":")||java.util.Arrays.stream(name.split("/",-1)).anyMatch(part->part.equals(".")||part.equals("..")))throw new IllegalArgumentException("Unsafe JDK source directory");}
      var source=zip.getEntry(entry);if(source==null)return null;if(source.isDirectory()||source.getSize()<0||source.getSize()>2*1024*1024)throw new IllegalArgumentException("JDK source exceeds bounds");
      try(var in=zip.getInputStream(source)){raw=in.readNBytes(2*1024*1024+1);}var crc=new java.util.zip.CRC32();crc.update(raw);
      if(raw.length!=source.getSize()||crc.getValue()!=source.getCrc()||!java.util.Arrays.equals(raw,new String(raw,StandardCharsets.UTF_8).getBytes(StandardCharsets.UTF_8)))throw new IllegalArgumentException("JDK source bytes mismatch");
    }
    Path sourceRoot=empty.getParent().resolve("jdk-source").resolve(moduleName),sourcePath=sourceRoot.resolve(entry.substring(moduleName.length()+1));Files.createDirectories(sourcePath.getParent());Files.write(sourcePath,raw);
    DiagnosticCollector<JavaFileObject> diagnostics=new DiagnosticCollector<>();Definition definition;
    try(var manager=compiler.getStandardFileManager(diagnostics,Locale.ENGLISH,StandardCharsets.UTF_8)){
      JavacTask secondary=(JavacTask)compiler.getTask(new StringWriter(),manager,diagnostics,List.of("-source","21","-target","21","--patch-module",moduleName+"="+sourceRoot,"-proc:none","-implicit:none","-encoding","UTF-8","-classpath",empty.toString(),"-processorpath",empty.toString(),"-sourcepath",empty.toString()),null,manager.getJavaFileObjects(sourcePath));
      List<CompilationUnitTree> units=new ArrayList<>();secondary.parse().forEach(units::add);secondary.analyze();errors(diagnostics,"JDK source attribution");
      List<Hit> declarations=matched(secondary,scan(secondary,units.getFirst()),selected,task,wanted);
      if(declarations.size()!=1)throw new IllegalArgumentException("JDK source does not uniquely match binary declaration: "+wanted);
      byte[] binaryBytes;try(var in=binary.openInputStream()){binaryBytes=in.readNBytes(4*1024*1024+1);}if(binaryBytes.length>4*1024*1024)throw new IllegalArgumentException("JDK binary exceeds bounds");
      Hit hit=declarations.getFirst();definition=new Definition(-1,entry,hit.token.start,hit.token.end,hit.token.text,selected.getKind().name(),wanted,new JdkOrigin(home.toString(),moduleName,binaryName,hash(binaryBytes),archivePin,modulesPin,releasePin));
    }
    if(!archivePin.equals(pin(installedFile(home,"lib/src.zip"),64L*1024*1024))||!modulesPin.equals(pin(installedFile(home,"lib/modules"),512L*1024*1024))||!releasePin.equals(pin(installedFile(home,"release"),65536))||!java.util.Arrays.equals(raw,Files.readAllBytes(sourcePath)))throw new IllegalArgumentException("JDK source environment changed during analysis");
    return definition;
  }
  static Definition lookup(JavaCompiler compiler,StandardJavaFileManager primary,JavacTask task,Element selected,List<String> cp,List<String> attached,Path empty,boolean jdkSources)throws Exception{
    String wanted=key(selected,task.getTypes());TypeElement owner=topOwner(selected);if(owner==null||wanted==null)return null;
    Element declaring=selected;while(declaring!=null&&!(declaring instanceof TypeElement))declaring=declaring.getEnclosingElement();
    if(!(declaring instanceof TypeElement declaringType))return null;
    if(!task.getElements().getModuleOf(declaringType).isUnnamed())return jdkSources?jdk(compiler,primary,task,selected,owner,declaringType,wanted,empty):null;
    // A nested class can be loaded from a later classpath entry than its outer
    // class. Match the class declaring the selected symbol, not just its outer.
    String binaryName=task.getElements().getBinaryName(declaringType).toString();
    JavaFileObject binary=primary.getJavaFileForInput(StandardLocation.CLASS_PATH,binaryName,JavaFileObject.Kind.CLASS);if(binary==null)return null;int index=-1;
    for(int i=0;i<cp.size();i++){try(StandardJavaFileManager candidate=compiler.getStandardFileManager(null,Locale.ENGLISH,StandardCharsets.UTF_8)){
      candidate.setLocationFromPaths(StandardLocation.CLASS_PATH,List.of(Path.of(cp.get(i))));JavaFileObject found=candidate.getJavaFileForInput(StandardLocation.CLASS_PATH,binaryName,JavaFileObject.Kind.CLASS);
      if(found!=null&&found.toUri().equals(binary.toUri())){index=i;break;}
    }}
    if(index<0||attached.get(index).isEmpty())return null;
    DiagnosticCollector<JavaFileObject> sourceDiagnostics=new DiagnosticCollector<>();
    try(StandardJavaFileManager library=compiler.getStandardFileManager(sourceDiagnostics,Locale.ENGLISH,StandardCharsets.UTF_8)){
      library.setLocationFromPaths(StandardLocation.SOURCE_PATH,List.of(Path.of(attached.get(index))));
      String qualified=owner.getQualifiedName().toString(),packageName=qualified.contains(".")?qualified.substring(0,qualified.lastIndexOf('.')):"",filename=sourceFilename(binary,owner);
      var sourceObject=library.getFileForInput(StandardLocation.SOURCE_PATH,packageName,filename);if(!(sourceObject instanceof JavaFileObject input))return null;
      String classpath=cp.isEmpty()?empty.toString():String.join(java.io.File.pathSeparator,cp);
      JavacTask secondary=compiler(compiler,library,sourceDiagnostics,List.of(input),classpath,empty,empty);List<CompilationUnitTree> units=new ArrayList<>();secondary.parse().forEach(units::add);secondary.analyze();errors(sourceDiagnostics,"Attached source attribution");
      List<Hit> declarations=matched(secondary,scan(secondary,units.getFirst()),selected,task,wanted);
      if(declarations.size()!=1)throw new IllegalArgumentException("Attached source does not uniquely match binary declaration: "+wanted);
      Hit hit=declarations.getFirst();return new Definition(index,(packageName.isEmpty()?"":packageName.replace('.','/')+"/")+filename,hit.token.start,hit.token.end,hit.token.text,selected.getKind().name(),wanted,null);
    }
  }
    }
    private static int total;
    private static Path root;

    private static String json(String value) {
        StringBuilder out = new StringBuilder("\"");
        for (int index = 0; index < value.length(); index++) {
            char c = value.charAt(index);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    // Native Java stdout may use the Windows console code page.
                    if (c < 32 || c > 126) out.append(String.format("\\u%04x", (int)c));
                    else out.append(c);
                }
            }
        }
        return out.append('"').toString();
    }

    // Small lexical selector for the name portion of a javac AST range.
    // Skips string literals and comments so a symbol with the same spelling
    // inside documentation cannot become the declaration's location.
    private static List<Token> tokens(String source, int start, int end) {
        List<Token> found = new ArrayList<>();
        int i = Math.max(0, start);
        int limit = Math.min(source.length(), end);
        while (i < limit) {
            char c = source.charAt(i);
            if (c == '/' && i + 1 < limit && source.charAt(i + 1) == '/') {
                i += 2;
                while (i < limit && source.charAt(i) != '\n' && source.charAt(i) != '\r') i++;
            } else if (c == '/' && i + 1 < limit && source.charAt(i + 1) == '*') {
                i += 2;
                while (i + 1 < limit && !(source.charAt(i) == '*' && source.charAt(i + 1) == '/')) i++;
                i = Math.min(limit, i + 2);
            } else if (c == '"' || c == '\'') {
                char quote = c;
                boolean triple = c == '"' && i + 2 < limit &&
                    source.charAt(i + 1) == '"' && source.charAt(i + 2) == '"';
                i += triple ? 3 : 1;
                while (i < limit) {
                    if (source.charAt(i) == '\\') { i = Math.min(limit, i + 2); continue; }
                    if (triple && i + 2 < limit && source.charAt(i) == '"' &&
                        source.charAt(i + 1) == '"' && source.charAt(i + 2) == '"') {
                        i += 3; break;
                    }
                    if (!triple && source.charAt(i++) == quote) break;
                    if (triple) i++;
                }
            } else if (Character.isJavaIdentifierStart(source.codePointAt(i))) {
                int from = i;
                i += Character.charCount(source.codePointAt(i));
                while (i < limit && Character.isJavaIdentifierPart(source.codePointAt(i)))
                    i += Character.charCount(source.codePointAt(i));
                found.add(new Token(source.substring(from, i), from, i));
            } else {
                i++;
            }
        }
        return found;
    }

    private static Token locate(String source, int start, int end,
                                String name, boolean declaration, Tree.Kind kind) {
        if (start < 0 || end <= start || end > source.length() || name.isEmpty()) return null;
        List<Token> found = tokens(source, start, Math.min(end, start + (declaration ? 4096 : 16384)));
        if (declaration && kind == Tree.Kind.CLASS) {
            for (int i = 1; i < found.size(); i++) {
                String preceding = found.get(i - 1).value();
                if (found.get(i).value().equals(name) &&
                    List.of("class", "interface", "enum", "record").contains(preceding)) return found.get(i);
            }
        }
        if (declaration && kind == Tree.Kind.METHOD) {
            for (Token token : found) {
                if (token.value().equals(name) && source.substring(token.end(), Math.min(end,token.end()+32))
                    .stripLeading().startsWith("(")) return token;
            }
        }
        if (declaration && kind == Tree.Kind.VARIABLE) {
            for (Token token : found) if (token.value().equals(name)) return token;
        }
        if (!declaration && (kind == Tree.Kind.MEMBER_SELECT || kind == Tree.Kind.MEMBER_REFERENCE)) {
            for (int i=found.size()-1;i>=0;i--) if(found.get(i).value().equals(name))return found.get(i);
        }
        for (Token token : found) if (token.value().equals(name)) return token;
        return null;
    }

    private static final class Scanner extends TreePathScanner<Void, Void> {
        private final Trees trees;
        private final SourcePositions positions;
        private final CompilationUnitTree unit;
        private final String file;
        private final String content;

        Scanner(Trees trees, CompilationUnitTree unit, String file, String content) {
            this.trees = trees;
            this.positions = trees.getSourcePositions();
            this.unit = unit;
            this.file = file;
            this.content = content;
        }

        private void add(Tree node, String name, boolean declaration) {
            Element element = trees.getElement(getCurrentPath());
            if (element == null || name.equals("<init>") || name.isEmpty()) return;
            long from = positions.getStartPosition(unit,node);
            long to = positions.getEndPosition(unit,node);
            if (from < 0 || to <= from || to > content.length()) return;
            Token token = locate(content,(int)from,(int)to,name,declaration,node.getKind());
            if (token != null) hits.add(new Hit(file,token.start(),token.end(),name,
                element.getKind().name(),declaration,element));
        }
        @Override public Void visitClass(ClassTree node, Void ignored) {
            add(node,node.getSimpleName().toString(),true);
            return super.visitClass(node,ignored);
        }
        @Override public Void visitMethod(MethodTree node, Void ignored) {
            Element element=trees.getElement(getCurrentPath());
            String name=node.getName().toString();
            if(name.equals("<init>")&&element!=null&&element.getEnclosingElement() instanceof TypeElement owner)
                name=owner.getSimpleName().toString();
            add(node,name,true);
            return super.visitMethod(node,ignored);
        }
        @Override public Void visitNewClass(NewClassTree node, Void ignored) {
            Element element=trees.getElement(getCurrentPath());
            if(element!=null&&element.getEnclosingElement() instanceof TypeElement owner)
                add(node,owner.getSimpleName().toString(),false);
            return super.visitNewClass(node,ignored);
        }
        @Override public Void visitMemberReference(MemberReferenceTree node, Void ignored) {
            add(node,node.getName().toString(),false);
            return super.visitMemberReference(node,ignored);
        }
        @Override public Void visitVariable(VariableTree node, Void ignored) {
            add(node,node.getName().toString(),true);
            return super.visitVariable(node,ignored);
        }
        @Override public Void visitIdentifier(IdentifierTree node, Void ignored) {
            add(node,node.getName().toString(),false);
            return super.visitIdentifier(node,ignored);
        }
        @Override public Void visitMemberSelect(MemberSelectTree node, Void ignored) {
            add(node,node.getIdentifier().toString(),false);
            return super.visitMemberSelect(node,ignored);
        }
    }

    private static void emit(String file,int start,int end,String name,String kind,
                             boolean declaration,String code,String severity,String message) {
        total++;
        if(results.size()<MAX_RETURNED)
            results.add(new Result(file,start,end,name,kind,declaration,code,severity,message));
    }
    private static String relative(Path path) {
        Path resolved=path.toAbsolutePath().normalize();
        if(!resolved.startsWith(root))return null;
        return root.relativize(resolved).toString().replace('\\','/');
    }

    public static void main(String[] args) throws Exception {
        if(args.length!=6&&args.length!=7&&args.length!=8&&args.length!=9)throw new IllegalArgumentException("Expected snapshot, action, file, line, column, query, optional classpath and source attachment files");
        if(args.length==9&&!args[8].equals("jdk-sources-v1"))throw new IllegalArgumentException("Unsupported Java source protocol");
        root=Path.of(args[0]).toRealPath();
        if(!args[2].startsWith("v")||!args[5].startsWith("v"))
            throw new IllegalArgumentException("Expected encoded Java target and query");
        String action=args[1];
        String targetFile=new String(Base64.getUrlDecoder().decode(args[2].substring(1)),StandardCharsets.UTF_8);
        String query=new String(Base64.getUrlDecoder().decode(args[5].substring(1)),StandardCharsets.UTF_8);
        int line=Integer.parseInt(args[3]),column=Integer.parseInt(args[4]);
        if(Runtime.version().feature()<21)throw new IllegalStateException("Java 21+ is required");
        Path empty=root.getParent().resolve("empty-classpath");
        Files.createDirectories(empty);
        List<String> classpath=args.length>=7?Files.readAllLines(Path.of(args[6]),StandardCharsets.UTF_8).stream().filter(s->!s.isEmpty()).toList():List.of();
        List<String> attached=args.length>=8?Files.readAllLines(Path.of(args[7]),StandardCharsets.UTF_8):java.util.Collections.nCopies(classpath.size(),"");
        if(attached.size()!=classpath.size())throw new IllegalArgumentException("Source associations must match classpath order");
        String compilerClasspath=classpath.isEmpty()?empty.toString():String.join(java.io.File.pathSeparator,classpath);
        List<Path> sourceFiles;
        try(var stream=Files.walk(root)){
            sourceFiles=stream.filter(p->Files.isRegularFile(p) && p.toString().endsWith(".java"))
                .sorted(Comparator.comparing(Path::toString)).toList();
        }
        if(sourceFiles.isEmpty())throw new IllegalArgumentException("No Java sources in snapshot");
        JavaCompiler compiler=ToolProvider.getSystemJavaCompiler();
        if(compiler==null)throw new IllegalStateException("JDK compiler is required");
        DiagnosticCollector<JavaFileObject> diagnostics=new DiagnosticCollector<>();
        try(StandardJavaFileManager manager=compiler.getStandardFileManager(diagnostics,Locale.ENGLISH,StandardCharsets.UTF_8)){
            var inputs=manager.getJavaFileObjectsFromPaths(sourceFiles);
            StringWriter output=new StringWriter();
            JavacTask task=(JavacTask)compiler.getTask(output,manager,diagnostics,
                List.of("-proc:none","-implicit:none","--release","21",
                    "-encoding","UTF-8","-classpath",compilerClasspath,
                    "-processorpath",empty.toString(),
                    "-sourcepath",root.toString()),null,inputs);
            Iterable<? extends CompilationUnitTree> parsed=task.parse();
            List<CompilationUnitTree> units=new ArrayList<>();
            parsed.forEach(units::add);
            task.analyze();
            Trees trees=Trees.instance(task);
            for(CompilationUnitTree unit:units){
                String file=relative(Path.of(unit.getSourceFile().toUri()));
                if(file==null)continue;
                new Scanner(trees,unit,file,Files.readString(root.resolve(file))).scan(unit,null);
            }
            if(action.equals("diagnostics")){
                for(Diagnostic<? extends JavaFileObject> diag:diagnostics.getDiagnostics()){
                    if(diag.getSource()==null || diag.getPosition()<0)continue;
                    String file=relative(Path.of(diag.getSource().toUri()));
                    if(file==null || (!targetFile.isEmpty()&&!file.equalsIgnoreCase(targetFile)))continue;
                    String severity=diag.getKind()==Diagnostic.Kind.ERROR?"error":
                        diag.getKind()==Diagnostic.Kind.WARNING||diag.getKind()==Diagnostic.Kind.MANDATORY_WARNING?
                        "warning":"information";
                    int from=(int)diag.getStartPosition();
                    int to=(int)Math.max(from+1,diag.getEndPosition());
                    emit(file,from,to,"","diagnostic",false,diag.getCode(),severity,
                         diag.getMessage(Locale.ENGLISH));
                }
            }else if(action.equals("outline") || action.equals("symbols")){
                for(Hit hit:hits){
                    if(!hit.declaration())continue;
                    if(action.equals("outline")){
                        if(!hit.file().equalsIgnoreCase(targetFile))continue;
                        if(List.of("LOCAL_VARIABLE","PARAMETER","EXCEPTION_PARAMETER","RESOURCE_VARIABLE")
                            .contains(hit.kind()))continue;
                    }else if(!hit.name().toLowerCase(Locale.ROOT).contains(query.toLowerCase(Locale.ROOT)))continue;
                    emit(hit.file(),hit.start(),hit.end(),hit.name(),hit.kind(),true,"","","");
                }
            }else if(action.equals("definition") || action.equals("references")){
                Path requested=root.resolve(targetFile);
                String source=Files.readString(requested);
                String[] lines=source.split("\\r\\n|\\r|\\n",-1);
                if(line<1||line>lines.length || column<1||column>lines[line-1].length()+1)
                    throw new IllegalArgumentException("Java target location is outside source");
                int offset=0;
                for(int i=0;i<line-1;i++) {
                    offset+=lines[i].length();
                    char c=source.charAt(offset++);
                    if(c=='\r'&&offset<source.length()&&source.charAt(offset)=='\n')offset++;
                }
                offset+=column-1;
                final int cursor=offset;
                Hit selected=hits.stream().filter(h->h.file().equalsIgnoreCase(targetFile)
                    && h.start()<=cursor&&cursor<h.end())
                    .min(Comparator.comparingInt(h->h.end()-h.start())).orElse(null);
                if(selected!=null){
                    for(Hit hit:hits){
                        if(!hit.element().equals(selected.element()))continue;
                        if(action.equals("definition")&&!hit.declaration())continue;
                        emit(hit.file(),hit.start(),hit.end(),hit.name(),hit.kind(),
                             hit.declaration(),"","","");
                    }
                    if(action.equals("definition")&&total==0&&args.length>=8){
                        external=ExternalSource.lookup(compiler,manager,task,selected.element(),classpath,attached,empty,args.length==9);
                        if(external!=null)total++;
                    }
                }
            }else throw new IllegalArgumentException("Unsupported Java action: "+action);
        }
        StringBuilder json=new StringBuilder("{\"java_version\":").append(json(Runtime.version().toString()))
            .append(",\"total\":").append(total).append(",\"results\":[");
        for(int i=0;i<results.size();i++){
            Result item=results.get(i);
            if(i>0)json.append(',');
            json.append("{\"file\":").append(json(item.file()))
                .append(",\"start\":").append(item.start()).append(",\"end\":").append(item.end())
                .append(",\"name\":").append(json(item.name()))
                .append(",\"kind\":").append(json(item.kind()))
                .append(",\"declaration\":").append(item.declaration())
                .append(",\"code\":").append(json(item.code()))
                .append(",\"severity\":").append(json(item.severity()))
                .append(",\"message\":").append(json(item.message())).append('}');
        }
        if(external!=null){
            if(!results.isEmpty())json.append(',');
            json.append("{\"file\":\"\",\"start\":").append(external.start()).append(",\"end\":").append(external.end())
                .append(",\"name\":").append(json(external.name())).append(",\"kind\":").append(json(external.kind()))
                .append(",\"declaration\":true,\"code\":\"\",\"severity\":\"\",\"message\":\"\"")
                .append(",\"source_entry\":").append(json(external.entry())).append(",\"symbol_key\":").append(json(external.key()));
            if(external.jdk()==null)json.append(",\"source_index\":").append(external.index());
            else{var jdk=external.jdk();json.append(",\"source_jdk\":{\"home\":").append(json(jdk.home())).append(",\"module\":").append(json(jdk.module())).append(",\"binary_name\":").append(json(jdk.binaryName())).append(",\"binary_sha256\":").append(json(jdk.binarySha256()));
                for(var item:List.of(java.util.Map.entry("archive",jdk.archive()),java.util.Map.entry("modules",jdk.modules()),java.util.Map.entry("release",jdk.release())))json.append(",").append(json(item.getKey()+"_sha256")).append(':').append(json(item.getValue().sha256())).append(',').append(json(item.getKey()+"_bytes")).append(':').append(item.getValue().bytes());json.append('}');}
            json.append('}');
        }
        System.out.println(json.append("]}"));
    }
}
