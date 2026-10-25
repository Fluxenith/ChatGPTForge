using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Collections.Generic;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Rename;
using Microsoft.CodeAnalysis.Text;

// AdhocWorkspace accepts only the coordinator's private input. No MSBuild,
// analyzer, source generator or project assembly is loaded as executable code.
public static class ForgeCSharpAnalyze
{
 public sealed record Source(string file,string content);
 public sealed record Options(string language_version,string nullable,string output_kind,bool allow_unsafe,string[] defines);
 public sealed record ProjectSpec(string name,string assembly_name,string[] files,Options options,string[] project_references,string[] global_usings);
 public sealed record Input(string protocol,string action,string file,int line,int column,string query,string new_name,string[] references,Source[] sources,Options options,ProjectSpec[]? projects=null);
 public sealed record Result(string file,int start,int end,string name,string kind,bool declaration,string code="",string message="",string severity="",bool read_only=false,string assembly="");
 public sealed record Replacement(int start,int length,string old_text,string new_text);
 public sealed record Edit(string file,Replacement[] replacements);
 public sealed record Hit(string file,SyntaxToken token,ISymbol symbol,bool declaration);
 static ISymbol Canonical(ISymbol s)=>s is IMethodSymbol m&&m.ReducedFrom!=null?m.ReducedFrom.OriginalDefinition:s.OriginalDefinition;
 static SyntaxToken? Declaration(SyntaxNode node)=>node switch
 {
  BaseTypeDeclarationSyntax n=>n.Identifier,DelegateDeclarationSyntax n=>n.Identifier,
  MethodDeclarationSyntax n=>n.Identifier,ConstructorDeclarationSyntax n=>n.Identifier,
  DestructorDeclarationSyntax n=>n.Identifier,PropertyDeclarationSyntax n=>n.Identifier,
  EventDeclarationSyntax n=>n.Identifier,VariableDeclaratorSyntax n=>n.Identifier,
  ParameterSyntax n=>n.Identifier,TypeParameterSyntax n=>n.Identifier,
  EnumMemberDeclarationSyntax n=>n.Identifier,LocalFunctionStatementSyntax n=>n.Identifier,
  SingleVariableDesignationSyntax n=>n.Identifier,UsingDirectiveSyntax n=>n.Alias?.Name.Identifier,
  _=>null
 };
 const string Generated="forge-generated:";
 static List<Hit> Scan(Compilation compilation)
 {
  var hits=new List<Hit>();
  foreach(var tree in compilation.SyntaxTrees){if(tree.FilePath.StartsWith(Generated,StringComparison.Ordinal))continue;var model=compilation.GetSemanticModel(tree);
   foreach(var node in tree.GetRoot().DescendantNodesAndSelf()){
    var token=Declaration(node);if(token==null)continue;
    var symbol=model.GetDeclaredSymbol(node);if(symbol==null&&node is UsingDirectiveSyntax u&&u.Alias!=null)symbol=model.GetDeclaredSymbol(u);
    if(symbol!=null)hits.Add(new Hit(tree.FilePath,token.Value,Canonical(symbol),true));
   }
  }return hits;
 }
 static Result Record(Hit hit)=>new Result(hit.file,hit.token.SpanStart,hit.token.Span.End,hit.token.ValueText,hit.symbol.Kind.ToString(),hit.declaration);
 static int Offset(Source source,int line,int column){var text=SourceText.From(source.content);
  if(line<1||line>text.Lines.Count||column<1||column>text.Lines[line-1].Span.Length)throw new ArgumentException("C# target position is outside captured source");
  var offset=text.Lines[line-1].Start+column-1;
  if(offset>0&&char.IsLowSurrogate(source.content[offset])&&char.IsHighSurrogate(source.content[offset-1]))throw new ArgumentException("C# position is inside a surrogate pair");
  return offset;
 }
 static NullableContextOptions Nullable(string value)=>value switch {"enable"=>NullableContextOptions.Enable,"disable"=>NullableContextOptions.Disable,"warnings"=>NullableContextOptions.Warnings,"annotations"=>NullableContextOptions.Annotations,_=>throw new ArgumentException("Invalid nullable option")};
 static OutputKind Output(string value)=>value switch {"library"=>OutputKind.DynamicallyLinkedLibrary,"exe"=>OutputKind.ConsoleApplication,"winexe"=>OutputKind.WindowsApplication,_=>throw new ArgumentException("Invalid output kind")};
 public static async Task<int> Main(string[] args){try{await Run(args);return 0;}catch(Exception e){Console.Error.WriteLine(JsonSerializer.Serialize(new{error=e.Message}));return 1;}}
 static (CSharpParseOptions,CSharpCompilationOptions) Compile(Options options,string? assembly){
  if(!LanguageVersionFacts.TryParse(options.language_version,out var language)||language>LanguageVersion.CSharp14||language==LanguageVersion.Preview)throw new ArgumentException("Unsupported C# language version");
  return (new CSharpParseOptions(language,preprocessorSymbols:options.defines),new CSharpCompilationOptions(Output(options.output_kind),moduleName:assembly==null?null:assembly+".dll",allowUnsafe:options.allow_unsafe,nullableContextOptions:Nullable(options.nullable)));
 }
 static async Task Run(string[] args)
 {
  if(args.Length!=1)throw new ArgumentException("Expected one private request file");
  var input=JsonSerializer.Deserialize<Input>(File.ReadAllText(args[0]))??throw new ArgumentException("Missing request");
  if((input.protocol!="csharp-workspaces-v1"||input.projects!=null)&&(input.protocol!="csharp-workspaces-v2"||input.projects==null||input.projects.Length is 0 or >32))throw new ArgumentException("Invalid C# protocol");
  if(input.sources.Length>2048||input.references.Length>512||input.sources.Sum(s=>Encoding.UTF8.GetByteCount(s.content))>32*1024*1024)throw new ArgumentException("Invalid C# protocol or input bounds");
  if(typeof(Workspace).Assembly.GetName().Version!.ToString()!="5.9.0.0"||typeof(CSharpCompilation).Assembly.GetName().Version!.ToString()!="5.9.0.0"||Environment.Version.ToString()!="10.0.13")throw new ArgumentException("Pinned C# toolchain version mismatch");
   using var workspace=new AdhocWorkspace();
  var specs=input.projects??new[]{new ProjectSpec("ForgePrivateSnapshot","ForgePrivateSnapshot",input.sources.Select(s=>s.file).ToArray(),input.options,Array.Empty<string>(),Array.Empty<string>())};
  var bySource=input.sources.ToDictionary(s=>s.file,StringComparer.Ordinal);var documents=new Dictionary<string,DocumentId>(StringComparer.Ordinal);
  var ids=specs.ToDictionary(p=>p.name,p=>ProjectId.CreateNewId(p.name),StringComparer.Ordinal);var metadata=input.references.Select(p=>(MetadataReference)MetadataReference.CreateFromFile(p)).ToArray();
  var solution=workspace.CurrentSolution;
  foreach(var spec in specs){var (parse,options)=Compile(spec.options,input.projects==null?null:spec.assembly_name);
   solution=solution.AddProject(ProjectInfo.Create(ids[spec.name],VersionStamp.Default,spec.name,spec.assembly_name,LanguageNames.CSharp,parseOptions:parse,compilationOptions:options,metadataReferences:metadata));
   foreach(var file in spec.files){var source=bySource[file];var id=DocumentId.CreateNewId(ids[spec.name]);solution=solution.AddDocument(id,Path.GetFileName(file),SourceText.From(source.content,Encoding.UTF8),filePath:file);documents.Add(file,id);}
   if(spec.global_usings.Length>0)solution=solution.AddDocument(DocumentId.CreateNewId(ids[spec.name]),"GlobalUsings.g.cs",SourceText.From(string.Concat(spec.global_usings.Select(u=>"global using global::"+u+";\n")),Encoding.UTF8),filePath:Generated+spec.name+"/GlobalUsings.g.cs");
  }
  foreach(var spec in specs)foreach(var reference in spec.project_references)solution=solution.AddProjectReference(ids[spec.name],new ProjectReference(ids[reference]));
  if(documents.Count!=input.sources.Length)throw new ArgumentException("Every C# source must belong to exactly one project");
  var language=((CSharpParseOptions)solution.GetProject(ids[specs[0].name])!.ParseOptions!).LanguageVersion;
  var compilations=new Dictionary<ProjectId,Compilation>();foreach(var p in solution.Projects)compilations[p.Id]=(await p.GetCompilationAsync())!;
  var project=input.file is {Length:>0}&&documents.ContainsKey(input.file)?solution.GetDocument(documents[input.file])!.Project:solution.GetProject(ids[specs[0].name])!;
  var hits=compilations.Values.SelectMany(Scan).ToList();var results=new List<Result>();var edits=new List<Edit>();object? rename=null;
  var diagnostics=compilations.Values.SelectMany(c=>c.GetDiagnostics()).ToArray();
  if(input.action=="diagnostics"){
   foreach(var d in diagnostics){
    if(d.Location.IsInSource&&d.Location.SourceTree!.FilePath.StartsWith(Generated,StringComparison.Ordinal))continue;
    if(!d.Location.IsInSource){if(string.IsNullOrEmpty(input.file))results.Add(new Result("",0,0,"",d.Id,false,d.Id,d.GetMessage(),d.Severity.ToString().ToLowerInvariant()));continue;}
    if(!string.IsNullOrEmpty(input.file)&&d.Location.SourceTree!.FilePath!=input.file)continue;
    results.Add(new Result(d.Location.SourceTree!.FilePath,d.Location.SourceSpan.Start,d.Location.SourceSpan.End,"",d.Id,false,d.Id,d.GetMessage(),d.Severity.ToString().ToLowerInvariant()));
   }
  }else if(input.action is "outline" or "symbols"){
   foreach(var hit in hits.Where(h=>input.action=="outline"?h.file==input.file&&h.symbol.Kind is not SymbolKind.Parameter and not SymbolKind.Local and not SymbolKind.TypeParameter:h.token.ValueText.Contains(input.query,StringComparison.OrdinalIgnoreCase)))results.Add(Record(hit));
  }else if(input.action is "definition" or "references" or "rename_preview"){
   var source=input.sources.Single(s=>s.file==input.file);var offset=Offset(source,input.line,input.column);var document=project.GetDocument(documents[input.file])!;
   var tree=(await document.GetSyntaxTreeAsync())!;var node=tree.GetRoot().FindToken(offset).Parent;var model=(await document.GetSemanticModelAsync())!;
   ISymbol? symbol=null;
   if(node is IdentifierNameSyntax identifier)symbol=model.GetAliasInfo(identifier);
   symbol??=await SymbolFinder.FindSymbolAtPositionAsync(document,offset,CancellationToken.None);
   if(symbol!=null){symbol=Canonical(symbol);
    if(input.action=="rename_preview"){
     if(!SyntaxFacts.IsValidIdentifier(input.new_name)||SyntaxFacts.GetKeywordKind(input.new_name)!=SyntaxKind.None||input.new_name.StartsWith("@",StringComparison.Ordinal))throw new ArgumentException("New C# name must be a non-keyword identifier");
     if(!symbol.Locations.Any(l=>l.IsInSource)||symbol.IsImplicitlyDeclared)throw new ArgumentException("Read-only or synthesized C# symbol cannot be renamed");
     if(symbol is IMethodSymbol constructor&&constructor.MethodKind is MethodKind.Constructor or MethodKind.StaticConstructor or MethodKind.Destructor)symbol=constructor.ContainingType;
     if(diagnostics.Any(d=>d.Severity==DiagnosticSeverity.Error))throw new ArgumentException("C# rename requires error-free captured sources");
     // Renamer follows override/interface/partial families and inserts syntax to
     // preserve binding when a new name collides. It does not rename strings,
     // comments, overloads or filenames. Uncaptured external contracts are refused.
     if(symbol is IMethodSymbol method){for(var m=method.OverriddenMethod;m!=null;m=m.OverriddenMethod)if(!m.Locations.Any(l=>l.IsInSource))throw new ArgumentException("Read-only external override contract");}
     if(symbol is IPropertySymbol property){for(var p=property.OverriddenProperty;p!=null;p=p.OverriddenProperty)if(!p.Locations.Any(l=>l.IsInSource))throw new ArgumentException("Read-only external override contract");}
     if(symbol.ContainingType!=null)foreach(var contract in symbol.ContainingType.AllInterfaces)foreach(var member in contract.GetMembers())
      if(SymbolEqualityComparer.Default.Equals(Canonical(symbol.ContainingType.FindImplementationForInterfaceMember(member)??member),Canonical(symbol))&&!member.Locations.Any(l=>l.IsInSource))throw new ArgumentException("Read-only external interface contract");
     var updated=await Renamer.RenameSymbolAsync(solution,symbol,new SymbolRenameOptions(false,false,false,false),input.new_name,CancellationToken.None);
     foreach(var candidate in updated.Projects){var errors=(await candidate.GetCompilationAsync())!.GetDiagnostics().Where(d=>d.Severity==DiagnosticSeverity.Error).ToArray();
      if(errors.Length>0)throw new ArgumentException("C# rename candidate has compiler errors: "+string.Join("; ",errors.Take(5).Select(d=>d.ToString())));}
     foreach(var original in solution.Projects.SelectMany(p=>p.Documents)){var changed=updated.GetDocument(original.Id)!;var before=(await original.GetTextAsync()).ToString();var changes=await changed.GetTextChangesAsync(original);
      var replacements=changes.OrderByDescending(c=>c.Span.Start).Select(c=>new Replacement(c.Span.Start,c.Span.Length,before.Substring(c.Span.Start,c.Span.Length),c.NewText??"")).ToArray();
      if(replacements.Length>0){if(changed.FilePath!=original.FilePath||original.FilePath!.StartsWith(Generated,StringComparison.Ordinal))throw new ArgumentException("Unexpected C# rename of a generated or moved file");edits.Add(new Edit(original.FilePath!,replacements));}
     }
     if(edits.Sum(e=>e.replacements.Length)>300)throw new ArgumentException("C# rename exceeds 300 edits; no partial plan returned");
     rename=new{can_rename=edits.Count>0,display_name=symbol.Name};
    }else if(input.action=="definition"){
     foreach(var hit in hits.Where(h=>SymbolEqualityComparer.Default.Equals(h.symbol,symbol)))results.Add(Record(hit));
     if(results.Count==0&&!symbol.Locations.Any(l=>l.IsInSource))results.Add(new Result("csharp-metadata:"+symbol.ToDisplayString(),0,0,symbol.Name,symbol.Kind.ToString(),true,read_only:true,assembly:symbol.ContainingAssembly?.Identity.ToString()??""));
    }else{
     var references=await SymbolFinder.FindReferencesAsync(symbol,solution,CancellationToken.None);
     foreach(var group in references){var definition=Canonical(group.Definition);
      foreach(var hit in hits.Where(h=>SymbolEqualityComparer.Default.Equals(h.symbol,definition)))results.Add(Record(hit));
      foreach(var reference in group.Locations.Where(l=>!l.Document.FilePath!.StartsWith(Generated,StringComparison.Ordinal))){var span=reference.Location.SourceSpan;var file=reference.Document.FilePath!;var text=input.sources.Single(s=>s.file==file).content;results.Add(new Result(file,span.Start,span.End,text.Substring(span.Start,span.Length),definition.Kind.ToString(),false));}
     }
    }
   }else if(input.action=="rename_preview")rename=new{can_rename=false,reason="No uniquely resolved C# symbol at this position"};
  }else throw new ArgumentException("Unknown C# action");
  results=results.DistinctBy(r=>(r.file,r.start,r.end,r.declaration,r.code,r.message)).ToList();
  Console.WriteLine(JsonSerializer.Serialize(new{protocol=input.protocol,compiler_version=typeof(CSharpCompilation).Assembly.GetName().Version!.ToString(),runtime_version=Environment.Version.ToString(),language_version=language.ToDisplayString(),total=results.Count,results=results.Take(300),rename,edits}));
 }
}
