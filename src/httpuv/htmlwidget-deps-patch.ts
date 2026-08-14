import type { PendingResponse } from "./types";

/**
 * Stock htmlwidgets calls Shiny.renderDependencies() then renderValue immediately.
 * That path jQuery-appends <script> tags, which uses sync XHR (jQuery._evalUrl).
 * Chromium service workers do not intercept sync XHR, so /lib/R/** JS 404s on
 * the HTTP server. renderDependenciesAsync uses document.head.append instead.
 *
 * The patch must also wrap bindings that already registered (plotly.js is not
 * named *-binding, so injecting at </head> is too late).
 */
const HTMLWIDGET_ASYNC_DEPS_PATCH = `<script id="lucent-htmlwidget-async-deps">(function(){
function wrap(binding){
  if(!binding||!binding.renderValue||binding.__lucentAsyncDeps)return;
  binding.__lucentAsyncDeps=1;
  var rv=binding.renderValue.bind(binding);
  binding.renderValue=function(el,data){
    if(data&&data.deps){
      Shiny.renderDependenciesAsync(data.deps).then(function(){rv(el,data);});
      return;
    }
    rv(el,data);
  };
}
function install(){
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
  for(var i=0;i<list.length;i++) wrap(list[i].binding);
}
install();
var n=0,t=setInterval(function(){install();if(++n>200)clearInterval(t);},5);
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
  if (html.includes('id="lucent-htmlwidget-async-deps"')) {
    return html;
  }
  const shinyScript = html.match(/<script src="[^"]*\/shiny(?:\.min)?\.js"><\/script>/);
  if (shinyScript) {
    return html.replace(shinyScript[0], `${shinyScript[0]}\n${HTMLWIDGET_ASYNC_DEPS_PATCH}`);
  }
  if (html.includes("<head>")) {
    return html.replace("<head>", `<head>\n${HTMLWIDGET_ASYNC_DEPS_PATCH}`);
  }
  if (html.includes("</head>")) {
    return html.replace("</head>", `${HTMLWIDGET_ASYNC_DEPS_PATCH}\n</head>`);
  }
  return HTMLWIDGET_ASYNC_DEPS_PATCH + html;
}

/** Patch live R-rendered app HTML so htmlwidgets await dependency scripts. */
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
