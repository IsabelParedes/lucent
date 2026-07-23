/**
 * Types for the Rmain Emscripten module (initR / evalR come from r-main --post-js).
 */

export interface RMainModule {
  ccall: (
    ident: string,
    returnType: string | null,
    argTypes: string[],
    args: unknown[],
  ) => unknown;
  stackAlloc: (size: number) => number;
  stringToUTF8OnStack: (str: string) => number;
  setValue: (ptr: number, value: number, type: string) => void;
  thisProgram?: string;
  initR: (args?: string[]) => number;
  evalR: (code: string) => unknown;
}
