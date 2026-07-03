/**
 * Inject evalR into the Emscripten R glue (must run inside the glue IIFE so
 * resolveGlobalSymbol / stackAlloc are in scope). Uses libR.so symbols after
 * side modules are preloaded — not httpuv.
 */
export function injectRWasmEvalGlue(glue: string): string {
  const patch = `Module["loadDynamicLibraryAsync"]=(name)=>loadDynamicLibrary(name,{loadAsync:true,global:true,nodelete:true,allowUndefined:true});
function shinyForgeResolveR(symName){
  var resolved=resolveGlobalSymbol(symName).sym;
  if(!resolved){throw new Error("R symbol not available: "+symName)}
  return resolved;
}
function shinyForgeRData(symName){
  var sym=shinyForgeResolveR(symName);
  if(typeof sym==="function"){sym=sym()}
  if(sym&&typeof sym==="object"&&"value"in sym){return sym.value}
  return getValue(sym,"i32");
}
function shinyForgeGlobalEnv(){
  var env=shinyForgeRData("R_GlobalEnv");
  var TYPEOF=shinyForgeResolveR("TYPEOF");
  if(TYPEOF(env)!==4){
    throw new Error("R_GlobalEnv is not an environment (typeof="+TYPEOF(env)+")");
  }
  return env;
}
function shinyForgeCallMain(args=[]){
  var entryFunction=resolveGlobalSymbol("main").sym;
  if(!entryFunction)return;
  args.unshift(thisProgram);
  var argc=args.length;
  var argv=stackAlloc((argc+1)*4);
  var argv_ptr=argv;
  args.forEach(function(arg){HEAPU32[argv_ptr>>2]=stringToUTF8OnStack(arg);argv_ptr+=4});
  HEAPU32[argv_ptr>>2]=0;
  try{return entryFunction(argc,argv)}catch(e){return handleException(e)}
}
Module.evalR=function(code){
  var Rf_allocVector=shinyForgeResolveR("Rf_allocVector");
  var SET_STRING_ELT=shinyForgeResolveR("SET_STRING_ELT");
  var Rf_mkCharCE=shinyForgeResolveR("Rf_mkCharCE");
  var R_ParseVector=shinyForgeResolveR("R_ParseVector");
  var Rf_length=shinyForgeResolveR("Rf_length");
  var VECTOR_ELT=shinyForgeResolveR("VECTOR_ELT");
  var Rf_eval=shinyForgeResolveR("Rf_eval");
  var R_tryEval=shinyForgeResolveR("R_tryEval");
  var Rf_protect=shinyForgeResolveR("Rf_protect");
  var Rf_unprotect=shinyForgeResolveR("Rf_unprotect");
  var Rf_asChar=shinyForgeResolveR("Rf_asChar");
  var env=shinyForgeGlobalEnv();
  var nil=shinyForgeRData("R_NilValue");
  var STRSXP=16;
  var PARSE_OK=1;
  var CE_UTF8=1;
  var charsxp=Rf_mkCharCE(stringToUTF8OnStack(code),CE_UTF8);
  var srcVec=Rf_allocVector(STRSXP,1);
  SET_STRING_ELT(srcVec,0,charsxp);
  var statusPtr=stackAlloc(4);
  setValue(statusPtr,0,"i32");
  var parsed=Rf_protect(R_ParseVector(srcVec,-1,statusPtr,nil));
  var status=getValue(statusPtr,"i32");
  if(status!==PARSE_OK){
    Rf_unprotect(1);
    throw new Error("R parse error (status "+status+")");
  }
  var n=Rf_length(parsed);
  var result=nil;
  var errorOccurredPtr=stackAlloc(4);
  for(var i=0;i<n;i++){
    setValue(errorOccurredPtr,0,"i32");
    result=R_tryEval(VECTOR_ELT(parsed,i),env,errorOccurredPtr);
    if(getValue(errorOccurredPtr,"i32")){
      var errMsg="R evaluation error";
      try{
        var errChars=Rf_asChar(result);
        if(errChars){
          errMsg=UTF8ToString(errChars);
        }
      }catch(e){}
      Rf_unprotect(1);
      throw new Error(errMsg);
    }
  }
  Rf_unprotect(1);
  return result;
};
Module["callMain"]=shinyForgeCallMain;`;

  return glue.replace('Module["callMain"]=callMain;', patch);
}
