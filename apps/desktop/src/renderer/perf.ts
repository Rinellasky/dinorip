export interface DinoripPerfCounters {
  workspaceRenders: number;
  sourceWorkspaceRenders: number;
  atlasWorkspaceRenders: number;
  texturePreviewBuilds: number;
  texturePreviewBuildMs: number;
  texturePreviewJobs: number;
  texturePreviewJobMs: number;
  syncExtractions: number;
  syncExtractionMs: number;
  asyncCommits: number;
  asyncCommitMs: number;
  staleExtractionsSkipped: number;
}

const counters: DinoripPerfCounters = {
  workspaceRenders: 0,
  sourceWorkspaceRenders: 0,
  atlasWorkspaceRenders: 0,
  texturePreviewBuilds: 0,
  texturePreviewBuildMs: 0,
  texturePreviewJobs: 0,
  texturePreviewJobMs: 0,
  syncExtractions: 0,
  syncExtractionMs: 0,
  asyncCommits: 0,
  asyncCommitMs: 0,
  staleExtractionsSkipped: 0
};

export function resetPerfCounters(): void {
  for (const key of Object.keys(counters) as Array<keyof DinoripPerfCounters>) {
    counters[key] = 0;
  }
}

export function perfSnapshot(): DinoripPerfCounters {
  return { ...counters };
}

export function recordWorkspaceRender(kind: "source" | "atlas"): void {
  counters.workspaceRenders += 1;
  if (kind === "source") counters.sourceWorkspaceRenders += 1;
  else counters.atlasWorkspaceRenders += 1;
}

export function recordTexturePreviewBuild(durationMs: number): void {
  counters.texturePreviewBuilds += 1;
  counters.texturePreviewBuildMs += durationMs;
}

export function recordTexturePreviewJob(durationMs: number): void {
  counters.texturePreviewJobs += 1;
  counters.texturePreviewJobMs += durationMs;
}

export function recordSyncExtraction(durationMs: number): void {
  counters.syncExtractions += 1;
  counters.syncExtractionMs += durationMs;
}

export function recordAsyncCommit(durationMs: number): void {
  counters.asyncCommits += 1;
  counters.asyncCommitMs += durationMs;
}

export function recordStaleExtractionSkipped(): void {
  counters.staleExtractionsSkipped += 1;
}

if (typeof window !== "undefined") {
  window.__dinoripPerf = {
    reset: resetPerfCounters,
    snapshot: perfSnapshot
  };
}
