import type { PendingResponse } from "./types";

/** Inline script: patch Shiny outputBindings.register before htmlwidget bindings load. */
const HTMLWIDGET_ASYNC_DEPS_PATCH = `<script id="lucent-htmlwidget-async-deps">(function(){function install(){if(!window.Shiny||!Shiny.outputBindings||!Shiny.renderDependenciesAsync)return;if(Shiny.outputBindings.__lucentAsyncDeps)return;Shiny.outputBindings.__lucentAsyncDeps=1;var reg=Shiny.outputBindings.register.bind(Shiny.outputBindings);Shiny.outputBindings.register=function(binding,name){if(binding&&binding.renderValue){var rv=binding.renderValue.bind(binding);binding.renderValue=function(el,data){if(data&&data.deps){Shiny.renderDependenciesAsync(data.deps).then(function(){rv(el,data);});return;}rv(el,data);};}return reg(binding,name);};}install();var n=0,t=setInterval(function(){install();if(++n>200)clearInterval(t);},5);})();</script>`;

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
  const bindingScript = html.match(/<script src="[^"]*-binding[^"]*"><\/script>/);
  if (bindingScript) {
    return html.replace(bindingScript[0], `${HTMLWIDGET_ASYNC_DEPS_PATCH}\n${bindingScript[0]}`);
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
