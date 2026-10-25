import com.sun.source.tree.*;
import com.sun.source.util.*;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import javax.lang.model.SourceVersion;
import javax.lang.model.element.*;
import javax.lang.model.util.Elements;
import javax.lang.model.type.DeclaredType;
import javax.tools.*;

// Compiler-resolved, bounded rename plans. Only private source snapshots are
// compiled, with processors disabled; project code is never loaded/executed.
public class ForgeJavaRename {
    record Token(String text,int start,int end) {}
    record Hit(String file,Token token,boolean declaration,Element element,boolean imported) {}
    record StaticImport(String file,Token token,String owner,Set<Element> candidates) {}
    record Change(int start,int end,String oldText,String newText) {}
    record Model(Path root,Map<String,String> sources,List<Hit> hits,List<StaticImport> imports,Trees trees,Elements elements,List<String> errors) {}
    static final int LIMIT=300;
    static String json(String text) {
        StringBuilder b=new StringBuilder("\"");
        // Keep the protocol ASCII across Windows native stdout code pages.
        // JSON escapes also preserve surrogate pairs exactly for the JS caller.
        for(char c:text.toCharArray())switch(c){case '"'->b.append("\\\"");case '\\'->b.append("\\\\");case '\n'->b.append("\\n");case '\r'->b.append("\\r");case '\t'->b.append("\\t");default->{if(c<32||c>126)b.append(String.format("\\u%04x",(int)c));else b.append(c);}}
        return b.append('"').toString();
    }
    static String decode(String text) {if(!text.startsWith("v"))throw new IllegalArgumentException("Encoded argument required");return new String(Base64.getUrlDecoder().decode(text.substring(1)),StandardCharsets.UTF_8);}
    static String file(Path root,JavaFileObject source){Path p=Path.of(source.toUri()).toAbsolutePath().normalize();return p.startsWith(root)?root.relativize(p).toString().replace('\\','/'):null;}

