import type { Metafile } from "esbuild";

export declare function bundleElectron(
  sourceDirectory: string,
  outputDirectory: string,
): Promise<{
  metafile: Metafile;
}>;
