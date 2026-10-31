export type KernelActivitySnapshot = {
  leasedJobs: Array<{ id: string; kind: string }>;
  lastWriteAt: string | null;
};

export interface KernelActivityPort {
  snapshot(): KernelActivitySnapshot;
}
