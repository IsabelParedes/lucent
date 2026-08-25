import type { PendingResponse } from "./types";

/** Bump when the injected app-document script changes (invalidates SW HTML cache). */
const LUCENT_PATCH_VERSION = "htmlwidget-async-v2";

/**
 * Chromium SW does not intercept sync XHR (jQuery._evalUrl). When widgets load
 * deps via async <script> tags, cache the bodies so a later sync _evalUrl can
 * still eval them. Also prefer Shiny.renderDependenciesAsync over sync loads.
 */
const HTMLWIDGET_ASYNC_DEPS_PATCH = `<script id="lucent-htmlwidget-async-deps">(function(){
window.__lucentEvalCache=window.__lucentEvalCache||{};
function cacheScript(url,text){
  try{
    var abs=new URL(url,document.baseURI).href;
    window.__lucentEvalCache[abs]=text;
    window.__lucentEvalCache[url]=text;
  }catch(e){}
}
(function(){
  var ofetch=window.fetch;
  if(!ofetch)return;
  var oAppend=Element.prototype.appendChild;
  Element.prototype.appendChild=function(node){
    if(node&&node.tagName==='SCRIPT'&&node.src){
      var src=node.src;
      ofetch(src).then(function(r){return r.ok?r.text():null;}).then(function(t){if(t)cacheScript(src,t);}).catch(function(){});
    }
    return oAppend.apply(this,arguments);
  };
})();
function installEvalUrlPatch(){
  if(!window.jQuery||!jQuery._evalUrl||jQuery._evalUrl.__lucentPatched)return;
  var orig=jQuery._evalUrl;
  jQuery._evalUrl=function(url,options,doc){
    var abs;
    try{abs=new URL(url,document.baseURI).href;}catch(e){abs=url;}
    var cached=window.__lucentEvalCache[abs]||window.__lucentEvalCache[url];
    if(typeof cached==='string'){
      jQuery.globalEval(cached,options,doc);
      return {status:200,responseText:cached};
    }
    return orig.apply(this,arguments);
  };
  jQuery._evalUrl.__lucentPatched=1;
}
function wrap(binding){
  if(!binding||!binding.renderValue||binding.__lucentAsyncDeps)return;
  binding.__lucentAsyncDeps=1;
  try{
    if(binding.renderValue.constructor&&binding.renderValue.constructor.name==='AsyncFunction')return;
  }catch(e){}
  var rv=binding.renderValue.bind(binding);
  binding.renderValue=function(el,data){
    if(data&&data.x!=null&&data.deps&&data.deps.length){
      return Shiny.renderDependenciesAsync(data.deps).then(function(){return rv(el,data);});
    }
    return rv(el,data);
  };
}
function installBindingWrap(){
  if(!window.Shiny||!Shiny.outputBindings||!Shiny.renderDependenciesAsync)return;
  if(!Shiny.outputBindings.__lucentAsyncDepsReg){
    Shiny.outputBindings.__lucentAsyncDepsReg=1;
    var reg=Shiny.outputBindings.register.bind(Shiny.outputBindings);
    Shiny.outputBindings.register=function(binding,name){
      wrap(binding);
      return reg(binding,name);
    };
  }
  var list=Shiny.outputBindings.getBindings?Shiny.outputBindings.getBindings():[];
  for(var i=0;i<list.length;i++){
    wrap(list[i].binding||list[i]);
  }
}
function install(){
  installEvalUrlPatch();
  installBindingWrap();
}
install();
var n=0,t=setInterval(function(){install();if(++n>400)clearInterval(t);},5);
})();</script>`;

function responseBodyToText(body: PendingResponse["body"]): string | null {
  if (body == null) {
    return null;
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body);
  }
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(body);
  }
  return null;
}

function isHtmlContentType(headers: Record<string, string> | undefined): boolean {
  if (!headers) {
    return false;
  }
  const ct = headers["content-type"] ?? headers["Content-Type"] ?? "";
  return ct.includes("text/html");
}

export function injectHtmlwidgetAsyncDepsPatch(html: string): string {
  let out = html.replace(/<script id="lucent-htmlwidget-async-deps"[\s\S]*?<\/script>\s*/g, "");
  const patch = HTMLWIDGET_ASYNC_DEPS_PATCH.replace(
    'id="lucent-htmlwidget-async-deps"',
    `id="lucent-htmlwidget-async-deps" data-lucent-patch="${LUCENT_PATCH_VERSION}"`,
  );
  const shinyScript = out.match(/<script src="[^"]*\/shiny(?:\.min)?\.js"><\/script>/);
  if (shinyScript) {
    return out.replace(shinyScript[0], `${shinyScript[0]}\n${patch}`);
  }
  if (out.includes("<head>")) {
    return out.replace("<head>", `<head>\n${patch}`);
  }
  if (out.includes("</head>")) {
    return out.replace("</head>", `${patch}\n</head>`);
  }
  return patch + out;
}

export function maybePatchAppDocumentResponse(
  resp: PendingResponse,
  url: string,
  method: string,
  isAppDocument: (url: string) => boolean,
): PendingResponse {
  if (method !== "GET" || resp.status !== 200 || !isAppDocument(url) || !isHtmlContentType(resp.headers)) {
    return resp;
  }
  const html = responseBodyToText(resp.body);
  if (!html || !html.includes("htmlwidgets")) {
    return resp;
  }
  const patched = injectHtmlwidgetAsyncDepsPatch(html);
  if (patched === html) {
    return resp;
  }
  return {
    status: resp.status,
    headers: resp.headers,
    body: patched,
  };
}
