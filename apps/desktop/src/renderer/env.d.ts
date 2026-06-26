import type { DinoripApi } from "@dinorip/ipc-contracts";
import type { PixelImage } from "@dinorip/core";
import type { DinoripBenchmarkApi } from "./benchmark";
import type { DinoripPerfCounters } from "./perf";

declare global {
  interface Window {
    dinorip: DinoripApi;
    __dinoripPerf?: {
      reset(): void;
      snapshot(): DinoripPerfCounters;
    };
    __dinoripBenchmark?: DinoripBenchmarkApi;
    __dinoripDev?: {
      loadBenchmarkSource(name: string, image: PixelImage): void;
      resetBenchmarkWorkspace(): void;
    };
  }
}

export {};