    // Translation preserves original raw UTF-16 ranges, including eligible
    // Unicode escapes. Comments, strings and text blocks never yield symbols.
    static List<Token> tokens(String raw,int start,int end) {
        StringBuilder decoded=new StringBuilder();List<Integer> starts=new ArrayList<>(),ends=new ArrayList<>();int slashes=0;boolean escaped=false;
        for(int i=0;i<raw.length();){int begin=i;char c=raw.charAt(i++);boolean fromEscape=false;
            if(c=='\\'&&(escaped||slashes%2==0)&&i<raw.length()&&raw.charAt(i)=='u'){
                while(i<raw.length()&&raw.charAt(i)=='u')i++;if(i+4>raw.length())throw new IllegalArgumentException("Malformed Unicode escape");
                c=(char)Integer.parseInt(raw.substring(i,i+4),16);i+=4;fromEscape=true;
            }
            decoded.append(c);starts.add(begin);ends.add(i);slashes=c=='\\'?slashes+1:0;escaped=fromEscape;
        }
        String s=decoded.toString();List<Token> out=new ArrayList<>();int i=0;
        while(i<s.length()&&starts.get(i)<end){char c=s.charAt(i);int begin=i;
            if(c=='/'&&i+1<s.length()&&s.charAt(i+1)=='/'){i+=2;while(i<s.length()&&s.charAt(i)!='\n'&&s.charAt(i)!='\r')i++;continue;}
            if(c=='/'&&i+1<s.length()&&s.charAt(i+1)=='*'){i+=2;while(i+1<s.length()&&!(s.charAt(i)=='*'&&s.charAt(i+1)=='/'))i++;i=Math.min(s.length(),i+2);continue;}
            if(c=='"'||c=='\''){boolean triple=c=='"'&&s.startsWith("\"\"\"",i);char quote=c;i+=triple?3:1;while(i<s.length()){if(s.charAt(i)=='\\'){i=Math.min(s.length(),i+2);continue;}if(triple&&s.startsWith("\"\"\"",i)){i+=3;break;}if(!triple&&s.charAt(i)==quote){i++;break;}i++;}continue;}
            if(Character.isWhitespace(c)){i++;continue;}
            int cp=s.codePointAt(i);if(Character.isJavaIdentifierStart(cp)){i+=Character.charCount(cp);while(i<s.length()&&Character.isJavaIdentifierPart(s.codePointAt(i)))i+=Character.charCount(s.codePointAt(i));}else i++;
            if(starts.get(begin)>=start)out.add(new Token(s.substring(begin,i),starts.get(begin),ends.get(i-1)));
        }
        return out;
    }
    static Token locate(List<Token> all,int start,int end,String name,Tree tree,boolean declaration){
        int low=0,high=all.size();while(low<high){int mid=(low+high)/2;if(all.get(mid).start<start)low=mid+1;else high=mid;}int limit=low;while(limit<all.size()&&all.get(limit).end<=end)limit++;
        List<Token> ts=all.subList(low,limit);Token chosen=null;
        if(tree instanceof ClassTree){for(int i=1;i<ts.size();i++)if(ts.get(i).text.equals(name)&&Set.of("class","interface","record","enum").contains(ts.get(i-1).text))return ts.get(i);return null;}
        for(int i=0;i<ts.size();i++){Token t=ts.get(i);if(!t.text.equals(name))continue;
            if(declaration&&tree instanceof MethodTree m){if(i+1<ts.size()&&ts.get(i+1).text.equals("("))chosen=t;else if(m.getName().contentEquals("<init>")&&chosen==null)chosen=t;}
            else chosen=t;
        }return chosen;
    }
    static Model compile(Path root,String compilerClasspath)throws Exception {
        Map<String,String> sources=new TreeMap<>();try(var walk=Files.walk(root)){for(Path p:walk.filter(p->p.toString().endsWith(".java")&&Files.isRegularFile(p)).sorted().toList())sources.put(root.relativize(p).toString().replace('\\','/'),Files.readString(p));}
        JavaCompiler compiler=ToolProvider.getSystemJavaCompiler();if(compiler==null)throw new IllegalStateException("JDK compiler required");
        DiagnosticCollector<JavaFileObject> collector=new DiagnosticCollector<>();Path empty=root.getParent().resolve("empty-rename-classpath");Files.createDirectories(empty);
        List<Hit> hits=new ArrayList<>();List<StaticImport> imports=new ArrayList<>();Trees trees;Elements elements;
        try(StandardJavaFileManager manager=compiler.getStandardFileManager(collector,Locale.ENGLISH,StandardCharsets.UTF_8)){
            var inputs=manager.getJavaFileObjectsFromPaths(sources.keySet().stream().map(root::resolve).toList());
            JavacTask task=(JavacTask)compiler.getTask(new StringWriter(),manager,collector,List.of("-proc:none","-implicit:none","--release","21","-encoding","UTF-8","-classpath",compilerClasspath,"-processorpath",empty.toString(),"-sourcepath",root.toString()),null,inputs);
            List<CompilationUnitTree> units=new ArrayList<>();task.parse().forEach(units::add);task.analyze();trees=Trees.instance(task);elements=task.getElements();final Elements resolvedElements=elements;
            for(CompilationUnitTree unit:units){String f=file(root,unit.getSourceFile()),content=sources.get(f);List<Token> allTokens=tokens(content,0,content.length());SourcePositions positions=trees.getSourcePositions();final Trees resolved=trees;
                new TreePathScanner<Void,Void>(){
                    void add(Tree node,String name,boolean declaration){Element e=resolved.getElement(getCurrentPath());if(e==null||name.isEmpty())return;
                        if(e.getKind()==ElementKind.CONSTRUCTOR){e=e.getEnclosingElement();name=e.getSimpleName().toString();}
                        long start=positions.getStartPosition(unit,node),end=positions.getEndPosition(unit,node);if(start<0||end<=start||end>content.length())return;
                        if(node instanceof VariableTree v&&v.getInitializer()!=null){long initializer=positions.getStartPosition(unit,v.getInitializer());if(initializer>start)end=initializer;}
                        if(node instanceof MethodTree m){if(!m.getParameters().isEmpty()){long p=positions.getStartPosition(unit,m.getParameters().getFirst());if(p>start)end=p;}else if(m.getBody()!=null){long p=positions.getStartPosition(unit,m.getBody());if(p>start)end=p;}}
                        boolean imported=false;for(TreePath p=getCurrentPath();p!=null;p=p.getParentPath())if(p.getLeaf() instanceof ImportTree){imported=true;break;}
                        Token token=locate(allTokens,(int)start,(int)end,name,node,declaration);if(token!=null){if(hits.size()>=200000)throw new IllegalArgumentException("Java rename symbol inventory exceeds 200000");hits.add(new Hit(f,token,declaration,e,imported));}
                    }
                    @Override public Void visitImport(ImportTree n,Void v){if(n.isStatic()&&n.getQualifiedIdentifier() instanceof MemberSelectTree select&&!select.getIdentifier().contentEquals("*")){TreePath selection=new TreePath(getCurrentPath(),select);Element owner=resolved.getElement(new TreePath(selection,select.getExpression()));if(owner instanceof TypeElement type){String name=select.getIdentifier().toString();Set<Element> candidates=new HashSet<>();for(Element e:resolvedElements.getAllMembers(type))if(e.getModifiers().contains(Modifier.STATIC)&&e.getSimpleName().contentEquals(name))candidates.add(e);long start=positions.getStartPosition(unit,select),end=positions.getEndPosition(unit,select);Token token=locate(allTokens,(int)start,(int)end,name,select,false);if(token!=null&&!candidates.isEmpty())imports.add(new StaticImport(f,token,type.getQualifiedName().toString(),candidates));}}return super.visitImport(n,v);}
                    @Override public Void visitClass(ClassTree n,Void v){add(n,n.getSimpleName().toString(),true);return super.visitClass(n,v);}
                    @Override public Void visitMethod(MethodTree n,Void v){add(n,n.getName().toString(),true);return super.visitMethod(n,v);}
                    @Override public Void visitVariable(VariableTree n,Void v){add(n,n.getName().toString(),true);return super.visitVariable(n,v);}
                    @Override public Void visitIdentifier(IdentifierTree n,Void v){add(n,n.getName().toString(),false);return super.visitIdentifier(n,v);}
                    @Override public Void visitMemberSelect(MemberSelectTree n,Void v){add(n,n.getIdentifier().toString(),false);return super.visitMemberSelect(n,v);}
                    @Override public Void visitMemberReference(MemberReferenceTree n,Void v){if(n.getMode()==MemberReferenceTree.ReferenceMode.INVOKE)add(n,n.getName().toString(),false);return super.visitMemberReference(n,v);}
                }.scan(unit,null);
            }
        }
        List<String> errors=collector.getDiagnostics().stream().filter(d->d.getKind()==Diagnostic.Kind.ERROR).map(d->d.getCode()+": "+d.getMessage(Locale.ENGLISH)).toList();return new Model(root,sources,hits,imports,trees,elements,errors);
    }
    static boolean captured(Model m,Element e){TreePath path=m.trees.getPath(e);return path!=null&&file(m.root,path.getCompilationUnit().getSourceFile())!=null;}
    static boolean canonical(ExecutableElement constructor,TypeElement record){
        if(constructor.getKind()!=ElementKind.CONSTRUCTOR||constructor.getParameters().size()!=record.getRecordComponents().size())return false;
        for(int i=0;i<constructor.getParameters().size();i++)if(!constructor.getParameters().get(i).asType().toString().equals(record.getRecordComponents().get(i).asType().toString()))return false;
        return true;
    }
    static Set<Element> family(Model m,Element selected){
        Set<Element> group=new HashSet<>();group.add(selected);
        Element owner=selected.getEnclosingElement();boolean canonicalParameter=false;
        if(selected.getKind()==ElementKind.PARAMETER&&owner instanceof ExecutableElement constructor&&constructor.getEnclosingElement() instanceof TypeElement record&&record.getKind()==ElementKind.RECORD&&canonical(constructor,record)){owner=record;canonicalParameter=true;}
        if(owner instanceof TypeElement type&&type.getKind()==ElementKind.RECORD){
            String name=selected.getSimpleName().toString();RecordComponentElement component=type.getRecordComponents().stream().filter(c->c.getSimpleName().contentEquals(name)).findFirst().orElse(null);
            if(component!=null&&(canonicalParameter||selected.getKind()==ElementKind.FIELD||selected.getKind()==ElementKind.RECORD_COMPONENT||selected.equals(component.getAccessor()))){
                group.add(component);group.add(component.getAccessor());for(Element e:type.getEnclosedElements()){if(e.getKind()==ElementKind.FIELD&&e.getSimpleName().contentEquals(name))group.add(e);if(e instanceof ExecutableElement x&&e.getKind()==ElementKind.CONSTRUCTOR&&x.getParameters().size()==type.getRecordComponents().size()){boolean canonical=true;for(int i=0;i<x.getParameters().size();i++)canonical&=x.getParameters().get(i).asType().toString().equals(type.getRecordComponents().get(i).asType().toString());if(canonical)for(VariableElement p:x.getParameters())if(p.getSimpleName().contentEquals(name))group.add(p);}}
                return group;
            }
        }
        if(selected.getKind()!=ElementKind.METHOD)return group;
        Set<ExecutableElement> methods=new HashSet<>();for(Hit h:m.hits)if(h.element instanceof ExecutableElement x&&x.getKind()==ElementKind.METHOD)methods.add(x);
        boolean changed;do{changed=false;for(ExecutableElement method:methods)for(Element e:new ArrayList<>(group))if(e instanceof ExecutableElement x&&
            (m.elements.overrides(method,x,(TypeElement)method.getEnclosingElement())||m.elements.overrides(x,method,(TypeElement)x.getEnclosingElement())))changed|=group.add(method);}while(changed);
        for(Element e:group){ExecutableElement x=(ExecutableElement)e;TypeElement type=(TypeElement)x.getEnclosingElement();Set<TypeElement> seen=new HashSet<>();List<TypeElement> ancestors=new ArrayList<>();ancestors.add(type);for(int i=0;i<ancestors.size();i++){TypeElement ancestor=ancestors.get(i);if(!seen.add(ancestor))continue;if(seen.size()>256)throw new IllegalArgumentException("Java inheritance graph exceeds 256 types");for(Element member:ancestor.getEnclosedElements())if(member instanceof ExecutableElement inherited&&m.elements.overrides(x,inherited,type)&&!captured(m,inherited))throw new IllegalArgumentException("Rename would change an external override contract");if(ancestor.getSuperclass() instanceof DeclaredType parent)ancestors.add((TypeElement)parent.asElement());for(var face:ancestor.getInterfaces())if(face instanceof DeclaredType parent)ancestors.add((TypeElement)parent.asElement());}}
        return group;
    }
    static int originalOffset(int offset,List<Change> changes){int delta=0;for(Change c:changes){int begin=c.start+delta,end=begin+c.newText.length();if(offset<begin)break;if(offset<=end)return offset==end?c.end:c.start;delta+=c.newText.length()-(c.end-c.start);}return offset-delta;}
    static String key(Model m,Element element,Map<String,List<Change>> changes,Map<String,String> moved){
        TreePath path=m.trees.getPath(element);
        if(path!=null){String f=file(m.root,path.getCompilationUnit().getSourceFile());if(f!=null){String original=moved.getOrDefault(f,f);long pos=m.trees.getSourcePositions().getStartPosition(path.getCompilationUnit(),path.getLeaf());long end=m.trees.getSourcePositions().getEndPosition(path.getCompilationUnit(),path.getLeaf());
            if(pos>=0&&end>=pos)return element.getKind()+"|"+original+"|"+originalOffset((int)pos,changes.getOrDefault(original,List.of()));}}
        if(element.getEnclosingElement() instanceof TypeElement record&&record.getKind()==ElementKind.RECORD){for(int i=0;i<record.getRecordComponents().size();i++){var component=record.getRecordComponents().get(i);if(element.equals(component)||element.equals(component.getAccessor())||(element.getKind()==ElementKind.FIELD&&element.getSimpleName().contentEquals(component.getSimpleName())))return element.getKind()+"|"+key(m,record,changes,moved)+"|component:"+i;}}
        if(element.getKind()==ElementKind.PARAMETER&&element.getEnclosingElement() instanceof ExecutableElement constructor&&constructor.getKind()==ElementKind.CONSTRUCTOR&&constructor.getEnclosingElement() instanceof TypeElement record&&record.getKind()==ElementKind.RECORD){int index=constructor.getParameters().indexOf(element);return "PARAMETER|"+key(m,record,changes,moved)+"|constructor-parameter:"+index;}
        if(element instanceof QualifiedNameable q)return element.getKind()+"|"+q.getQualifiedName();
        return element.getKind()+"|"+element.getEnclosingElement()+"|"+element;
    }
    static Map<String,String> bindings(Model m,Map<String,List<Change>> changes,Map<String,String> moved){
        Map<String,String> out=new TreeMap<>();for(Hit h:m.hits){if(h.imported)continue;String f=moved.getOrDefault(h.file,h.file);List<Change> edits=changes.getOrDefault(f,List.of());String at=f+":"+originalOffset(h.token.start,edits)+":"+h.declaration;String old=out.put(at,key(m,h.element,changes,moved));if(old!=null&&!old.equals(out.get(at)))throw new IllegalArgumentException("Ambiguous compiler symbol range");}return out;
    }
    static int offset(String source,int line,int column){String[] lines=source.split("\\r\\n|\\r|\\n",-1);if(line<1||line>lines.length||column<1||column>lines[line-1].length()+1)throw new IllegalArgumentException("Java target location is outside source");int p=0;for(int i=0;i<line-1;i++){p+=lines[i].length();char c=source.charAt(p++);if(c=='\r'&&p<source.length()&&source.charAt(p)=='\n')p++;}return p+column-1;}
    public static void main(String[] args)throws Exception {
        if(args.length!=6&&args.length!=7)throw new IllegalArgumentException("Expected snapshot, action, file, line, column, new name, optional classpath file");Path root=Path.of(args[0]).toRealPath();String target=decode(args[2]),name=decode(args[5]);
        Path empty=root.getParent().resolve("empty-rename-classpath");Files.createDirectories(empty);List<String> classpath=args.length==7?Files.readAllLines(Path.of(args[6]),StandardCharsets.UTF_8).stream().filter(s->!s.isEmpty()).toList():List.of();String compilerClasspath=classpath.isEmpty()?empty.toString():String.join(java.io.File.pathSeparator,classpath);
        if(!SourceVersion.isIdentifier(name)||SourceVersion.isKeyword(name,SourceVersion.RELEASE_21))throw new IllegalArgumentException("new_name must be a valid Java non-keyword identifier");
        Model before=compile(root,compilerClasspath);if(!before.errors.isEmpty())throw new IllegalArgumentException("Java rename requires error-free captured sources: "+before.errors.getFirst());
        int position=offset(before.sources.get(target),Integer.parseInt(args[3]),Integer.parseInt(args[4]));Hit selected=before.hits.stream().filter(h->h.file.equals(target)&&h.token.start<=position&&position<h.token.end).findFirst().orElseGet(()->{StaticImport imported=before.imports.stream().filter(i->i.file.equals(target)&&i.token.start<=position&&position<i.token.end).findFirst().orElseThrow(()->new IllegalArgumentException("No compiler-resolved symbol at Java target"));if(imported.candidates.size()!=1)throw new IllegalArgumentException("Ambiguous static import; select the concrete call or declaration");return new Hit(imported.file,imported.token,false,imported.candidates.iterator().next(),true);});
        if(!captured(before,selected.element))throw new IllegalArgumentException("Read-only Java environment symbol cannot be renamed");
        if(selected.element.getSimpleName().contentEquals(name))throw new IllegalArgumentException("New Java name must differ from original");Set<Element> family=family(before,selected.element);
        List<Hit> edits=before.hits.stream().filter(h->family.contains(h.element)).sorted(Comparator.comparing(Hit::file).thenComparingInt(h->h.token.start)).toList();
        Map<String,List<Change>> changes=new TreeMap<>();for(Hit h:edits){List<Change> file=changes.computeIfAbsent(h.file,x->new ArrayList<>());if(file.stream().noneMatch(c->c.start==h.token.start))file.add(new Change(h.token.start,h.token.end,before.sources.get(h.file).substring(h.token.start,h.token.end),name));}
        for(StaticImport imported:before.imports)if(imported.candidates.stream().anyMatch(family::contains)){List<Change> file=changes.computeIfAbsent(imported.file,x->new ArrayList<>());file.removeIf(c->c.start==imported.token.start);String replacement=imported.candidates.stream().allMatch(family::contains)?name:imported.token.text+";\nimport static "+imported.owner+"."+name;file.add(new Change(imported.token.start,imported.token.end,before.sources.get(imported.file).substring(imported.token.start,imported.token.end),replacement));}
        for(List<Change> file:changes.values())file.sort(Comparator.comparingInt(Change::start));
        int count=changes.values().stream().mapToInt(List::size).sum();if(count>LIMIT)throw new IllegalArgumentException("Java rename exceeds 300 edits; no partial plan returned");
        Map<String,String> moved=new HashMap<>();String moveFrom=null,moveTo=null;
        if(selected.element instanceof TypeElement type&&type.getEnclosingElement().getKind()==ElementKind.PACKAGE&&type.getModifiers().contains(Modifier.PUBLIC)){
            Hit declaration=edits.stream().filter(Hit::declaration).findFirst().orElseThrow();moveFrom=declaration.file;String oldFile=Path.of(moveFrom).getFileName().toString();if(!oldFile.equals(type.getSimpleName()+".java"))throw new IllegalArgumentException("Public Java type filename is inconsistent");moveTo=(Path.of(moveFrom).getParent()==null?Path.of(name+".java"):Path.of(moveFrom).getParent().resolve(name+".java")).toString().replace('\\','/');
            if(before.sources.containsKey(moveTo))throw new IllegalArgumentException("Java rename destination already exists");moved.put(moveTo,moveFrom);
        }
        Path candidate=root.getParent().resolve("rename-candidate");Files.createDirectories(candidate);
        for(var entry:before.sources.entrySet()){String content=entry.getValue();List<Change> file=changes.getOrDefault(entry.getKey(),List.of());for(int i=file.size()-1;i>=0;i--){Change c=file.get(i);content=content.substring(0,c.start)+c.newText+content.substring(c.end);}String destination=entry.getKey().equals(moveFrom)?moveTo:entry.getKey();Path p=candidate.resolve(destination);Files.createDirectories(p.getParent());Files.writeString(p,content);}
        Model after=compile(candidate,compilerClasspath);if(!after.errors.isEmpty())throw new IllegalArgumentException("Java rename introduces a compiler error: "+after.errors.getFirst());
        Map<String,String> original=bindings(before,Map.of(),Map.of()),renamed=bindings(after,changes,moved);if(!original.equals(renamed)){Set<String> keys=new TreeSet<>(original.keySet());keys.addAll(renamed.keySet());String mismatch=keys.stream().filter(k->!Objects.equals(original.get(k),renamed.get(k))).findFirst().orElse("unknown");throw new IllegalArgumentException("Java rename changes a resolved symbol binding; no partial plan returned at "+mismatch+" ("+original.get(mismatch)+" -> "+renamed.get(mismatch)+")");}
        StringBuilder out=new StringBuilder("{\"java_version\":").append(json(Runtime.version().toString())).append(",\"total\":").append(count).append(",\"results\":[");int emitted=0;
        for(var entry:changes.entrySet())for(Change c:entry.getValue()){Hit h=edits.stream().filter(hit->hit.file.equals(entry.getKey())&&hit.token.start==c.start).findFirst().orElse(null);if(emitted++>0)out.append(',');out.append("{\"file\":").append(json(entry.getKey())).append(",\"start\":").append(c.start).append(",\"end\":").append(c.end).append(",\"name\":").append(json(selected.token.text)).append(",\"kind\":").append(json(h==null?"STATIC_IMPORT":h.element.getKind().name())).append(",\"declaration\":").append(h!=null&&h.declaration).append(",\"new_text\":").append(json(c.newText)).append(",\"code\":\"\",\"severity\":\"\",\"message\":\"\"}");}
        out.append("],\"file_moves\":[");if(moveFrom!=null)out.append("{\"from\":").append(json(moveFrom)).append(",\"to\":").append(json(moveTo)).append('}');System.out.println(out.append("]}"));
    }
}
